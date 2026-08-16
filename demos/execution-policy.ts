/**
 * Execution policy: retries, timeouts and backoff belong to the runtime, not the handler.
 *
 * Run with `npm run demo:execution-policy`.
 *
 * Every handler in this file does exactly one thing: the work. None of them contains a
 * retry loop, a `setTimeout` race, a backoff calculation, or an attempt counter. Those are
 * properties of *running* a handler rather than of the domain logic inside it, and once
 * they are configuration they can be set in one place and overridden where a specific
 * thing needs something specific.
 *
 * The layering is field by field, which is the part worth seeing. A state that overrides
 * only `timeoutMs` keeps its entity's `maxAttempts`, and the entity keeps the runtime's
 * backoff. Nothing resets to a default just because something narrower was said.
 *
 * The last run is the one a naive implementation gets wrong: retries hold the key. A
 * trigger queued behind an attempt that is still retrying does not get to slip past it.
 */

import { defineEntity, Ekman, isEkmanError, transitionTo } from "ekman";

/** Attempts per key, counted by the handlers so the demo can report them. */
const attempts = new Map<string, number>();

function countAttempt(key: string): number {
  const n = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, n);
  return n;
}

const CHARGE_MS = 100;
const STATE_TIMEOUT_MS = 40;

/**
 * Runtime-wide defaults. Everything below inherits from here unless it says otherwise.
 */
const RUNTIME_POLICY = {
  maxAttempts: 2,
  timeoutMs: 500,
  backoff: { kind: "exponential", baseMs: 20, factor: 2 },
} as const;

const payments = defineEntity("payments", {
  initial: "validating",
  values: { note: "" },
  states: {
    // No override at all: 4 attempts from the entity, 500ms timeout from the runtime.
    validating: (_payment, trigger, ctx) => {
      const attempt = countAttempt(ctx.key);
      if (attempt <= (trigger.failures as number)) {
        throw new Error(`validator unavailable (attempt ${attempt})`);
      }
      return transitionTo("charging", {
        note: `validated on attempt ${attempt}`,
      });
    },

    // Overrides only `timeoutMs`. `maxAttempts` still comes from the entity, and the
    // backoff still comes from the runtime. That is the whole point of this state.
    charging: {
      handler: async (_payment, _trigger, ctx) => {
        countAttempt(ctx.key);
        await delay(CHARGE_MS);
        return transitionTo("charged", { note: "charged" });
      },
      timeoutMs: STATE_TIMEOUT_MS,
    },

    charged: (payment) => transitionTo("charged", payment.values),
  },
  // Overrides the runtime default for every state of this entity.
  policy: { maxAttempts: 4 },
});

/** No entity policy, so this one runs on the runtime's defaults exactly. */
const notifications = defineEntity("notifications", {
  initial: "sending",
  values: { note: "" },
  states: {
    sending: (_notification, _trigger, ctx) => {
      const attempt = countAttempt(ctx.key);
      throw new Error(`smtp refused (attempt ${attempt})`);
    },
  },
});

/** One line per retry, so the backoff can be read off the output. */
const retries: { key: string; attempt: number; delayMs: number }[] = [];
/** Handler starts and settles in order, for the "retries hold the key" run. */
const timeline: string[] = [];

const ekman = new Ekman({
  entities: [payments, notifications],
  execution: RUNTIME_POLICY,
  telemetry: {
    "handler.retried": (event) => {
      retries.push({
        key: event.key,
        attempt: event.attempt,
        delayMs: event.delayMs,
      });
    },
    "handler.started": (event) => {
      timeline.push(`${event.trigger.type}:start#${event.attempt}`);
    },
    "handler.settled": (event) => {
      timeline.push(`${event.trigger.type}:${event.outcome}`);
    },
  },
});

async function main(): Promise<void> {
  await layering();
  await backoff();
  await holdsTheKey();

  console.log(
    `\n${"=".repeat(78)}\n` +
      "Not one of these handlers knows how many times it ran, how long it was given, or\n" +
      "how long anything waited before trying again. That is the trade: the handler does\n" +
      "the work, the runtime decides how the work gets run, and the two stop being\n" +
      "tangled in the same function.\n"
  );

  await ekman.close();
}

/** Three effective policies, from three levels of configuration. */
async function layering(): Promise<void> {
  banner("1. Runtime, entity, state: each narrower layer overrides one field");

  console.log(
    `  runtime:            maxAttempts=${RUNTIME_POLICY.maxAttempts}  timeoutMs=${RUNTIME_POLICY.timeoutMs}  backoff=exponential(${RUNTIME_POLICY.backoff.baseMs}ms x${RUNTIME_POLICY.backoff.factor})\n` +
      "  payments entity:    maxAttempts=4      (timeout and backoff inherited)\n" +
      `  payments.charging:  timeoutMs=${STATE_TIMEOUT_MS}     (maxAttempts and backoff inherited)\n`
  );

  // Runtime default, untouched: two attempts and then it gives up.
  const note = await settled(
    ekman.entities.notifications.send("n1", { type: "send" })
  );
  report("notifications:n1", "runtime default", note, 2);

  // The entity override in force: four attempts before it gives up.
  const doomed = await settled(
    ekman.entities.payments.send("doomed", { type: "validate", failures: 99 })
  );
  report("payments:doomed", "entity override", doomed, 4);

  // Same policy, but this one recovers before it runs out.
  const flaky = await settled(
    ekman.entities.payments.send("flaky", { type: "validate", failures: 2 })
  );
  report("payments:flaky", "entity override", flaky, 3);

  // Now the state override. Get it into `charging` cleanly, then let it time out.
  await ekman.entities.payments.send("slow", {
    type: "validate",
    failures: 0,
  });
  attempts.delete("payments:slow");
  const timedOut = await settled(
    ekman.entities.payments.send("slow", { type: "charge" })
  );
  report("payments:slow", "state override", timedOut, 4);

  check(
    attempts.get("notifications:n1") === 2,
    `the runtime default did not apply: ${attempts.get("notifications:n1")} attempts, expected 2`
  );
  check(
    attempts.get("payments:doomed") === 4,
    `the entity override did not apply: ${attempts.get("payments:doomed")} attempts, expected 4`
  );
  check(
    timedOut === "HANDLER_TIMEOUT",
    `the state's ${STATE_TIMEOUT_MS}ms timeout did not apply, got ${timedOut}`
  );
  // The load-bearing assertion. The state said `timeoutMs` and nothing else, so it must
  // still be running under the entity's 4 attempts rather than falling back to the
  // runtime's 2.
  check(
    attempts.get("payments:slow") === 4,
    `the state override reset maxAttempts: ${attempts.get("payments:slow")} attempts, expected the entity's 4`
  );

  console.log(
    "\n  `payments.charging` set one field and kept the other two. Four attempts, each\n" +
      `  abandoned after ${STATE_TIMEOUT_MS}ms rather than the runtime's ${RUNTIME_POLICY.timeoutMs}ms.`
  );
}

/** The gaps between attempts, read straight out of telemetry. */
async function backoff(): Promise<void> {
  banner("2. The waits between attempts");

  const doomed = retries.filter((r) => r.key === "payments:doomed");
  for (const retry of doomed) {
    console.log(
      `    attempt ${retry.attempt} failed, waiting ${retry.delayMs}ms before the next`
    );
  }

  const delays = doomed.map((r) => r.delayMs);
  check(
    delays.join(",") === "20,40,80",
    `expected exponential 20,40,80 from the runtime backoff, got ${delays.join(",")}`
  );

  console.log(
    "\n  20, 40, 80: the runtime's exponential backoff, inherited by an entity that\n" +
      "  overrode `maxAttempts` and by a state that overrode `timeoutMs`. Neither of them\n" +
      "  mentioned backoff, so neither of them changed it."
  );

  await Promise.resolve();
}

/** A trigger queued behind a retrying attempt waits for it. */
async function holdsTheKey(): Promise<void> {
  banner("3. Retries keep the key occupied");

  timeline.length = 0;

  // Two triggers at one key. The first will retry four times over roughly 140ms of
  // backoff; the second is sent immediately behind it and must not interleave.
  const first = settled(
    ekman.entities.payments.send("held", { type: "first", failures: 99 })
  );
  const second = settled(
    ekman.entities.payments.send("held", { type: "second", failures: 0 })
  );

  await Promise.all([first, second]);

  console.log("  handler activity, in order:\n");
  for (const entry of timeline) {
    console.log(`    ${entry}`);
  }

  const firstSettled = timeline.indexOf("first:failed");
  const secondStarted = timeline.findIndex((entry) =>
    entry.startsWith("second:start")
  );

  check(firstSettled !== -1, "the first trigger never settled");
  check(secondStarted !== -1, "the second trigger never ran");
  check(
    secondStarted > firstSettled,
    "the queued trigger started before the retrying attempt had finished"
  );
  check(
    timeline.filter((entry) => entry.startsWith("first:start")).length === 4,
    "the first trigger did not use all four attempts"
  );

  console.log(
    "\n  Four attempts, then the queued trigger. Nothing enforces that separately: a\n" +
      "  retry loop runs inside the turn the inbox already granted, so a waiting trigger\n" +
      "  has no way in until the whole thing is done. An implementation that retried\n" +
      "  outside its per-key lock would pass every other check on this page and fail\n" +
      "  this one."
  );
}

function report(
  key: string,
  layer: string,
  outcome: string,
  expected: number
): void {
  console.log(
    `    ${key.padEnd(18)} ${layer.padEnd(16)} ${String(attempts.get(key)).padStart(2)} attempts (expected ${expected})  -> ${outcome}`
  );
}

async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "committed";
  } catch (error) {
    return isEkmanError(error) ? error.code : String(error);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
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
