import type { EkmanError, TelemetryEvent } from "../src/index";
import { Ekman } from "../src/index";
import type { ScenarioClock } from "./build";
import {
  buildClock,
  buildEntities,
  ScenarioAudit,
  ScenarioStorage,
} from "./build";
import type {
  ForgetExpectation,
  HistoryExpectation,
  MapExpectation,
  QueryExpectation,
  Scenario,
  SendExpectation,
  Step,
} from "./scenario";
import {
  isAdvanceStep,
  isDrainStep,
  isForgetStep,
  isRestartStep,
  isSendStep,
  isSweepStep,
  isWaitStep,
  isWellFormedStep,
  telemetryTypes,
} from "./scenario";

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly status: "passed" | "failed";
  readonly failures: readonly string[];
}

/**
 * Type matchers for values a scenario cannot pin down. A scenario writes `"$number"`
 * where a real but non-deterministic number is expected.
 */
const TYPE_MATCHERS = {
  $number: (value: unknown) =>
    typeof value === "number" && !Number.isNaN(value),
  $string: (value: unknown) => typeof value === "string",
  $any: (value: unknown) => value !== undefined,
} as const;

interface Outcome {
  outcome: "committed" | "rejected";
  state?: string;
  seq?: number;
  values?: Record<string, unknown>;
  code?: string;
}

interface ForgetOutcome {
  outcome: "ok" | "refused";
  code?: string;
}

/** What one run of the `when` steps produced, by step kind. */
interface Outcomes {
  sends: Outcome[];
  forgets: ForgetOutcome[];
}

/** Every assertion a scenario may make. A key outside this set asserts nothing, so it is refused. */
const THEN_KEYS: ReadonlySet<string> = new Set([
  "sends",
  "forgets",
  "events",
  "telemetry",
  "telemetryAbsent",
  "state",
  "resident",
  "memory",
  "audit",
  "queries",
  "maps",
  "history",
  "buildError",
]);

/**
 * The fields a query or a map expectation may carry. Checked for the same reason as the
 * keys above: a misspelt `includeValues` would otherwise ask a different question and
 * assert nothing about the one that was meant.
 */
const ENTRY_KEYS = {
  queries: new Set([
    "entity",
    "state",
    "olderThan",
    "staleFor",
    "limit",
    "includeValues",
    "keys",
    "values",
    "complete",
    "reasons",
  ]),
  maps: new Set([
    "entity",
    "limitPerState",
    "byState",
    "total",
    "complete",
    "reasons",
  ]),
} as const;

const TELEMETRY_TYPES = telemetryTypes();

/**
 * Refuse a scenario the runner would otherwise misread.
 *
 * Thrown rather than reported as a failure. A misspelled assertion or step is a defect in
 * the suite, and reporting it against the implementation would send someone looking for
 * a bug that is not there.
 */
function assertWellFormed(scenario: Scenario): void {
  for (const key of Object.keys(scenario.then ?? {})) {
    if (!THEN_KEYS.has(key)) {
      throw new Error(`scenario ${scenario.id}: unknown then key "${key}"`);
    }
  }

  for (const [where, known] of Object.entries(ENTRY_KEYS)) {
    (scenario.then?.[where as keyof typeof ENTRY_KEYS] ?? []).forEach(
      (entry, i) => {
        for (const key of Object.keys(entry)) {
          if (!known.has(key)) {
            throw new Error(
              `scenario ${scenario.id}: unknown key "${key}" in then.${where}[${i}]`
            );
          }
        }
      }
    );
  }

  for (const step of scenario.when ?? []) {
    if (!isWellFormedStep(step)) {
      throw new Error(
        `scenario ${scenario.id}: unknown step ${JSON.stringify(step)}, ` +
          "expected exactly one of send, drain, wait, advance, sweep, restart or forget"
      );
    }
  }

  for (const where of ["telemetry", "telemetryAbsent"] as const) {
    (scenario.then?.[where] ?? []).forEach((matcher, i) => {
      if (!TELEMETRY_TYPES.has(matcher.type as string)) {
        throw new Error(
          `scenario ${scenario.id}: then.${where}[${i}] names no known telemetry event ` +
            `(type ${JSON.stringify(matcher.type)})`
        );
      }
    });
  }
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  assertWellFormed(scenario);

  const failures: string[] = [];

  try {
    await execute(scenario, failures);
  } catch (error) {
    failures.push(
      `threw outside the scenario: ${(error as Error).stack ?? String(error)}`
    );
  }

  return {
    scenario,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  };
}

async function execute(scenario: Scenario, failures: string[]): Promise<void> {
  const expectBuildError = scenario.then?.buildError;

  // A scenario may assert that its own `given` is invalid and must be refused at build
  // time, before any trigger is sent.
  if (expectBuildError !== undefined) {
    // Built with its storage, because a refusal is often about what the stores can and
    // cannot promise, and a runtime built without them would be refused for the wrong
    // reason or not at all.
    const storage = new ScenarioStorage(scenario.given.runtime?.store);
    try {
      buildRuntime(scenario, [], undefined, storage);
      failures.push(
        `expected building to fail with ${expectBuildError.code}, but it succeeded`
      );
    } catch (error) {
      // Whatever was thrown, which need not be an EkmanError. The cast is how `code` gets
      // read at all, so its type says string where the value can be undefined.
      const code: string | undefined = (error as EkmanError).code;
      if (code !== expectBuildError.code) {
        failures.push(
          `expected build error ${expectBuildError.code}, got ${code ?? "a non-Ekman error"}: ${(error as Error).message}`
        );
      }
    } finally {
      storage.cleanup();
    }
    return;
  }

  const telemetry: TelemetryEvent[] = [];
  const clock = buildClock(scenario.given);
  const storage = new ScenarioStorage(scenario.given.runtime?.store);
  const audit = new ScenarioAudit(scenario.given.runtime?.audit);

  // Held in a box because a restart step replaces it, and every assertion afterwards has
  // to be made against the runtime that is actually running.
  const active = {
    ekman: buildRuntime(scenario, telemetry, clock, storage, audit),
  };

  try {
    const outcomes = await deliver(active, scenario.when ?? [], clock, () =>
      buildRuntime(scenario, telemetry, clock, storage, audit)
    );

    await auditSettled();
    assertSends(scenario.then?.sends, outcomes.sends, failures);
    assertForgets(scenario.then?.forgets, outcomes.forgets, failures);
    await assertEvents(scenario, active.ekman, failures);
    assertTelemetry(scenario.then?.telemetry, telemetry, failures);
    assertTelemetryAbsent(scenario.then?.telemetryAbsent, telemetry, failures);
    await assertState(scenario, storage, active.ekman, failures);
    assertResident(scenario.then?.resident, active.ekman, failures);
    assertMemory(scenario.then?.memory, active.ekman, failures);
    assertAudit(scenario.then?.audit, audit, failures);
    await assertQueries(scenario.then?.queries, active.ekman, failures);
    await assertMaps(scenario.then?.maps, active.ekman, failures);
    await assertHistory(scenario.then?.history, active.ekman, failures);
  } finally {
    // A scenario that configured an automatic sweep leaves an interval behind otherwise,
    // and a durable one leaves a directory.
    await active.ekman.close();
    storage.cleanup();
  }
}

function buildRuntime(
  scenario: Scenario,
  telemetry: TelemetryEvent[],
  clock?: ScenarioClock,
  storage?: ScenarioStorage,
  audit?: ScenarioAudit
): Ekman {
  const { inbox, execution, temporal, memory, coordination } =
    scenario.given.runtime ?? {};

  return new Ekman({
    entities: buildEntities(scenario.given),
    ...(clock === undefined ? {} : { now: clock.now }),
    ...(inbox === undefined ? {} : { inbox }),
    ...(execution === undefined ? {} : { execution }),
    ...(temporal === undefined ? {} : { temporal }),
    ...(memory === undefined ? {} : { memory }),
    ...(coordination === undefined ? {} : { coordination }),
    ...(storage?.configured === true ? { store: storage.build() } : {}),
    ...(audit === undefined || audit.sinks.length === 0
      ? {}
      : { audit: audit.sinks }),
    // Capture everything. A scenario asserts a subsequence of what lands here.
    telemetry: { "*": (event) => telemetry.push(event) },
    // A scenario asserts on outcomes, so a stray post() failure must not print noise.
    onUnhandled: () => undefined,
  });
}

async function deliver(
  active: { ekman: Ekman },
  steps: readonly Step[],
  clock: ScenarioClock | undefined,
  rebuild: () => Ekman
): Promise<Outcomes> {
  const outcomes: Outcome[] = [];
  const forgets: ForgetOutcome[] = [];
  const inFlight: Promise<void>[] = [];
  let index = 0;

  for (const step of steps) {
    const { ekman } = active;

    if (isRestartStep(step)) {
      // Everything outstanding settles first, then the runtime is thrown away. What
      // survives is whatever reached a durable store, which is the entire claim.
      // The old runtime is shut down before the new one opens the same storage.
      // biome-ignore lint/performance/noAwaitInLoops: steps are ordered by definition, and a restart is a barrier across all of them
      await Promise.all([...inFlight, ekman.close()]);
      active.ekman = rebuild();
      continue;
    }

    if (isWaitStep(step)) {
      await new Promise((done) => setTimeout(done, step.wait));
      continue;
    }

    if (isAdvanceStep(step)) {
      if (clock === undefined) {
        throw new Error(
          "an advance step needs a declared clock: add given.runtime.clock"
        );
      }
      clock.advance(step.advance);
      continue;
    }

    if (isSweepStep(step)) {
      // Resolves once every escalation it raised has been processed, so the assertions
      // that follow see the finished picture.
      await ekman.sweep();
      continue;
    }

    if (isForgetStep(step)) {
      // Deliberately not drained first. A forget is refused while the key is busy, and
      // draining here would make that outcome unreachable. A scenario that wants the key
      // quiet first says so with a `drain` step, exactly as it would before a send.
      forgets.push(await forgetting(ekman, step.forget.key));
      continue;
    }

    if (isDrainStep(step)) {
      await Promise.all(inFlight);
      continue;
    }

    // Every other kind was handled above, and a scenario is checked for unknown steps
    // before it runs, so this only narrows the type.
    if (!isSendStep(step)) {
      continue;
    }

    const slot = index;
    index += 1;

    const settled = ekman.send(step.send.key, step.send.trigger).then(
      (result) => {
        outcomes[slot] = {
          outcome: "committed",
          state: result.state,
          seq: result.seq,
          values: result.values as Record<string, unknown>,
        };
      },
      (error: EkmanError) => {
        outcomes[slot] = { outcome: "rejected", code: error.code };
      }
    );

    inFlight.push(settled);

    // `await: false` leaves the send in flight so a later step can overlap it.
    if (step.await !== false) {
      await settled;
    }
  }

  await Promise.all(inFlight);
  return { sends: outcomes, forgets };
}

/**
 * Let audit deliveries that the steps set in motion finish before anything is asserted.
 *
 * A sink is never called inside a commit, so a delivery is still pending when the send that
 * caused it resolves. One turn of the event loop is enough for the sinks a scenario can
 * declare, which deliver or refuse without waiting on anything.
 */
function auditSettled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Delete a key, recording whether it was allowed rather than letting a refusal throw. */
async function forgetting(ekman: Ekman, key: string): Promise<ForgetOutcome> {
  try {
    await ekman.forget(key);
    return { outcome: "ok" };
  } catch (error) {
    return { outcome: "refused", code: (error as EkmanError).code };
  }
}

function assertSends(
  expected: readonly SendExpectation[] | undefined,
  actual: readonly Outcome[],
  failures: string[]
): void {
  if (expected === undefined) {
    return;
  }

  if (expected.length !== actual.length) {
    failures.push(
      `then.sends expects ${expected.length} send steps, scenario ran ${actual.length}`
    );
    return;
  }

  expected.forEach((want, i) => {
    const got = actual[i];
    if (got === undefined) {
      failures.push(`sends[${i}]: no outcome recorded`);
      return;
    }

    if (want.outcome !== got.outcome) {
      failures.push(
        `sends[${i}]: expected ${want.outcome}, got ${got.outcome}${got.code === undefined ? "" : ` (${got.code})`}`
      );
      return;
    }

    for (const field of ["state", "seq", "code"] as const) {
      if (want[field] !== undefined && want[field] !== got[field]) {
        failures.push(
          `sends[${i}].${field}: expected ${String(want[field])}, got ${String(got[field])}`
        );
      }
    }

    if (want.values !== undefined) {
      failures.push(...diff(`sends[${i}].values`, got.values, want.values));
    }
  });
}

function assertForgets(
  expected: readonly ForgetExpectation[] | undefined,
  actual: readonly ForgetOutcome[],
  failures: string[]
): void {
  if (expected === undefined) {
    return;
  }

  if (expected.length !== actual.length) {
    failures.push(
      `then.forgets expects ${expected.length} forget steps, scenario ran ${actual.length}`
    );
    return;
  }

  expected.forEach((want, i) => {
    const got = actual[i];
    if (got === undefined) {
      failures.push(`forgets[${i}]: no outcome recorded`);
      return;
    }

    if (want.outcome !== got.outcome) {
      failures.push(
        `forgets[${i}]: expected ${want.outcome}, got ${got.outcome}${got.code === undefined ? "" : ` (${got.code})`}`
      );
      return;
    }

    if (want.code !== undefined && want.code !== got.code) {
      failures.push(
        `forgets[${i}].code: expected ${want.code}, got ${String(got.code)}`
      );
    }
  });
}

async function assertEvents(
  scenario: Scenario,
  ekman: Ekman,
  failures: string[]
): Promise<void> {
  const expected = scenario.then?.events;
  if (expected === undefined) {
    return;
  }

  // `at` is only deterministic when the scenario declares a clock.
  const ignore =
    scenario.given.runtime?.clock === undefined
      ? new Set(["at"])
      : new Set<string>();

  for (const [key, wantEvents] of Object.entries(expected)) {
    // biome-ignore lint/performance/noAwaitInLoops: one key at a time keeps the failure messages in scenario order
    const { events: gotEvents } = await ekman.history(key);

    if (wantEvents.length !== gotEvents.length) {
      failures.push(
        `events["${key}"]: expected ${wantEvents.length} events, got ${gotEvents.length} ` +
          `(${gotEvents.map(describeEvent).join(", ")})`
      );
      continue;
    }

    wantEvents.forEach((want, i) => {
      failures.push(
        ...diff(
          `events["${key}"][${i}]`,
          gotEvents[i] as unknown as Record<string, unknown>,
          want,
          ignore
        )
      );
    });
  }
}

/**
 * Assert the expected telemetry appears, in order, somewhere in what was emitted.
 *
 * A subsequence rather than an exact list. Telemetry is a firehose, and a scenario about
 * one dropped trigger should not have to enumerate every enqueue around it. Order between
 * the matchers is still asserted, so "started before settled" remains provable.
 */
function assertTelemetry(
  expected: readonly Record<string, unknown>[] | undefined,
  actual: readonly TelemetryEvent[],
  failures: string[]
): void {
  if (expected === undefined) {
    return;
  }

  let cursor = 0;

  expected.forEach((want, i) => {
    const found = actual.findIndex(
      (event, at) =>
        at >= cursor &&
        diff("", event as unknown as Record<string, unknown>, want).length === 0
    );

    if (found === -1) {
      // The cursor stays put, so a later matcher is still searched for from here rather
      // than cascading one missing event into a failure for every matcher after it.
      failures.push(
        `telemetry[${i}]: no ${describeMatcher(want)} found after the previous match ` +
          `(emitted: ${actual.map((event) => event.type).join(", ") || "nothing"})`
      );
      return;
    }

    cursor = found + 1;
  });
}

/** Assert that none of the listed matchers matches anything that was emitted. */
function assertTelemetryAbsent(
  unwanted: readonly Record<string, unknown>[] | undefined,
  actual: readonly TelemetryEvent[],
  failures: string[]
): void {
  if (unwanted === undefined) {
    return;
  }

  unwanted.forEach((matcher, i) => {
    const found = actual.findIndex(
      (event) =>
        diff("", event as unknown as Record<string, unknown>, matcher)
          .length === 0
    );

    if (found !== -1) {
      failures.push(
        `telemetryAbsent[${i}]: found ${describeMatcher(matcher)} at position ${found} of what was emitted`
      );
    }
  });
}

function describeMatcher(want: Record<string, unknown>): string {
  const type = typeof want.type === "string" ? want.type : "event";
  return `${type} matching ${JSON.stringify(want)}`;
}

/** What `then.state` compares against, wherever it was read from. */
interface CommittedState {
  readonly state: string;
  readonly seq: number;
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * The committed state of a key, from memory when it is resident and through the store
 * when it is not.
 *
 * Without the second half, `null` would only ever mean "not in memory", and a key that
 * survived a restart would be indistinguishable from one that was deleted.
 */
function committedState(
  storage: ScenarioStorage,
  ekman: Ekman,
  key: string
): Promise<CommittedState | undefined> {
  const resident = ekman.inspect(key);
  return resident === undefined
    ? storage.committed(key)
    : Promise.resolve(resident);
}

async function assertState(
  scenario: Scenario,
  storage: ScenarioStorage,
  ekman: Ekman,
  failures: string[]
): Promise<void> {
  const expected = scenario.then?.state;
  if (expected === undefined) {
    return;
  }

  for (const [key, want] of Object.entries(expected)) {
    // biome-ignore lint/performance/noAwaitInLoops: one key at a time keeps failures in scenario order
    const got = await committedState(storage, ekman, key);

    if (want === null) {
      if (got !== undefined) {
        failures.push(
          `state["${key}"]: expected no instance, got ${got.state}`
        );
      }
      continue;
    }

    if (got === undefined) {
      failures.push(`state["${key}"]: expected an instance, found none`);
      continue;
    }

    if (want.state !== undefined && want.state !== got.state) {
      failures.push(
        `state["${key}"].state: expected ${want.state}, got ${got.state}`
      );
    }
    if (want.seq !== undefined && want.seq !== got.seq) {
      failures.push(
        `state["${key}"].seq: expected ${want.seq}, got ${got.seq}`
      );
    }
    if (want.values !== undefined) {
      failures.push(...diff(`state["${key}"].values`, got.values, want.values));
    }
  }
}

/**
 * Which keys are still in memory.
 *
 * The pairing with `then.state` is what proves a reload is transparent: a key asserted
 * absent here and present there was read back through the store without the assertion
 * having to know it happened.
 */
function assertResident(
  expected: readonly string[] | undefined,
  ekman: Ekman,
  failures: string[]
): void {
  if (expected === undefined) {
    return;
  }

  const got = [...ekman.residentKeys].sort();
  const want = [...expected].sort();

  if (got.join(",") !== want.join(",")) {
    failures.push(
      `resident: expected [${want.join(", ")}], got [${got.join(", ")}]`
    );
  }
}

function assertMemory(
  expected: { instances?: number; withinBytes?: number } | undefined,
  ekman: Ekman,
  failures: string[]
): void {
  if (expected === undefined) {
    return;
  }

  const usage = ekman.memoryUsage;

  if (
    expected.instances !== undefined &&
    usage.instances !== expected.instances
  ) {
    failures.push(
      `memory.instances: expected ${expected.instances}, got ${usage.instances}`
    );
  }

  if (
    expected.withinBytes !== undefined &&
    usage.bytes > expected.withinBytes
  ) {
    failures.push(
      `memory.withinBytes: expected at most ${expected.withinBytes} resident bytes, got ${usage.bytes}`
    );
  }
}

function assertAudit(
  expected: Readonly<Record<string, readonly string[]>> | undefined,
  audit: ScenarioAudit,
  failures: string[]
): void {
  if (expected === undefined) {
    return;
  }

  for (const [sink, want] of Object.entries(expected)) {
    const got = audit.received.get(sink);

    if (got === undefined) {
      failures.push(`audit["${sink}"]: no such sink is configured`);
      continue;
    }
    if (got.join(",") !== want.join(",")) {
      failures.push(
        `audit["${sink}"]: expected [${want.join(", ")}], got [${got.join(", ")}]`
      );
    }
  }
}

async function assertQueries(
  expected: readonly QueryExpectation[] | undefined,
  ekman: Ekman,
  failures: string[]
): Promise<void> {
  if (expected === undefined) {
    return;
  }

  for (const [i, want] of expected.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one query at a time keeps failures in scenario order
    const got = await ekman.query({
      entity: want.entity,
      ...(want.state === undefined ? {} : { state: want.state }),
      ...(want.olderThan === undefined ? {} : { olderThan: want.olderThan }),
      ...(want.staleFor === undefined ? {} : { staleFor: want.staleFor }),
      ...(want.limit === undefined ? {} : { limit: want.limit }),
      ...(want.includeValues === undefined
        ? {}
        : { includeValues: want.includeValues }),
    });

    const keys = got.instances.map((instance) => instance.key);
    if (keys.join(",") !== want.keys.join(",")) {
      failures.push(
        `queries[${i}].keys: expected [${want.keys.join(", ")}], got [${keys.join(", ")}]`
      );
    }

    assertCarriedValues(`queries[${i}]`, want, got.instances, failures);
    assertPartiality(`queries[${i}]`, want, got, failures);
  }
}

/**
 * Values are carried only when asked for, and that half is asserted on every query. The
 * ones a scenario names are then compared as subsets, by key.
 */
function assertCarriedValues(
  path: string,
  want: QueryExpectation,
  instances: readonly { key: string; values?: unknown }[],
  failures: string[]
): void {
  if (want.includeValues !== true) {
    for (const instance of instances) {
      if (instance.values !== undefined) {
        failures.push(
          `${path}.values["${instance.key}"]: carried values without includeValues`
        );
      }
    }
  }

  const carried = new Map(
    instances.map((instance) => [instance.key, instance.values])
  );
  for (const [key, values] of Object.entries(want.values ?? {})) {
    failures.push(
      ...diff(`${path}.values["${key}"]`, carried.get(key), values)
    );
  }
}

async function assertMaps(
  expected: readonly MapExpectation[] | undefined,
  ekman: Ekman,
  failures: string[]
): Promise<void> {
  if (expected === undefined) {
    return;
  }

  for (const [i, want] of expected.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one map at a time keeps failures in scenario order
    const got = await ekman.map(
      want.entity,
      want.limitPerState === undefined
        ? {}
        : { limitPerState: want.limitPerState }
    );

    // States are compared as a set, since their order means nothing. Each state's keys
    // are an exact list, in order.
    const states = new Set([
      ...Object.keys(want.byState),
      ...Object.keys(got.byState),
    ]);
    for (const state of [...states].sort()) {
      failures.push(
        ...diffKeys(
          `maps[${i}].byState["${state}"]`,
          Object.hasOwn(got.byState, state)
            ? got.byState[state]?.keys
            : undefined,
          Object.hasOwn(want.byState, state) ? want.byState[state] : undefined
        )
      );
    }

    if (want.total !== undefined && want.total !== got.total) {
      failures.push(
        `maps[${i}].total: expected ${want.total}, got ${got.total}`
      );
    }

    assertPartiality(`maps[${i}]`, want, got, failures);
  }
}

/**
 * Compare one state's keys with the keys expected of it.
 *
 * A state being there at all is part of the answer, apart from what it lists: under a
 * limit of zero every state lists nothing, and one that is missing would otherwise read
 * the same as one that is present. Keys are compared one by one and never as joined text.
 */
function diffKeys(
  path: string,
  got: readonly string[] | undefined,
  want: readonly string[] | undefined
): string[] {
  const show = (keys: readonly string[]) => `[${keys.join(", ")}]`;
  if (want === undefined) {
    return [`${path}: expected no such state, got ${show(got ?? [])}`];
  }
  if (got === undefined) {
    return [`${path}: expected ${show(want)}, got no such state`];
  }
  const same =
    got.length === want.length && got.every((key, at) => key === want[at]);
  return same ? [] : [`${path}: expected ${show(want)}, got ${show(got)}`];
}

/** Whether an answer said it was whole, and why not, with the reasons compared as a set. */
function assertPartiality(
  path: string,
  want: { complete?: boolean; reasons?: readonly string[] },
  got: { complete: boolean; reasons: readonly string[] },
  failures: string[]
): void {
  if (want.complete !== undefined && want.complete !== got.complete) {
    failures.push(
      `${path}.complete: expected ${want.complete}, got ${got.complete}`
    );
  }

  if (want.reasons !== undefined) {
    const sorted = [...got.reasons].sort().join(",");
    if (sorted !== [...want.reasons].sort().join(",")) {
      failures.push(
        `${path}.reasons: expected [${want.reasons.join(", ")}], got [${got.reasons.join(", ")}]`
      );
    }
  }
}

async function assertHistory(
  expected: Readonly<Record<string, HistoryExpectation>> | undefined,
  ekman: Ekman,
  failures: string[]
): Promise<void> {
  if (expected === undefined) {
    return;
  }

  for (const [key, want] of Object.entries(expected)) {
    // biome-ignore lint/performance/noAwaitInLoops: one key at a time keeps failures in scenario order
    const got = await ekman.history(key);

    if (want.events !== undefined) {
      const summary = got.events.map((event) => `${event.type}@${event.seq}`);
      if (summary.join(",") !== want.events.join(",")) {
        failures.push(
          `history["${key}"].events: expected [${want.events.join(", ")}], got [${summary.join(", ")}]`
        );
      }
    }

    if (want.complete !== undefined && want.complete !== got.complete) {
      failures.push(
        `history["${key}"].complete: expected ${want.complete}, got ${got.complete}`
      );
    }

    if (want.reasons !== undefined) {
      const sorted = [...got.reasons].sort().join(",");
      if (sorted !== [...want.reasons].sort().join(",")) {
        failures.push(
          `history["${key}"].reasons: expected [${want.reasons.join(", ")}], got [${got.reasons.join(", ")}]`
        );
      }
    }
  }
}

/**
 * Compare `want` against `got` as a subset: only the fields the scenario names are
 * asserted, so scenarios stay narrow and do not break when an event gains a field.
 *
 * The one exception is an empty object, which means exactly empty. Read as a subset it
 * would name no fields and match anything, so "starts with no values" would assert nothing.
 */
function diff(
  path: string,
  got: unknown,
  want: unknown,
  ignore: ReadonlySet<string> = new Set()
): string[] {
  // Some values are real but not deterministic: a handler's duration is the obvious one.
  // Asserting the shape is the most a scenario can honestly say about them.
  if (typeof want === "string" && want in TYPE_MATCHERS) {
    const matcher = TYPE_MATCHERS[want as keyof typeof TYPE_MATCHERS];
    return matcher(got) ? [] : [`${path}: expected ${want}, got ${json(got)}`];
  }

  if (want === null || typeof want !== "object") {
    return Object.is(got, want)
      ? []
      : [`${path}: expected ${json(want)}, got ${json(got)}`];
  }

  if (Array.isArray(want)) {
    if (!Array.isArray(got)) {
      return [`${path}: expected an array, got ${json(got)}`];
    }
    if (got.length !== want.length) {
      return [`${path}: expected ${want.length} items, got ${got.length}`];
    }
    return want.flatMap((item, i) =>
      diff(`${path}[${i}]`, got[i], item, ignore)
    );
  }

  if (typeof got !== "object" || got === null || Array.isArray(got)) {
    return [`${path}: expected an object, got ${json(got)}`];
  }

  if (Object.keys(want).length === 0) {
    const extra = Object.keys(got);
    return extra.length === 0
      ? []
      : [`${path}: expected an empty object, got keys ${extra.join(", ")}`];
  }

  return Object.entries(want as Record<string, unknown>)
    .filter(([field]) => !ignore.has(field))
    .flatMap(([field, value]) =>
      diff(
        `${path}.${field}`,
        (got as Record<string, unknown>)[field],
        value,
        ignore
      )
    );
}

function describeEvent(event: { type: string; seq: number }): string {
  return `${event.type}@${event.seq}`;
}

function json(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}
