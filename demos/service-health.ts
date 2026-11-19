/**
 * Service health: memory about things you watch, and state that follows from it.
 *
 * Run with `npm run demo:service-health`.
 *
 * A service that depends on forty others ends up remembering things about them: how the
 * last few probes went, how slow the last one was, when it last heard anything at all.
 * Written by hand, that memory is a map in one module and a counter in another, and the
 * code that turns it into "is this thing healthy" is a threshold comparison repeated in
 * every place a probe is recorded, plus a timer somebody has to remember to start.
 *
 * Here the memory is each instance's values, and the handlers only record. A probe arrives
 * and the handler says what it learned. Deciding that three failures in a row means
 * `degraded` is a rule. Deciding that a minute of silence means `unreachable` is a
 * freshness bound. Neither one changes anything: each delivers a trigger proposing a state,
 * through the normal inbox, and the handler agrees or does not.
 *
 * Then one call answers the question the whole thing exists for: where is everything.
 *
 * The clock is injected, so a minute takes no time at all.
 */

import type { RuleTrigger, StaleTrigger } from "ekman";
import { defineEntity, Ekman, patch, stay, transitionTo } from "ekman";
import { banner, check, row, stream } from "./lib";

const SECOND = 1000;
const FAILURES_BEFORE_DEGRADED = 3;
const QUIET_BEFORE_UNREACHABLE = 60 * SECOND;

type State = "healthy" | "degraded" | "unreachable";

interface Known extends Record<string, unknown> {
  /** Failed probes in a row. */
  failures: number;
  latencyMs: number;
  lastError: string;
  /** Set by hand for one service, to show a handler declining a proposal. */
  pinned: boolean;
}

interface Probe {
  type: "probe";
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * What a service can be sent. The two proposals are in the union because the entity
 * declares a rule and a freshness bound, which is what types `propose` as a state.
 */
type ServiceTrigger =
  | Probe
  | { type: "pin" }
  | RuleTrigger<State>
  | StaleTrigger<State>;

const nothingKnown: Known = {
  failures: 0,
  latencyMs: 0,
  lastError: "",
  pinned: false,
};

/** Advanced by hand. Nothing here waits on a real timer. */
let clock = Date.UTC(2026, 0, 1, 12, 0, 0);

/** What one probe teaches. The same in every state, and it names only what changed. */
const learned = (service: { values: Known }, probe: Probe) =>
  probe.ok
    ? { failures: 0, latencyMs: probe.latencyMs }
    : {
        failures: service.values.failures + 1,
        latencyMs: probe.latencyMs,
        lastError: probe.error ?? "probe failed",
      };

const services = defineEntity.withTriggers<ServiceTrigger>()("services", {
  initial: "healthy",
  values: nothingKnown,
  states: {
    healthy: (service, trigger) => {
      if (trigger.type === "probe") {
        return patch(learned(service, trigger));
      }
      if (trigger.type === "pin") {
        return patch({ pinned: true });
      }
      // A proposal, from the rule or from the freshness bound. It carries the state it
      // asks for, and this is the one place that decides whether to go there.
      return service.values.pinned
        ? stay()
        : transitionTo(trigger.propose ?? "degraded", service.values);
    },
    degraded: (service, trigger) => {
      if (trigger.type === "probe") {
        return trigger.ok
          ? transitionTo("healthy", {
              ...service.values,
              ...learned(service, trigger),
            })
          : patch(learned(service, trigger));
      }
      if (trigger.type === "pin") {
        return stay();
      }
      return transitionTo(trigger.propose ?? "unreachable", service.values);
    },
    unreachable: (service, trigger) =>
      trigger.type === "probe"
        ? transitionTo("healthy", {
            ...service.values,
            ...learned(service, trigger),
          })
        : stay(),
  },
  constraints: {
    rules: [
      {
        name: "too-many-failures",
        in: "healthy",
        when: (service) =>
          service.values.failures >= FAILURES_BEFORE_DEGRADED &&
          `${service.values.failures} failed probes in a row`,
        propose: "degraded",
      },
    ],
    stale: [
      {
        name: "gone-quiet",
        after: QUIET_BEFORE_UNREACHABLE,
        propose: "unreachable",
      },
    ],
  },
});

const STEADY = Array.from({ length: 34 }, (_, i) => `svc-${i + 1}`);
const FAILING = ["payments-api", "ledger-api", "fraud-api"];
const SILENT = ["recs-api", "search-api"];
const PINNED = "legacy-batch";

async function main(): Promise<void> {
  const ekman = new Ekman({ entities: [services], now: () => clock });
  const handle = ekman.entities.services;
  const everything = [...STEADY, ...FAILING, ...SILENT, PINNED];
  const ok: Probe = { type: "probe", ok: true, latencyMs: 20 };
  const bad: Probe = {
    type: "probe",
    ok: false,
    latencyMs: 1400,
    error: "upstream timed out",
  };

  /** One round of probes. A service that is not probed simply hears nothing. */
  const round = async (probes: ReadonlyMap<string, Probe>) => {
    for (const [name, probe] of probes) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential so each key's stream reads in the order it was probed
      await handle.send(name, probe);
    }
  };
  const all = (names: readonly string[], probe: Probe) =>
    new Map(names.map((name) => [name, probe]));

  banner("1. Record what is observed");

  await handle.send(PINNED, { type: "pin" });
  await round(all(everything, ok));
  row("services", everything.length);
  row("fields remembered", 3, "failures, latencyMs, lastError");

  const before = await ekman.map("services");
  row(
    "healthy",
    before.byState.healthy?.count ?? 0,
    "one round of clean probes"
  );
  check(
    before.total === everything.length &&
      before.byState.healthy?.count === everything.length,
    "not every service started healthy"
  );

  banner("2. A rule proposes, the handler decides");

  // Three services start failing, and so does the pinned one. Four rounds, because a
  // proposal is queued behind the commit that raised it: the fourth probe waits for it.
  for (let i = 0; i < FAILURES_BEFORE_DEGRADED + 1; i += 1) {
    clock += 10 * SECOND;
    // biome-ignore lint/performance/noAwaitInLoops: rounds happen one after another, as they would on a timer
    await round(
      new Map([
        ...all([...STEADY, ...SILENT], ok),
        ...all([...FAILING, PINNED], bad),
      ])
    );
  }

  console.log(
    `  rules: [{ in: "healthy", when: failures >= ${FAILURES_BEFORE_DEGRADED}, propose: "degraded" }]\n`
  );
  for (const name of [...FAILING, PINNED]) {
    const now = handle.inspect(name);
    console.log(
      `    ${name.padEnd(14)} ${String(now?.state).padEnd(10)} failures ${now?.values.failures}  "${now?.values.lastError}"`
    );
  }

  check(
    FAILING.every((name) => handle.inspect(name)?.state === "degraded"),
    "a service with three failed probes in a row was not moved"
  );
  check(
    handle.inspect(PINNED)?.state === "healthy",
    "the handler that declined the proposal was moved anyway"
  );

  const { events: pinned } = await handle.history(PINNED);
  const proposals = pinned.filter(
    (event) => event.type === "violation" && event.constraint.kind === "rule"
  );
  console.log("");
  row(
    "proposals to the pinned one",
    proposals.length,
    `over ${FAILURES_BEFORE_DEGRADED + 1} failing rounds`
  );
  check(
    proposals.length === 1,
    `the rule proposed ${proposals.length} times while its condition went on holding`
  );
  console.log(
    "\n  It was asked once. The condition has held since the third failure, and a rule fires\n" +
      "  when its condition comes to hold, not on every commit while it does."
  );

  banner("3. Silence is a fact too");

  // Two services stop being probed. Nothing arrives to say so, which is the point.
  for (let i = 0; i < 7; i += 1) {
    clock += 10 * SECOND;
    // biome-ignore lint/performance/noAwaitInLoops: rounds happen one after another, as they would on a timer
    await round(
      new Map([...all(STEADY, ok), ...all([...FAILING, PINNED], bad)])
    );
  }

  const quiet = await handle.query({ staleFor: "1m" });
  console.log('  query({ staleFor: "1m" })\n');
  for (const match of quiet.instances) {
    console.log(
      `    ${match.key.padEnd(22)} ${match.state.padEnd(10)} nothing heard for ${(match.staleMs ?? 0) / SECOND}s`
    );
  }
  check(
    quiet.instances.map((match) => match.key).join(",") ===
      SILENT.map((name) => `services:${name}`).join(","),
    `expected only the silent services, got ${quiet.instances.map((m) => m.key).join(",")}`
  );
  check(
    quiet.instances.every((match) => match.state === "healthy"),
    "a silent service was moved before anything swept"
  );
  console.log(
    "\n  Both still say `healthy`, and by time in state they are unremarkable: every service\n" +
      "  has been `healthy` for as long. What separates them is the other clock."
  );

  const escalated = await ekman.sweep();
  console.log("");
  row("swept", everything.length, "one pass, every key");
  row("proposed unreachable", escalated, "only the ones gone quiet");
  check(
    escalated === SILENT.length,
    `expected ${SILENT.length} escalations, got ${escalated}`
  );
  check(
    SILENT.every((name) => handle.inspect(name)?.state === "unreachable"),
    "a service that went quiet was not moved"
  );

  const again = await ekman.sweep();
  row("a second sweep", again, "once per silence, not per pass");
  check(again === 0, `the bound fired again on a second sweep (${again})`);

  banner("4. Where is everything");

  const map = await ekman.map("services", { limitPerState: 4 });
  console.log('  map("services", { limitPerState: 4 })\n');
  for (const state of ["healthy", "degraded", "unreachable"] as const) {
    const entry = map.byState[state];
    const more = (entry?.count ?? 0) - (entry?.keys.length ?? 0);
    console.log(
      `    ${state.padEnd(12)} ${String(entry?.count ?? 0).padStart(3)}  ${entry?.keys.join(", ")}${more > 0 ? `, ... ${more} more` : ""}`
    );
  }
  console.log("");
  row("total", map.total);
  row("complete", String(map.complete), `reasons: [${map.reasons.join(", ")}]`);

  check(
    map.byState.healthy?.count === STEADY.length + 1 &&
      map.byState.degraded?.count === FAILING.length &&
      map.byState.unreachable?.count === SILENT.length,
    "the map does not count the fleet the way it was driven"
  );
  check(
    map.total === everything.length,
    "the per-state limit reduced the count"
  );

  // A service comes back. One probe, and the handler that receives it moves it.
  await handle.send("search-api", ok);
  check(
    handle.inspect("search-api")?.state === "healthy",
    "a probe did not bring an unreachable service back"
  );

  const { events } = await handle.history("payments-api");
  console.log("\n  one that degraded, the start of its stream:\n");
  stream("services:payments-api", events, { limit: 7 });

  console.log(
    `\n${"=".repeat(78)}\n` +
      "The handlers recorded and decided, and nothing else. None of them compared a counter\n" +
      "with a threshold and none of them read a clock: the rule did the first, the freshness\n" +
      "bound did the second, and each arrived as a trigger the handler was free to decline.\n" +
      "One call then said where all of it was, with counts that a limit does not shorten.\n"
  );

  await ekman.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
