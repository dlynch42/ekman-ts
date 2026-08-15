import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEVELS = ["core", "durable", "coordinated"] as const;
export type Level = (typeof LEVELS)[number];

/** Levels this implementation claims. Extend as later phases land. */
export const CLAIMED_LEVELS: readonly Level[] = ["core"];

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
  };
  readonly entities: readonly EntitySpec[];
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
  readonly to?: string;
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
  | { readonly wait: number };

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
  readonly state?: Readonly<Record<string, StateExpectation | null>>;
  readonly buildError?: { readonly code: string };
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

export function isWaitStep(
  step: Step
): step is Extract<Step, { wait: number }> {
  return "wait" in step;
}

/** The scenarios directory, resolved relative to this file so the cwd does not matter. */
export const SCENARIOS_DIR = fileURLToPath(
  new URL("../scenarios", import.meta.url)
);

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
