/**
 * The benchmark harness.
 *
 * Nothing here is part of Ekman, and nothing here is needed to use it. It exists so each
 * benchmark is the runtime being driven rather than the same percentile arithmetic copied
 * five times.
 *
 * Three rules, because a benchmark that flatters the thing it measures is worth less than
 * no benchmark at all:
 *
 * 1. Every figure is a median over timed rounds, with the warmup rounds thrown away. V8
 *    needs a few passes before it is running the code you think you wrote.
 * 2. Every figure carries the spread across those rounds. That spread is the noise floor,
 *    and a delta that does not clear it is not a result.
 * 3. A baseline captured on other hardware is not evidence. Comparing against one prints
 *    that it cannot be compared, rather than a number that looks like a finding.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Discarded. Enough passes for V8 to have settled on the code it is going to run. */
export const WARMUP_ROUNDS = 3;
/** Kept. Odd, so the median is a measured round rather than an average of two. */
export const TIMED_ROUNDS = 7;

/**
 * What a figure is measured in, and which direction is an improvement.
 *
 * `neither` exists for figures like a shed rate, where the number describes behaviour
 * rather than quality and calling a change "faster" would be meaningless.
 */
export type Unit = "ops/sec" | "ms" | "%" | "count";
export type Better = "higher" | "lower" | "neither";

export interface Figure {
  readonly name: string;
  readonly unit: Unit;
  readonly better: Better;
  /** The median across timed rounds. */
  readonly value: number;
  /** Inter-round range as a fraction of the median. The noise floor. */
  readonly spread: number;
  /** Percentiles or counts worth showing under the headline. */
  readonly detail?: Readonly<Record<string, number>>;
}

export interface SuiteResult {
  readonly suite: string;
  readonly figures: readonly Figure[];
  /**
   * What the figures do not say on their own.
   *
   * Printed under them and never recorded in the baseline, because a note is a reading of
   * a run rather than a measurement of it.
   */
  readonly notes?: readonly string[];
}

/** The machine a set of figures came from. Comparing across two of these is not valid. */
export interface Env {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpu: string;
  readonly cores: number;
}

export interface Baseline {
  readonly env: Env;
  readonly capturedAt: string;
  readonly suites: Record<string, Record<string, StoredFigure>>;
}

export interface StoredFigure {
  readonly unit: Unit;
  readonly better: Better;
  readonly value: number;
  readonly spread: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(HERE, "baseline.json");

/**
 * The floor under any comparison, even when both runs happen to be unusually quiet.
 *
 * Three percent is not a claim about this machine. It is a refusal to report a delta that
 * small as a result on any machine.
 */
const MINIMUM_NOISE = 0.03;

export function currentEnv(): Env {
  const cores = cpus();
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cores[0]?.model ?? "unknown",
    cores: cores.length,
  };
}

/** Same hardware. Node version is reported separately, because it does not invalidate. */
export function sameMachine(a: Env, b: Env): boolean {
  return (
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.cpu === b.cpu &&
    a.cores === b.cores
  );
}

/**
 * Run `body` for the warmup rounds and then the timed ones, keeping only the timed values.
 *
 * The round number is passed through and includes warmup, so a benchmark can key its
 * instances per round and never measure a round warmed by the one before it.
 */
export async function rounds(
  timed: number,
  body: (round: number) => Promise<number>
): Promise<readonly number[]> {
  const values: number[] = [];
  for (let round = 0; round < WARMUP_ROUNDS + timed; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: rounds are sequential by definition, and overlapping them would measure the overlap
    const value = await body(round);
    if (round >= WARMUP_ROUNDS) {
      values.push(value);
    }
  }
  return values;
}

/** Wall-clock milliseconds around an async body, at nanosecond resolution. */
export async function elapsed(body: () => Promise<void>): Promise<number> {
  const started = process.hrtime.bigint();
  await body();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

export function opsPerSec(ops: number, ms: number): number {
  return ms === 0 ? 0 : (ops / ms) * 1000;
}

export function sortNumeric(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number {
  return percentile(sortNumeric(values), 50);
}

/** Nearest-rank percentile. `sorted` must already be ascending. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? 0;
}

/**
 * Inter-round range over the median.
 *
 * Deliberately the full range rather than an interquartile one. With seven rounds, a
 * single slow round is as likely to be the truth about this machine as it is to be an
 * outlier, and a noise floor that hides it would make small deltas look real.
 */
export function spreadOf(values: readonly number[]): number {
  const sorted = sortNumeric(values);
  const low = sorted[0] ?? 0;
  const high = sorted.at(-1) ?? 0;
  const mid = percentile(sorted, 50);
  return mid === 0 ? 0 : (high - low) / mid;
}

export function figure(
  name: string,
  unit: Unit,
  better: Better,
  values: readonly number[],
  detail?: Readonly<Record<string, number>>
): Figure {
  return {
    name,
    unit,
    better,
    value: median(values),
    spread: spreadOf(values),
    ...(detail === undefined ? {} : { detail }),
  };
}

export type Verdict = "faster" | "slower" | "no change" | "changed";

export interface Comparison {
  readonly baseline: number;
  /** Signed relative change against the baseline. */
  readonly delta: number;
  readonly verdict: Verdict;
}

/**
 * A figure against its baseline, with the noise floor applied.
 *
 * The floor is the widest spread either run saw, never less than `MINIMUM_NOISE`. A delta
 * inside it reports as no change, which is the only honest reading of it.
 */
export function compare(current: Figure, baseline: StoredFigure): Comparison {
  const delta =
    baseline.value === 0
      ? 0
      : (current.value - baseline.value) / baseline.value;
  const floor = Math.max(MINIMUM_NOISE, current.spread, baseline.spread);

  if (Math.abs(delta) < floor) {
    return { baseline: baseline.value, delta, verdict: "no change" };
  }
  if (current.better === "neither") {
    return { baseline: baseline.value, delta, verdict: "changed" };
  }
  const improved = current.better === "higher" ? delta > 0 : delta < 0;
  return {
    baseline: baseline.value,
    delta,
    verdict: improved ? "faster" : "slower",
  };
}

export function readBaseline(): Baseline | undefined {
  if (!existsSync(BASELINE_PATH)) {
    return;
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

/**
 * Write the baseline, keeping suites that were not part of this run.
 *
 * Merging only holds when the existing file came from this machine. When it did not, the
 * file is replaced outright: a baseline containing figures from two machines could not be
 * read correctly by anyone, including us.
 */
export function writeBaseline(results: readonly SuiteResult[]): {
  merged: boolean;
} {
  const env = currentEnv();
  const existing = readBaseline();
  const merged = existing !== undefined && sameMachine(existing.env, env);

  const suites: Record<string, Record<string, StoredFigure>> = merged
    ? { ...existing.suites }
    : {};

  for (const result of results) {
    const stored: Record<string, StoredFigure> = {};
    for (const found of result.figures) {
      stored[found.name] = {
        unit: found.unit,
        better: found.better,
        value: found.value,
        spread: found.spread,
      };
    }
    suites[result.suite] = stored;
  }

  const baseline: Baseline = {
    env,
    capturedAt: new Date().toISOString(),
    suites,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  return { merged };
}

export function banner(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);
}

export function note(text: string): void {
  console.log(`  ${text}`);
}

export function format(value: number, unit: Unit): string {
  const digits = digitsFor(value, unit);
  const shown = value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return unit === "count" ? shown : `${shown} ${unit}`;
}

/** Enough resolution to see the figure, not so much that noise looks like precision. */
function digitsFor(value: number, unit: Unit): number {
  if (unit === "ms") {
    return value < 10 ? 3 : 0;
  }
  return unit === "%" ? 1 : 0;
}

/** One figure, with its baseline comparison when there is a valid one. */
export function printFigure(
  found: Figure,
  against: Comparison | undefined
): void {
  const spread = `±${(found.spread * 100).toFixed(1)}%`;
  const compared =
    against === undefined
      ? ""
      : `   ${verdictOf(against)} vs ${format(against.baseline, found.unit)}`;

  console.log(
    `  ${found.name.padEnd(34)}${format(found.value, found.unit).padStart(16)}` +
      `${spread.padStart(9)}${compared}`
  );

  for (const [label, value] of Object.entries(found.detail ?? {})) {
    console.log(
      `    ${label.padEnd(32)}${value.toLocaleString(undefined, { maximumFractionDigits: 3 }).padStart(16)}`
    );
  }
}

function verdictOf(against: Comparison): string {
  const sign = against.delta >= 0 ? "+" : "";
  return `${against.verdict} (${sign}${(against.delta * 100).toFixed(1)}%)`;
}

/** An assertion with a message. A benchmark that measured the wrong thing must fail loudly. */
export function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
