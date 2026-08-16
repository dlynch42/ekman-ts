/**
 * Ordering: many triggers, one key, and no coordination anywhere in the handler.
 *
 * Run with `npm run demo:ordering`.
 *
 * The handler below contains the oldest race in the book. It reads a counter, does some
 * work, and writes the counter back. Written against a plain map, or a row, or a cache
 * entry, five concurrent triggers would interleave their reads and writes and some of the
 * increments would simply vanish. That is not a hypothetical: it is what
 * read-modify-write does the moment two callers arrive at once.
 *
 * There is no lock here. No mutex, no transaction, no compare-and-set, no `Promise` the
 * author had to chain by hand. Serialization is a property of the key, so the naive
 * handler is the correct handler.
 *
 * The second run shows the other half of that promise: the queue behind a key is bounded,
 * and when it fills the sender is told rather than being made to wait forever.
 */

import { defineEntity, Ekman, isEkmanError, stay } from "ekman";

interface Values extends Record<string, unknown> {
  /** Total triggers this instance has committed. */
  handled: number;
  /** What the handler read on the way in, before it did any work. */
  observed: number;
  /** Which trigger produced this commit. */
  by: string;
}

const INITIAL: Values = { handled: 0, observed: -1, by: "none" };

/**
 * Read, work, write. The read happens before the `await` and the write after it, which is
 * exactly the window a concurrent handler would slip through.
 *
 * `observed` is kept in the committed values on purpose: it is the handler's own record of
 * what it saw, so the assertions at the end can check what each attempt read rather than
 * only what the sequence looks like afterwards.
 */
const work = defineEntity("work", {
  initial: "running",
  values: INITIAL,
  states: {
    running: async (job, trigger) => {
      const observed = job.values.handled;
      await delay(trigger.workMs as number);
      return stay({ handled: observed + 1, observed, by: trigger.type });
    },
  },
});

const SLOW_MS = 30;
const BURST = 5;
const FAST_KEYS = ["fast-a", "fast-b", "fast-c"];

async function main(): Promise<void> {
  await ordering();
  await backpressure();

  console.log(
    `\n${"=".repeat(78)}\n` +
      "The handler did a read-modify-write with an await in the middle and never lost\n" +
      "an update, because the two things that would have made it lose one, a second\n" +
      "handler on the same key and an unbounded queue in front of it, are both things\n" +
      "the runtime does not allow.\n"
  );
}

/** Five triggers at one slow key, three unrelated keys alongside. */
async function ordering(): Promise<void> {
  banner("1. One slow key, five triggers, three unrelated keys alongside");

  const ekman = new Ekman({ entities: [work], inbox: { capacity: 16 } });
  const handle = ekman.entities.work;

  /** Completion order, appended to as each send resolves. */
  const finished: string[] = [];
  const note = <T>(label: string, promise: Promise<T>): Promise<T> =>
    promise.then((value) => {
      finished.push(label);
      return value;
    });

  // Nothing is awaited here. All eight triggers are in flight before the first handler
  // has finished, which is the situation the whole demo is about.
  const slow = Array.from({ length: BURST }, (_, i) =>
    note(
      `slow#${i + 1}`,
      handle.send("slow", { type: `t${i + 1}`, workMs: SLOW_MS })
    )
  );
  const fast = FAST_KEYS.map((key) =>
    note(key, handle.send(key, { type: "ping", workMs: 0 }))
  );

  const committed = await Promise.all(slow);
  await Promise.all(fast);

  console.log("  the slow key, in the order the triggers were sent:\n");
  for (const [i, result] of committed.entries()) {
    const { values } = result;
    console.log(
      `    trigger ${i + 1}  read handled=${values.observed}  wrote handled=${values.handled}  seq=${result.seq}`
    );
  }

  console.log(`\n  completion order: ${finished.join(", ")}`);

  const final = handle.inspect("slow");
  console.log(`\n  final: handled=${final?.values.handled} seq=${final?.seq}`);

  // Every increment landed. Under a real race this is the number that comes up short.
  check(
    final?.values.handled === BURST,
    `${BURST} triggers committed but handled=${final?.values.handled}: an update was lost`
  );

  // Each handler read exactly what the one before it wrote. This is the strong claim:
  // not merely that the commits are ordered, but that each handler *ran* after the
  // previous one committed rather than merely being written down after it.
  for (const [i, result] of committed.entries()) {
    check(
      result.values.observed === i,
      `trigger ${i + 1} read handled=${result.values.observed}, expected ${i}: it did not see the previous commit`
    );
    check(
      result.seq === i + 1,
      `trigger ${i + 1} committed at seq ${result.seq}, expected ${i + 1}: the sequence has a gap`
    );
  }

  // The fast keys were not stuck behind the slow one. A runtime that serialized globally
  // rather than per key would finish them last.
  const lastSlow = finished.lastIndexOf(`slow#${BURST}`);
  for (const key of FAST_KEYS) {
    check(
      finished.indexOf(key) < lastSlow,
      `${key} finished after the slow key was done, so it was queued behind it`
    );
  }

  console.log(
    "\n  Each trigger read exactly what the one before it wrote, and the unrelated keys\n" +
      "  finished while the slow one was still working. One key is a queue; the runtime\n" +
      "  is not."
  );

  await ekman.close();
}

/** The same burst against a queue too small to hold it. */
async function backpressure(): Promise<void> {
  banner("2. The same burst, against a queue with room for two");

  let rejectedByTelemetry = 0;
  const ekman = new Ekman({
    entities: [work],
    inbox: { capacity: 2, overflow: "reject" },
    telemetry: {
      "inbox.rejected": (event) => {
        rejectedByTelemetry += 1;
        console.log(
          `    telemetry  inbox.rejected  ${event.key}  depth=${event.depth}/${event.capacity}`
        );
      },
    },
  });

  const outcomes = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      ekman.entities.work.send("busy", { type: `t${i + 1}`, workMs: SLOW_MS })
    )
  );

  console.log("");
  for (const [i, outcome] of outcomes.entries()) {
    console.log(
      `    trigger ${i + 1}  ${outcome.status === "fulfilled" ? `committed at seq ${outcome.value.seq}` : `REFUSED (${codeOf(outcome.reason)})`}`
    );
  }

  const refused = outcomes.filter((o) => o.status === "rejected");
  check(
    refused.length === 1,
    `expected exactly one refusal, got ${refused.length}`
  );
  check(
    refused.every((o) => codeOf(o.reason) === "INBOX_OVERFLOW"),
    "the refusal did not carry INBOX_OVERFLOW"
  );
  check(
    rejectedByTelemetry === 1,
    `the refusal was not visible in telemetry (saw ${rejectedByTelemetry})`
  );

  console.log(
    "\n  The first trigger went straight to the handler, two waited, and the fourth was\n" +
      "  refused on arrival with a code its sender can act on. Nothing was silently\n" +
      "  dropped and nothing queued without bound: overload became backpressure rather\n" +
      "  than latency."
  );

  await ekman.close();
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function codeOf(error: unknown): string {
  return isEkmanError(error) ? error.code : String(error);
}

function banner(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
