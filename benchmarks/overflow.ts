/**
 * Overflow: what a burst costs when the inbox is bounded, which it always is.
 *
 * Run with `npm run bench:overflow`.
 *
 * This is the only benchmark here whose headline is not a rate. Under a burst larger than
 * the queue, the interesting number is how much load was shed and how fast the answer came
 * back, because that is the difference between a bounded inbox and an unbounded one. An
 * unbounded queue would accept all of it and convert the overload into latency and
 * resident memory instead, which is the failure this design refuses.
 *
 * Every trigger is offered in one synchronous burst, so nothing has been dequeued yet when
 * the last one arrives and the shed rate falls out of the capacity rather than out of how
 * fast the machine happens to be. That makes it comparable across machines in a way the
 * rate figures are not.
 *
 * The run asserts that accepted plus rejected equals offered. Nothing is silently dropped,
 * and a benchmark that did not check would not notice if that stopped being true.
 */

import { defineEntity, Ekman, isEkmanError, stay } from "ekman";
import {
  check,
  elapsed,
  type Figure,
  figure,
  rounds,
  type SuiteResult,
  TIMED_ROUNDS,
  WARMUP_ROUNDS,
} from "./lib";

export const NAME = "overflow";

const OFFERED = 2000;
const CAPACITIES = [8, 128, 1024] as const;

const counters = defineEntity("counters", {
  initial: "counting",
  values: { n: 0 },
  states: {
    counting: (instance) => stay({ n: instance.values.n + 1 }),
  },
});

interface Burst {
  readonly accepted: number;
  readonly rejected: number;
  readonly ms: number;
}

export async function run(): Promise<SuiteResult> {
  const figures: Figure[] = [];

  for (const capacity of CAPACITIES) {
    const shed: number[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: one capacity at a time, so each set of rounds runs on a quiet machine rather than beside the next
    const durations = await rounds(TIMED_ROUNDS, async (round) => {
      const burst = await offer(capacity, round);
      if (round >= WARMUP_ROUNDS) {
        shed.push((burst.rejected / OFFERED) * 100);
      }
      return burst.ms;
    });

    figures.push(
      figure(`capacity ${capacity}: shed`, "%", "neither", shed, {
        offered: OFFERED,
      }),
      figure(`capacity ${capacity}: burst settled`, "ms", "lower", durations)
    );
  }

  return { suite: NAME, figures };
}

/** One burst: offer everything at once, then wait for every answer, accept or refuse. */
async function offer(capacity: number, round: number): Promise<Burst> {
  const ekman = new Ekman({ entities: [counters], inbox: { capacity } });
  const handle = ekman.entities.counters;
  const id = `c${capacity}r${round}`;

  try {
    let accepted = 0;
    let rejected = 0;

    const ms = await elapsed(async () => {
      const all: Promise<void>[] = [];
      for (let i = 0; i < OFFERED; i += 1) {
        all.push(
          handle.send(id, { type: "tick" }).then(
            () => {
              accepted += 1;
            },
            (error: unknown) => {
              check(
                isEkmanError(error) && error.code === "INBOX_OVERFLOW",
                `a send failed for a reason other than overflow: ${String(error)}`
              );
              rejected += 1;
            }
          )
        );
      }
      await Promise.all(all);
    });

    check(
      accepted + rejected === OFFERED,
      `${accepted} accepted plus ${rejected} rejected is not the ${OFFERED} offered`
    );
    check(
      handle.inspect(id)?.values.n === accepted,
      "committed count does not match the accepted count"
    );

    return { accepted, rejected, ms };
  } finally {
    await ekman.close();
  }
}
