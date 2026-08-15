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
  };
  readonly entities: readonly EntitySpec[];
}

export interface EntitySpec {
  readonly name: string;
  readonly initial: string;
  readonly values?: Record<string, unknown>;
  readonly unknown?: "reject";
  readonly triggers?: readonly string[];
  readonly states: readonly StateSpec[];
}

export interface StateSpec {
  readonly state: string;
  readonly cases?: readonly CaseSpec[];
  readonly else?: DoSpec;
}

export interface CaseSpec {
  readonly when?: { readonly trigger?: string };
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
  | { readonly drain: true };

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
