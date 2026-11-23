/**
 * Long history: whether a commit costs the same on a key's hundred-thousandth event as on
 * its first.
 *
 * Run with `npm run bench:long-history`.
 *
 * One key, a memory store, and a long run of commits, timed in two windows: the first
 * stretch and the last. A commit path that does any work proportional to how much history
 * the key already has shows up as the second window being slower than the first, and the
 * ratio between them is the figure that matters. Either window alone would look healthy.
 *
 * Fewer rounds than the other suites, because one round is the whole run and a run that
 * degrades is slow by definition. Each round yields two windows, so they are collected by
 * the body and the warmup rounds, which `rounds` also passes through it, are sliced off.
 */

import { defineEntity, Ekman, stay } from "ekman";
import {
  check,
  elapsed,
  figure,
  opsPerSec,
  rounds,
  type SuiteResult,
} from "./lib";

export const NAME = "long-history";

const TOTAL_COMMITS = 100_000;
const WINDOW = 20_000;
const TIMED = 3;

const counting = defineEntity("counting", {
  initial: "open",
  values: { n: 0 },
  states: {
    open: (instance) => stay({ n: instance.values.n + 1 }),
  },
});

export async function run(): Promise<SuiteResult> {
  const first: number[] = [];
  const last: number[] = [];

  await rounds(TIMED, async (round) => {
    const ekman = new Ekman({ entities: [counting], store: "memory" });
    const id = `r${round}`;
    const send = () => ekman.entities.counting.send(id, { type: "tick" });

    try {
      const head = await timed(send, WINDOW);
      await repeat(send, TOTAL_COMMITS - 2 * WINDOW);
      const tail = await timed(send, WINDOW);

      check(
        ekman.entities.counting.inspect(id)?.seq === TOTAL_COMMITS,
        `expected ${TOTAL_COMMITS} commits to land`
      );
      first.push(head);
      last.push(tail);
      return tail;
    } finally {
      await ekman.close();
    }
  });

  const firstTimed = first.slice(-TIMED);
  const lastTimed = last.slice(-TIMED);

  return {
    suite: NAME,
    figures: [
      figure(`commits 1 to ${WINDOW}`, "ops/sec", "higher", firstTimed),
      figure(
        `commits ${TOTAL_COMMITS - WINDOW + 1} to ${TOTAL_COMMITS}`,
        "ops/sec",
        "higher",
        lastTimed
      ),
      figure(
        "last window as a share of the first",
        "%",
        "higher",
        lastTimed.map((rate, i) => (rate / (firstTimed[i] ?? rate)) * 100)
      ),
    ],
    notes: [
      "The share is the claim: near 100% means a commit does not get dearer as a key's history grows.",
    ],
  };
}

async function timed(
  send: () => Promise<unknown>,
  ops: number
): Promise<number> {
  return opsPerSec(ops, await elapsed(() => repeat(send, ops)));
}

async function repeat(
  send: () => Promise<unknown>,
  ops: number
): Promise<void> {
  for (let i = 0; i < ops; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one key is fully serialized, which is the shape being measured
    await send();
  }
}
