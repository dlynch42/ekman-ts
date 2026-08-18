/**
 * Constraints: what the strictness dial costs, one notch at a time.
 *
 * Run with `npm run bench:constraints`.
 *
 * Every entity here does the same work, `transitionTo` on every trigger, and differs only
 * in what is checked before the commit lands. Reading down the list gives the price of the
 * transition graph, then of guards on top of it, then of invariants on top of those.
 *
 * All four configurations run inside the same round, so a round that happened to land on a
 * noisy moment penalises all of them together and the overhead figures stay meaningful.
 * Overhead is computed per round against that round's unconstrained rate, not from the
 * medians afterwards, which is what keeps it from being an artefact of two separate runs.
 */

import type { EntityHandle } from "ekman";
import { defineEntity, Ekman, transitionTo } from "ekman";
import {
  check,
  elapsed,
  figure,
  opsPerSec,
  type SuiteResult,
  sortNumeric,
  spreadOf,
  TIMED_ROUNDS,
  WARMUP_ROUNDS,
} from "./lib";

export const NAME = "constraints";

const SLICES = 8;
const PER_SLICE = 2500;
const OPS = SLICES * PER_SLICE;

const states = {
  even: (instance: { values: { n: number } }) =>
    transitionTo("odd" as const, { n: instance.values.n + 1 }),
  odd: (instance: { values: { n: number } }) =>
    transitionTo("even" as const, { n: instance.values.n + 1 }),
};

const bare = defineEntity("bare", {
  initial: "even",
  values: { n: 0 },
  states,
});

const graphed = defineEntity("graphed", {
  initial: "even",
  values: { n: 0 },
  states,
  constraints: {
    transitions: { allow: { even: ["odd"], odd: ["even"] } },
  },
});

const guarded = defineEntity("guarded", {
  initial: "even",
  values: { n: 0 },
  states,
  constraints: {
    transitions: { allow: { even: ["odd"], odd: ["even"] } },
    guards: [
      { on: "odd", check: (next) => next.values.n > 0 },
      { on: "even", check: (next) => next.values.n > 0 },
    ],
  },
});

const invariant = defineEntity("invariant", {
  initial: "even",
  values: { n: 0 },
  states,
  constraints: {
    transitions: { allow: { even: ["odd"], odd: ["even"] } },
    guards: [
      { on: "odd", check: (next) => next.values.n > 0 },
      { on: "even", check: (next) => next.values.n > 0 },
    ],
    invariants: [
      { in: ["even", "odd"], check: (next) => Number.isFinite(next.values.n) },
    ],
  },
});

interface Round {
  readonly none: number;
  readonly graph: number;
  readonly guards: number;
  readonly everything: number;
}

export async function run(): Promise<SuiteResult> {
  const none: number[] = [];
  const graph: number[] = [];
  const guards: number[] = [];
  const everything: number[] = [];
  const graphCost: number[] = [];

  for (let round = 0; round < WARMUP_ROUNDS + TIMED_ROUNDS; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: rounds are sequential, and so are the four configurations inside each one
    const measured = await roundOf(round);
    if (round < WARMUP_ROUNDS) {
      continue;
    }

    none.push(measured.none);
    graph.push(measured.graph);
    guards.push(measured.guards);
    everything.push(measured.everything);
    graphCost.push(costOf(measured.none, measured.graph));
  }

  return {
    suite: NAME,
    figures: [
      figure("no constraints", "ops/sec", "higher", none),
      figure("transition graph", "ops/sec", "higher", graph),
      figure("graph + 2 guards", "ops/sec", "higher", guards),
      figure("graph + guards + invariant", "ops/sec", "higher", everything),
    ],
    notes: [resolution(graphCost, none)],
  };
}

/**
 * Whether this benchmark can see the graph check at all.
 *
 * The four rates above are each measured to a few percent. The difference between them is
 * also a few percent, which means an end-to-end benchmark cannot separate the check from
 * the machine it ran on. Saying so is more useful than printing the difference as though
 * it were a figure: it is the reason a claim about the transition graph needs an
 * instrument that does not pay for a commit on every sample.
 */
function resolution(costs: readonly number[], base: readonly number[]): string {
  const sorted = sortNumeric(costs);
  const low = sorted[0] ?? 0;
  const high = sorted.at(-1) ?? 0;
  const noise = spreadOf(base) * 100;

  return (
    `the transition graph cost between ${low.toFixed(1)}% and ${high.toFixed(1)}% of the ` +
    `unconstrained rate across rounds,\n  against a ${noise.toFixed(1)}% spread in that rate ` +
    "itself. This benchmark cannot resolve the check."
  );
}

/** How much of the unconstrained rate a configuration gives up, as a percentage. */
function costOf(base: number, constrained: number): number {
  return base === 0 ? 0 : ((base - constrained) / base) * 100;
}

/**
 * All four configurations, in one round, interleaved.
 *
 * The round is cut into slices and every configuration runs one slice before any of them
 * runs its second. A round that drifts, because of GC or a busy machine or thermal
 * throttling, drifts underneath all four equally, which is what makes the difference
 * between them readable. Running each configuration to completion in turn measures the
 * drift as much as it measures the constraints.
 */
async function roundOf(round: number): Promise<Round> {
  const plain = new Ekman({ entities: [bare] });
  const withGraph = new Ekman({ entities: [graphed] });
  const withGuards = new Ekman({ entities: [guarded] });
  const withEverything = new Ekman({ entities: [invariant] });

  const none = { handle: plain.entities.bare, ms: 0 };
  const graph = { handle: withGraph.entities.graphed, ms: 0 };
  const guards = { handle: withGuards.entities.guarded, ms: 0 };
  const everything = { handle: withEverything.entities.invariant, ms: 0 };
  const lanes = [none, graph, guards, everything];
  const id = `r${round}`;

  try {
    for (let slice = 0; slice < SLICES; slice += 1) {
      for (const lane of lanes) {
        // biome-ignore lint/performance/noAwaitInLoops: one lane at a time is the point, so a slice is never sharing the machine with another lane
        lane.ms += await drive(lane.handle, id);
      }
    }

    for (const lane of lanes) {
      const landed = lane.handle.inspect(id);
      check(
        landed?.values.n === OPS,
        `${String(landed?.values.n)} commits landed, expected ${OPS}`
      );
    }

    return {
      none: opsPerSec(OPS, none.ms),
      graph: opsPerSec(OPS, graph.ms),
      guards: opsPerSec(OPS, guards.ms),
      everything: opsPerSec(OPS, everything.ms),
    };
  } finally {
    await Promise.all([
      plain.close(),
      withGraph.close(),
      withGuards.close(),
      withEverything.close(),
    ]);
  }
}

/** One slice of awaited sends to one key, in milliseconds. */
function drive(
  handle: EntityHandle<string, { n: number }>,
  id: string
): Promise<number> {
  return elapsed(async () => {
    for (let i = 0; i < PER_SLICE; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: serialized, so each commit pays the constraint check on its own
      await handle.send(id, { type: "tick" });
    }
  });
}
