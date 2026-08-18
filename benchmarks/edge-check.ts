/**
 * Edge check: the transition-graph lookup on its own, with no commit under it.
 *
 * Run with `npm run bench:edge-check`.
 *
 * This is the only benchmark here that reaches past the public API, and it exists because
 * the others proved they had to. End to end a commit costs microseconds, and `constraints`
 * reports in its own output that the graph check is smaller than the run-to-run spread of
 * the rate it is part of. An instrument that pays for a whole commit on every sample
 * cannot resolve a change to the lookup inside it, so this one pays for nothing else.
 *
 * Graph size is varied because the representations behave differently as it grows. A hash
 * lookup is flat in the number of states; a word-per-32-states bitset is not. A figure
 * taken at one size would hide whichever of those is about to matter.
 *
 * The miss path is measured separately. A rejected edge builds a violation carrying the
 * declared targets, which is string work rather than lookup work, and it is the path an
 * entity in `warn` mode takes on every violation it is there to discover.
 *
 * The control runs the same loop against an entity that declared no constraints, which
 * returns a shared empty result and does no work at all. It is the floor: the difference
 * between it and the legal-edge figure is everything a change to the representation could
 * possibly move, and the rest of the gap is the loop itself.
 */

import type { InstanceSnapshot, Trigger, Values } from "ekman";
import {
  type CompiledConstraints,
  checkConstraints,
  compileConstraints,
  type ProposedCommit,
} from "../src/constraints";
import {
  check,
  type Figure,
  figure,
  opsPerSec,
  rounds,
  type SuiteResult,
  TIMED_ROUNDS,
} from "./lib";

export const NAME = "edge-check";

const CHECKS = 2_000_000;
/** One word, four words, and small enough to be the common case. */
const SIZES = [4, 32, 128] as const;

/** What `checkConstraints` takes, named so the loop can pass a prepared one. */
interface CheckArgs {
  instance: InstanceSnapshot;
  next: ProposedCommit;
  trigger: Trigger;
  transitioning: boolean;
  mutatingValues: boolean;
}

interface Graph {
  readonly compiled: CompiledConstraints;
  /** One prepared call per state, moving one step around the ring. A declared edge. */
  readonly legal: readonly CheckArgs[];
  /** One per state, half the ring away. A declared state and never a declared edge. */
  readonly illegal: readonly CheckArgs[];
}

export async function run(): Promise<SuiteResult> {
  const figures: Figure[] = [];

  for (const size of SIZES) {
    const graph = ring(size);
    // biome-ignore lint/performance/noAwaitInLoops: one size at a time, so a round is never sharing the machine with another size
    const hits = await rounds(TIMED_ROUNDS, () =>
      Promise.resolve(drive(graph, true))
    );
    figures.push(
      figure(`legal edge, ${size} states`, "ops/sec", "higher", hits)
    );
  }

  const misses = await rounds(TIMED_ROUNDS, () =>
    Promise.resolve(drive(ring(32), false))
  );
  figures.push(figure("rejected edge, 32 states", "ops/sec", "higher", misses));

  const control = await rounds(TIMED_ROUNDS, () =>
    Promise.resolve(drive(ring(32), true, true))
  );
  figures.push(figure("control: no constraints", "ops/sec", "higher", control));

  return { suite: NAME, figures };
}

/**
 * `CHECKS` lookups, cycling through every state rather than hammering one.
 *
 * The violation count is asserted afterwards. A loop whose result nothing reads is a loop
 * the engine is free to delete, and a benchmark measuring a deleted loop reports a very
 * good number.
 */
function drive(graph: Graph, legal: boolean, control = false): number {
  const compiled = control ? undefined : graph.compiled;
  const calls = legal ? graph.legal : graph.illegal;
  const size = calls.length;
  const [fallback] = calls;
  if (fallback === undefined) {
    throw new Error("the ring prepared no calls");
  }
  let violations = 0;

  const ms = elapsedSync(() => {
    for (let i = 0; i < CHECKS; i += 1) {
      violations += checkConstraints(
        compiled,
        calls[i % size] ?? fallback
      ).length;
    }
  });

  check(
    legal || control ? violations === 0 : violations === CHECKS,
    `${violations} violations from ${CHECKS} ${legal ? "legal" : "rejected"} checks`
  );
  return opsPerSec(CHECKS, ms);
}

/**
 * A ring of `size` states where every state allows the next two. Cyclic on purpose.
 *
 * Every argument the loop will pass is built here rather than in it. Allocating a snapshot
 * per iteration would put an object allocation in front of the lookup and leave the figure
 * measuring the allocator, which is not the thing this benchmark exists to resolve.
 */
function ring(size: number): Graph {
  const states = Array.from({ length: size }, (_, i) => `s${i}`);
  const allow: Record<string, readonly string[]> = {};
  for (const [index, state] of states.entries()) {
    allow[state] = [
      states[(index + 1) % size] ?? "",
      states[(index + 2) % size] ?? "",
    ];
  }

  const compiled = compileConstraints(
    "bench",
    { transitions: { allow } },
    new Set(states)
  );
  check(compiled !== undefined, "the ring compiled to no constraints");

  const half = Math.trunc(size / 2);
  const call = (from: string, to: string): CheckArgs => ({
    instance: snapshot(from),
    next: proposed(to),
    trigger: TRIGGER,
    transitioning: true,
    mutatingValues: false,
  });

  return {
    compiled: compiled as CompiledConstraints,
    legal: states.map((state, index) =>
      call(state, states[(index + 1) % size] ?? "")
    ),
    illegal: states.map((state, index) =>
      call(state, states[(index + half) % size] ?? "")
    ),
  };
}

const VALUES: Values = Object.freeze({ n: 1 });
const TRIGGER: Trigger = Object.freeze({ type: "tick" });

function snapshot(state: string): InstanceSnapshot {
  return Object.freeze({
    key: "bench:one",
    entity: "bench",
    state,
    values: VALUES,
    seq: 1,
  });
}

function proposed(state: string): ProposedCommit {
  return Object.freeze({ state, values: VALUES });
}

/** The synchronous twin of `elapsed`, since nothing here awaits. */
function elapsedSync(body: () => void): number {
  const started = process.hrtime.bigint();
  body();
  return Number(process.hrtime.bigint() - started) / 1e6;
}
