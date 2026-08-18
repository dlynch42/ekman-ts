/**
 * Fan-out: many keys at once, and what serialization costs when it is not in the way.
 *
 * Run with `npm run bench:fan-out`.
 *
 * `commit-rate` measures the worst case: one key, every commit waiting for the last. This
 * measures the case real services are in, where thousands of unrelated instances have work
 * pending and only same-key work is ordered against itself.
 *
 * Every trigger is issued before any of them is awaited, so the whole burst is in flight
 * at once and the runtime is scheduling rather than being fed. The final count per key is
 * asserted, because a throughput number from a run that lost commits measures nothing.
 */

import { defineEntity, Ekman, stay } from "ekman";
import {
  check,
  elapsed,
  figure,
  opsPerSec,
  rounds,
  type SuiteResult,
  TIMED_ROUNDS,
  WARMUP_ROUNDS,
} from "./lib";

export const NAME = "fan-out";

const KEYS = 500;
const PER_KEY = 20;
const TOTAL = KEYS * PER_KEY;

const counters = defineEntity("counters", {
  initial: "counting",
  values: { n: 0 },
  states: {
    counting: (instance) => stay({ n: instance.values.n + 1 }),
  },
});

export async function run(): Promise<SuiteResult> {
  const resident: number[] = [];

  const rates = await rounds(TIMED_ROUNDS, async (round) => {
    const ekman = new Ekman({ entities: [counters] });
    const handle = ekman.entities.counters;
    const ids = Array.from({ length: KEYS }, (_, k) => `r${round}k${k}`);

    try {
      const ms = await elapsed(async () => {
        const all: Promise<unknown>[] = [];
        for (const id of ids) {
          for (let i = 0; i < PER_KEY; i += 1) {
            all.push(handle.send(id, { type: "tick" }));
          }
        }
        await Promise.all(all);
      });

      for (const id of ids) {
        const landed = handle.inspect(id);
        check(
          landed?.values.n === PER_KEY,
          `${id} landed ${String(landed?.values.n)} commits, expected ${PER_KEY}`
        );
      }

      if (round >= WARMUP_ROUNDS) {
        resident.push(ekman.residentKeys.length);
      }
      return opsPerSec(TOTAL, ms);
    } finally {
      await ekman.close();
    }
  });

  return {
    suite: NAME,
    figures: [
      figure("commits, 500 keys in flight", "ops/sec", "higher", rates, {
        keys: KEYS,
        "triggers per key": PER_KEY,
      }),
      figure("resident instances", "count", "neither", resident),
    ],
  };
}
