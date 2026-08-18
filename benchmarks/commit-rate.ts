/**
 * Commit rate: what one trigger costs, end to end, on one key.
 *
 * Run with `npm run bench:commit-rate`.
 *
 * One key means fully serialized, which is the runtime's slowest and most honest shape:
 * every commit waits for the one before it, so the number is the per-commit cost with
 * nothing hidden behind concurrency. The handlers are synchronous and do nothing, because
 * the point is what Ekman adds, not what a handler costs.
 *
 * Throughput and latency are measured in separate passes. Timing every individual send
 * would perturb the throughput figure by exactly the amount of instrumentation added, and
 * a throughput number that includes its own measurement is not one.
 */

import type { EntityHandle } from "ekman";
import { defineEntity, Ekman, stay, transitionTo } from "ekman";
import {
  check,
  elapsed,
  figure,
  opsPerSec,
  percentile,
  rounds,
  type SuiteResult,
  sortNumeric,
  TIMED_ROUNDS,
  WARMUP_ROUNDS,
} from "./lib";

export const NAME = "commit-rate";

const THROUGHPUT_OPS = 20_000;
const LATENCY_OPS = 5000;

/** Values updated in place, no state change. The cheapest committing result there is. */
const staying = defineEntity("staying", {
  initial: "counting",
  values: { n: 0 },
  states: {
    counting: (instance) => stay({ n: instance.values.n + 1 }),
  },
});

/** A state change on every trigger, which is the path constraints and guards hang off. */
const moving = defineEntity("moving", {
  initial: "even",
  values: { n: 0 },
  states: {
    even: (instance) => transitionTo("odd", { n: instance.values.n + 1 }),
    odd: (instance) => transitionTo("even", { n: instance.values.n + 1 }),
  },
});

export async function run(): Promise<SuiteResult> {
  const stayThroughput = await rounds(TIMED_ROUNDS, async (round) => {
    const ekman = new Ekman({ entities: [staying] });
    try {
      return await throughput(ekman.entities.staying, `r${round}`);
    } finally {
      await ekman.close();
    }
  });

  const moveThroughput = await rounds(TIMED_ROUNDS, async (round) => {
    const ekman = new Ekman({ entities: [moving] });
    try {
      return await throughput(ekman.entities.moving, `r${round}`);
    } finally {
      await ekman.close();
    }
  });

  const latency = await latencies();

  return {
    suite: NAME,
    figures: [
      figure("stay, one key", "ops/sec", "higher", stayThroughput),
      figure("transitionTo, one key", "ops/sec", "higher", moveThroughput),
      figure("send to commit, p50", "ms", "lower", latency.p50),
      figure("send to commit, p99", "ms", "lower", latency.p99),
    ],
  };
}

/** `THROUGHPUT_OPS` awaited sends to one key, as a rate. */
async function throughput(
  handle: EntityHandle<string, { n: number }>,
  id: string
): Promise<number> {
  const ms = await elapsed(async () => {
    for (let i = 0; i < THROUGHPUT_OPS; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: serialized is the shape being measured, and issuing them together would measure the inbox instead
      await handle.send(id, { type: "tick" });
    }
  });

  const landed = handle.inspect(id);
  check(
    landed?.values.n === THROUGHPUT_OPS,
    `${String(landed?.values.n)} commits landed, expected ${THROUGHPUT_OPS}`
  );
  return opsPerSec(THROUGHPUT_OPS, ms);
}

/**
 * Per-send durations, so the tail is visible rather than averaged away.
 *
 * Written as its own loop rather than through `rounds` because each round yields two
 * figures, and a warmup round has to contribute to neither.
 */
async function latencies(): Promise<{ p50: number[]; p99: number[] }> {
  const p50: number[] = [];
  const p99: number[] = [];

  for (let round = 0; round < WARMUP_ROUNDS + TIMED_ROUNDS; round += 1) {
    const ekman = new Ekman({ entities: [staying] });
    const handle = ekman.entities.staying;
    const samples: number[] = [];

    try {
      for (let i = 0; i < LATENCY_OPS; i += 1) {
        const started = process.hrtime.bigint();
        // biome-ignore lint/performance/noAwaitInLoops: one at a time is what makes each sample a latency rather than a share of a batch
        await handle.send(`r${round}`, { type: "tick" });
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
    } finally {
      await ekman.close();
    }

    if (round >= WARMUP_ROUNDS) {
      const sorted = sortNumeric(samples);
      p50.push(percentile(sorted, 50));
      p99.push(percentile(sorted, 99));
    }
  }

  return { p50, p99 };
}
