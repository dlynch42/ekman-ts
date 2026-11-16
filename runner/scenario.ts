import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEVELS = ["core", "durable", "coordinated"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Levels this implementation claims.
 *
 * A level is claimed only when everything it requires is implemented, not when its
 * scenarios happen to pass: a partial claim is worse than no claim, because someone will
 * believe it. Coordinated needs multi-runtime conflict handling, which is not built.
 */
export const CLAIMED_LEVELS: readonly Level[] = ["core", "durable"];

/**
 * Levels whose scenarios are executed, claimed or not.
 *
 * Coordinated runs without being claimed. Building towards a level without being able to
 * see how far you have got would be pointless, and what claiming adds is that a failure
 * fails the suite.
 */
export const RUN_LEVELS: readonly Level[] = ["core", "durable", "coordinated"];

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly level: Level;
  readonly given: Given;
  readonly when?: readonly Step[];
  readonly then?: Then;
}

export interface Given {
  readonly runtime?: {
    readonly clock?: { readonly start: number; readonly stepMs: number };
    readonly inbox?: InboxSpec;
    readonly execution?: PolicySpec;
    readonly temporal?: { readonly sweepMs?: number };
    readonly store?: StoreSpec | readonly StoreSpec[];
    /** How many runtimes are expected to write these keys. Defaults to single. */
    readonly coordination?: "single" | "multi";
    readonly memory?: MemorySpec;
    readonly audit?: readonly AuditSpec[];
  };
  readonly entities: readonly EntitySpec[];
}

/**
 * A store layer to build.
 *
 * A `file` layer gets a directory the runner owns, which survives a `restart` step and is
 * removed when the scenario ends. Scenarios never name paths: where a durable store keeps
 * its bytes is not behaviour worth pinning across implementations.
 */
export interface StoreSpec {
  readonly kind: "memory" | "file";
  readonly name?: string;
  readonly authority?: boolean;
}

export interface MemorySpec {
  readonly maxBytes?: number;
  readonly eviction?: {
    readonly policy?: "lru" | "reject" | "none";
    readonly snapshotOnEvict?: boolean;
    readonly allowDiscard?: boolean;
  };
}

export interface AuditSpec {
  readonly name: string;
  /** Reject this many deliveries before succeeding. Exercises at-least-once retrying. */
  readonly failTimes?: number;
}

/** Execution policy, at whichever level it is declared. */
export interface PolicySpec {
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly backoff?:
    | { readonly kind: "fixed"; readonly delayMs: number }
    | {
        readonly kind: "exponential";
        readonly baseMs: number;
        readonly factor?: number;
        readonly maxDelayMs?: number;
      };
}

export interface InboxSpec {
  readonly capacity?: number;
  readonly overflow?: "reject" | "drop-newest" | "drop-oldest";
  readonly recordOverflow?: boolean;
}

export interface EntitySpec {
  readonly name: string;
  readonly initial: string;
  readonly values?: Record<string, unknown>;
  readonly unknown?: "reject";
  readonly triggers?: readonly string[];
  /** Entity-wide execution policy, over the runtime's and under any state's. */
  readonly policy?: PolicySpec;
  readonly states: readonly StateSpec[];
  readonly constraints?: ConstraintsSpec;
  /** Recovery handlers keyed by error classification, with `*` as the fallback. */
  readonly onError?: Readonly<Record<string, DoSpec>>;
}

export type ViolationPolicySpec = "reject" | "warn" | "off";

export interface ConstraintsSpec {
  readonly transitions?: {
    readonly policy?: ViolationPolicySpec;
    readonly allow: Readonly<Record<string, readonly string[]>>;
  };
  readonly guards?: readonly {
    readonly name?: string;
    readonly on: string;
    /** Source states the guard is scoped to. Omitted means any of them. */
    readonly from?: readonly string[];
    readonly policy?: ViolationPolicySpec;
    readonly check: CheckSpec;
  }[];
  readonly invariants?: readonly {
    readonly name?: string;
    readonly in?: readonly string[];
    readonly policy?: ViolationPolicySpec;
    readonly check: CheckSpec;
  }[];
  readonly temporal?: readonly {
    readonly name?: string;
    readonly in: string;
    readonly within: number;
    readonly escalateTo?: string;
    readonly trigger?: string;
    readonly policy?: ViolationPolicySpec;
  }[];
}

/**
 * A guard or invariant condition, expressed as data.
 *
 * One source (`values`, `trigger`, or `state`) and one predicate (`exists`, `equals`,
 * `gte`, or `lte`), which is enough to express every condition the suite needs without a
 * expression language every port would then have to implement identically.
 */
export interface CheckSpec {
  /** Dot path into the values being proposed. Empty string is the whole map. */
  readonly values?: string;
  /** Dot path into the trigger. */
  readonly trigger?: string;
  /** Read the proposed state name. */
  readonly state?: true;
  readonly exists?: boolean;
  readonly equals?: unknown;
  readonly gte?: number;
  readonly lte?: number;
  /** Reported as the violation's reason when the check does not hold. */
  readonly reason?: string;
  /** Throw instead of answering, exercising the broken-check path. */
  readonly throw?: string;
}

export interface StateSpec {
  readonly state: string;
  readonly cases?: readonly CaseSpec[];
  readonly else?: DoSpec;
  /** Execution policy for this state alone, over the entity's and the runtime's. */
  readonly policy?: PolicySpec;
}

export interface CaseSpec {
  /**
   * All declared conditions must match. `attempt` is what makes retry behaviour
   * expressible: "fail on attempt 1, commit on attempt 2".
   */
  readonly when?: { readonly trigger?: string; readonly attempt?: number };
  readonly do: DoSpec;
}

export interface DoSpec {
  readonly result?: "transitionTo" | "stay" | "fail";
  /** A state name, or a value expression resolving to one. */
  readonly to?: unknown;
  readonly values?: unknown;
  readonly error?: string;
  readonly errorName?: string;
  readonly throw?: string;
  readonly delayMs?: number;
}

export type Step =
  | {
      readonly send: { readonly key: string; readonly trigger: TriggerSpec };
      readonly await?: boolean;
    }
  | { readonly drain: true }
  /**
   * Wall-clock pause. For work the runtime is still doing after every send has settled,
   * which is exactly the case a fenced zombie exercises.
   */
  | { readonly wait: number }
  /**
   * Move the declared clock forward. Time-in-state is measured on that clock, so this is
   * how a scenario ages an instance without waiting.
   */
  | { readonly advance: number }
  /** Evaluate temporal constraints once and settle whatever they escalate. */
  | { readonly sweep: true }
  /**
   * Throw the runtime away and build a new one against the same durable storage.
   *
   * A process restart, in other words. Everything resident is lost; everything committed
   * to a durable store is not. This is the step the recovery claim is made of.
   */
  | { readonly restart: true }
  /**
   * Delete an instance outright: its resident state and its stream in every layer.
   *
   * Destroys committed state, so it is addressed by key and never inferred. The runner
   * records the outcome of every one of these in order, the same way it does for a send,
   * because being refused is as much of a result as succeeding.
   */
  | { readonly forget: { readonly key: string } };

export interface TriggerSpec {
  readonly type: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}

export interface Then {
  readonly sends?: readonly SendExpectation[];
  readonly events?: Readonly<
    Record<string, readonly Record<string, unknown>[]>
  >;
  /**
   * Telemetry matchers, asserted as an ordered subsequence rather than an exact list.
   *
   * Telemetry is a firehose: a scenario that cares about one drop should not break when
   * an unrelated enqueue is emitted alongside it. Order between the matchers is still
   * asserted, so "started before settled" is provable.
   */
  readonly telemetry?: readonly Record<string, unknown>[];
  /**
   * Telemetry matchers that must match nothing that was emitted.
   *
   * The subsequence above can only say an event happened. This is how a scenario says one
   * did not, which is the whole claim when the behaviour under test is a refusal to act.
   */
  readonly telemetryAbsent?: readonly Record<string, unknown>[];
  readonly state?: Readonly<Record<string, StateExpectation | null>>;
  readonly buildError?: { readonly code: string };
  /**
   * Which keys are still resident, in no particular order.
   *
   * How eviction is asserted: a key that is absent here but present in `state` proves the
   * reload was transparent, because the assertion read it back without noticing.
   */
  readonly resident?: readonly string[];
  /** Outcomes of the `forget` steps, in the order the steps appear. */
  readonly forgets?: readonly ForgetExpectation[];
  readonly memory?: {
    readonly instances?: number;
    /** Resident bytes must not exceed this. The budget claim, stated as an assertion. */
    readonly withinBytes?: number;
  };
  /** Events each audit sink received, by sink name, as `<type>@<seq>`. */
  readonly audit?: Readonly<Record<string, readonly string[]>>;
  /** Queries to run after everything has settled, each with the answer it must give. */
  readonly queries?: readonly QueryExpectation[];
  /** Per-key history reads, for what `then.events` cannot say. */
  readonly history?: Readonly<Record<string, HistoryExpectation>>;
}

export interface QueryExpectation {
  readonly entity: string;
  readonly state?: string;
  readonly olderThan?: number | string;
  readonly limit?: number;
  /** Matching keys, oldest in state first. */
  readonly keys: readonly string[];
  readonly complete?: boolean;
  /** Asserted as a set when present. */
  readonly reasons?: readonly string[];
}

export interface HistoryExpectation {
  /** The stream as `<type>@<seq>`, in order. */
  readonly events?: readonly string[];
  readonly complete?: boolean;
  readonly reasons?: readonly string[];
}

export interface ForgetExpectation {
  readonly outcome: "ok" | "refused";
  /** The stable error code, asserted on `refused`. */
  readonly code?: string;
}

export interface SendExpectation {
  readonly outcome: "committed" | "rejected";
  readonly state?: string;
  readonly seq?: number;
  readonly values?: Record<string, unknown>;
  readonly code?: string;
}

export interface StateExpectation {
  readonly state?: string;
  readonly values?: Record<string, unknown>;
  readonly seq?: number;
}

export function isSendStep(
  step: Step
): step is Extract<Step, { send: unknown }> {
  return "send" in step;
}

export function isDrainStep(
  step: Step
): step is Extract<Step, { drain: true }> {
  return "drain" in step && step.drain === true;
}

export function isWaitStep(
  step: Step
): step is Extract<Step, { wait: number }> {
  return "wait" in step;
}

export function isAdvanceStep(
  step: Step
): step is Extract<Step, { advance: number }> {
  return "advance" in step;
}

export function isSweepStep(
  step: Step
): step is Extract<Step, { sweep: true }> {
  return "sweep" in step;
}

export function isRestartStep(
  step: Step
): step is Extract<Step, { restart: true }> {
  return "restart" in step;
}

export function isForgetStep(
  step: Step
): step is Extract<Step, { forget: unknown }> {
  return "forget" in step;
}

/**
 * Whether a step is exactly one of the kinds the runner knows, written the way that kind
 * is written.
 *
 * The predicates above only ask which key is present, which is all the runner needs to
 * dispatch a step it already trusts. This is the check that earns the trust: without it
 * `{ "sweep": false }` would sweep, and a step naming two kinds would silently run one.
 */
export function isWellFormedStep(step: unknown): step is Step {
  if (typeof step !== "object" || step === null) {
    return false;
  }

  const { await: awaited, ...rest } = step as Record<string, unknown>;
  const [kind, ...others] = Object.keys(rest);
  if (kind === undefined || others.length > 0) {
    return false;
  }

  const value = rest[kind];
  if (kind === "send") {
    return (
      (awaited === undefined || typeof awaited === "boolean") &&
      hasStringKey(value) &&
      typeof (value as { trigger?: unknown }).trigger === "object" &&
      (value as { trigger?: unknown }).trigger !== null
    );
  }
  if (awaited !== undefined) {
    return false;
  }
  if (kind === "forget") {
    return hasStringKey(value);
  }
  if (kind === "wait" || kind === "advance") {
    return typeof value === "number" && value >= 0;
  }
  return FLAG_STEPS.has(kind) && value === true;
}

const FLAG_STEPS: ReadonlySet<string> = new Set(["drain", "sweep", "restart"]);

function hasStringKey(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

/** The scenarios directory, resolved relative to this file so the cwd does not matter. */
export const SCENARIOS_DIR = fileURLToPath(
  new URL("../scenarios", import.meta.url)
);

/**
 * Every telemetry event name a matcher may ask for, read from the scenario schema.
 *
 * Read rather than repeated, so the schema stays the one list. A matcher is checked
 * against it before a scenario runs, because a misspelled type in `telemetryAbsent`
 * matches nothing and would pass for exactly the reason it should fail.
 */
export function telemetryTypes(
  dir: string = SCENARIOS_DIR
): ReadonlySet<string> {
  const schema = JSON.parse(
    readFileSync(join(dir, "schema", "scenario.schema.json"), "utf8")
  ) as {
    $defs: { telemetryMatcher: { properties: { type: { enum: string[] } } } };
  };
  return new Set(schema.$defs.telemetryMatcher.properties.type.enum);
}

const JSON_EXTENSION = /\.json$/;

/** Load every scenario file, sorted by id so reports are stable. */
export function loadScenarios(dir: string = SCENARIOS_DIR): Scenario[] {
  const scenarios: Scenario[] = [];

  for (const level of LEVELS) {
    const levelDir = join(dir, level);
    let names: string[];
    try {
      names = readdirSync(levelDir);
    } catch {
      continue; // a level with no scenarios yet is not an error
    }

    for (const name of names) {
      const path = join(levelDir, name);
      if (!(name.endsWith(".json") && statSync(path).isFile())) {
        continue;
      }

      const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
      const expectedId = `${level}/${name.replace(JSON_EXTENSION, "")}`;

      if (scenario.id !== expectedId) {
        throw new Error(
          `scenario at ${path} declares id "${scenario.id}", expected "${expectedId}"`
        );
      }
      if (scenario.level !== level) {
        throw new Error(
          `scenario ${scenario.id} declares level "${scenario.level}" but sits in ${level}/`
        );
      }

      scenarios.push(scenario);
    }
  }

  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}
