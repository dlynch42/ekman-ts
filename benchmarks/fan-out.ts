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
  delay,
  elapsed,
  figure,
  median,
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

/**
 * The second pair of figures uses a handler that waits, which is what a handler does.
 *
 * Smaller totals, because the whole point is that these take real time. The same count of
 * triggers is delivered twice: once to one key and once spread across many, so the two
 * figures differ in nothing but how many keys the work was addressed to.
 */
const WAITING_TRIGGERS = 200;
const WAITING_KEYS = 50;
const WORK_MS = 1;

const counters = defineEntity("counters", {
  initial: "counting",
  values: { n: 0 },
  states: {
    counting: (instance) => stay({ n: instance.values.n + 1 }),
  },
});

/** The same entity with the one thing real handlers do: yield. */
const waiting = defineEntity("waiting", {
  initial: "counting",
  values: { n: 0 },
  states: {
    counting: async (instance) => {
      await delay(WORK_MS);
      return stay({ n: instance.values.n + 1 });
    },
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

  const waited = await waitingRates();

  return {
    suite: NAME,
    figures: [
      figure("do-nothing handler, 500 keys", "ops/sec", "higher", rates, {
        keys: KEYS,
        "triggers per key": PER_KEY,
      }),
      figure("resident instances", "count", "neither", resident),
      figure("1ms handler, one key", "ops/sec", "higher", waited.serial),
      figure(
        `1ms handler, ${WAITING_KEYS} keys`,
        "ops/sec",
        "higher",
        waited.fanned
      ),
    ],
    notes: [contrast(waited)],
  };
}

interface Waiting {
  readonly serial: readonly number[];
  readonly fanned: readonly number[];
}

/** The same triggers, delivered to one key and then to many, with a handler that yields. */
async function waitingRates(): Promise<Waiting> {
  const serial = await rounds(TIMED_ROUNDS, (round) =>
    waitingRate(1, `s${round}`)
  );
  const fanned = await rounds(TIMED_ROUNDS, (round) =>
    waitingRate(WAITING_KEYS, `f${round}`)
  );
  return { serial, fanned };
}

async function waitingRate(keys: number, prefix: string): Promise<number> {
  // The whole burst is offered before the first handler returns, so the one-key variant
  // needs a queue that holds all of it. Anything smaller measures the overflow policy.
  const ekman = new Ekman({
    entities: [waiting],
    inbox: { capacity: WAITING_TRIGGERS },
  });
  const handle = ekman.entities.waiting;
  const perKey = WAITING_TRIGGERS / keys;

  try {
    const ms = await elapsed(async () => {
      const all: Promise<unknown>[] = [];
      for (let k = 0; k < keys; k += 1) {
        for (let i = 0; i < perKey; i += 1) {
          all.push(handle.send(`${prefix}k${k}`, { type: "tick" }));
        }
      }
      await Promise.all(all);
    });

    for (let k = 0; k < keys; k += 1) {
      const landed = handle.inspect(`${prefix}k${k}`);
      check(
        landed?.values.n === perKey,
        `${String(landed?.values.n)} commits landed on one key, expected ${perKey}`
      );
    }

    return opsPerSec(WAITING_TRIGGERS, ms);
  } finally {
    await ekman.close();
  }
}

/**
 * What the two pairs of figures mean together.
 *
 * Read on its own, the do-nothing figure invites the wrong conclusion: that spreading work
 * across keys costs throughput. It does, in a single-threaded runtime with nothing to
 * overlap, and that is all the first figure can show. Serialization is per key, so what
 * fan-out actually buys is that a key waiting on its database call does not hold up any
 * other key. That only becomes visible when a handler waits, which is the second pair.
 */
function contrast(waited: Waiting): string {
  const one = median(waited.serial);
  const many = median(waited.fanned);
  const ratio = one === 0 ? 0 : many / one;

  return (
    `with a handler that does nothing, keys cost throughput. With a ${WORK_MS}ms handler, ` +
    `${WAITING_KEYS} keys are\n  ${ratio.toFixed(0)}x the throughput of one key on the same ` +
    "triggers. Per-key serialization is ordering, not parallelism."
  );
}
