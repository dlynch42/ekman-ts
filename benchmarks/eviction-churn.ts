/**
 * Eviction churn: what a send to a new key costs once the memory budget is full.
 *
 * Run with `npm run bench:eviction-churn`.
 *
 * At the budget, every new instance pushes the coldest one out, so each send pays for one
 * eviction. That cost should not depend on how many instances are resident: finding the
 * coldest one is a question about one key. The suite fills a budget sized for a number of
 * instances, then times sends to keys it has never seen, at two sizes two orders of
 * magnitude apart. A control with no budget shows what the same sends cost with no
 * eviction at all.
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

export const NAME = "eviction-churn";

const CHURN_SENDS = 10_000;
const TIMED = 3;
const SIZES = [500, 50_000] as const;

const sessions = defineEntity("sessions", {
  initial: "open",
  values: { hits: 0 },
  states: {
    open: (instance) => stay({ hits: instance.values.hits + 1 }),
  },
});

export async function run(): Promise<SuiteResult> {
  const control = await rounds(TIMED, () => churn(undefined));
  const figures = [figure("control: no budget", "ops/sec", "higher", control)];

  for (const resident of SIZES) {
    // biome-ignore lint/performance/noAwaitInLoops: one size at a time, so each has the machine to itself
    const rates = await rounds(TIMED, () => churn(resident));
    figures.push(
      figure(
        `at the budget, ${resident.toLocaleString("en-US")} resident`,
        "ops/sec",
        "higher",
        rates
      )
    );
  }

  return {
    suite: NAME,
    figures,
    notes: [
      "The two budgeted figures should be close to each other. A gap between them is eviction cost that grows with how much is resident.",
    ],
  };
}

/**
 * Fill a budget sized for `resident` instances, then time sends to fresh keys.
 *
 * The budget is derived from what one instance is accounted at rather than assumed, so the
 * suite keeps measuring the same thing if the accounting basis changes.
 */
async function churn(resident: number | undefined): Promise<number> {
  const probe = new Ekman({ entities: [sessions], store: "memory" });
  await probe.entities.sessions.send("k00000000", { type: "hit" });
  const perInstance = probe.memoryUsage.bytes;
  await probe.close();

  const ekman = new Ekman({
    entities: [sessions],
    store: "memory",
    ...(resident === undefined
      ? {}
      : { memory: { maxBytes: perInstance * resident } }),
  });
  const send = (n: number) =>
    ekman.entities.sessions.send(`k${String(n).padStart(8, "0")}`, {
      type: "hit",
    });

  try {
    const fill = resident ?? 0;
    for (let n = 0; n < fill; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: filling in order keeps the eviction order known
      await send(n);
    }

    const ms = await elapsed(async () => {
      for (let n = fill; n < fill + CHURN_SENDS; n += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one send at a time, so each pays for exactly one eviction
        await send(n);
      }
    });

    if (resident !== undefined) {
      check(
        ekman.memoryUsage.instances <= resident,
        `${ekman.memoryUsage.instances} instances resident under a budget for ${resident}`
      );
    }
    return opsPerSec(CHURN_SENDS, ms);
  } finally {
    await ekman.close();
  }
}
