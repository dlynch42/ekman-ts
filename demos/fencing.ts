/**
 * Zombie fencing: a handler that ignores its timeout cannot corrupt anything.
 *
 * Run with `npm run demo:fencing`.
 *
 * A running JavaScript function cannot be stopped. Not by a timeout, not by an
 * `AbortController`, not by anything: if the function does not check, it keeps going. So
 * "we time out slow handlers" is, on its own, a promise no runtime in this language can
 * keep. The handler is still out there, still holding the values it read, and it will
 * eventually come back and try to write them.
 *
 * The answer is not to stop it. It is to make its result unusable. Every attempt carries a
 * commit token bound to the sequence it was dispatched at, and a timeout invalidates that
 * token. The abandoned handler runs to completion, tries to commit, and is refused at the
 * gate.
 *
 * The second run is the honest counterpart. If a commit has already reached the store when
 * the timeout fires, it stands, and the sender is told it timed out. That is a real window,
 * it is reported as `commit.raced`, and pretending it does not exist would be worse than
 * explaining it.
 */

import type { EkmanEvent, ScanCriteria, Store, StoreSnapshot } from "ekman";
import {
  createStore,
  defineEntity,
  Ekman,
  isEkmanError,
  transitionTo,
} from "ekman";
import { banner, check, delay, stream } from "./lib";

interface Values extends Record<string, unknown> {
  amount: number;
  /** Set only by the handler, so seeing it means a zombie's write landed. */
  chargedBy: string;
}

const TIMEOUT_MS = 30;
const ZOMBIE_MS = 120;
const STORE_LAG_MS = 60;

/** Observed inside the zombie after it wakes, purely so the demo can report it. */
let sawAbort = false;

const payments = defineEntity("payments", {
  initial: "charging",
  values: { amount: 4200, chargedBy: "nobody" } as Values,
  states: {
    // Deliberately uncooperative: it is handed a signal and never looks at it until the
    // work is already done. This is the handler every codebase actually contains.
    charging: async (payment, _trigger, ctx) => {
      await delay(ZOMBIE_MS);
      sawAbort = ctx.signal.aborted;
      return transitionTo("charged", {
        ...payment.values,
        chargedBy: "the zombie",
      });
    },
    charged: (payment) => transitionTo("charged", payment.values),
  },
});

/**
 * For the second run: the handler is instant, so the store is the only thing that can run
 * past the timeout, which puts the timer and the append in flight at the same moment.
 */
const quick = defineEntity("quick", {
  initial: "open",
  values: { note: "" },
  states: { open: () => transitionTo("open", { note: "committed" }) },
});

async function main(): Promise<void> {
  await fenced();
  await raced();

  console.log(
    `\n${"=".repeat(78)}\n` +
      "A timeout does two things, and it needs both. It aborts `ctx.signal`, which is\n" +
      "all a cooperative handler needs, and it invalidates the attempt's commit token,\n" +
      "which is what covers every handler that does not cooperate. The first is a\n" +
      "courtesy. The second is the guarantee.\n"
  );
}

/** The abandoned handler finishes, tries to commit, and is refused. */
async function fenced(): Promise<void> {
  banner("1. The handler ignores its timeout and keeps running");

  let fencedEvent: { tokenSeq: number; currentSeq: number } | undefined;

  // The interesting moment happens after the sender has already been told. Without
  // something to wait on, the process would exit before the zombie ever came back.
  let settleZombie: () => void = () => undefined;
  const zombieSettled = new Promise<void>((resolve) => {
    settleZombie = resolve;
  });

  const ekman = new Ekman({
    entities: [payments],
    execution: { timeoutMs: TIMEOUT_MS, maxAttempts: 1 },
    telemetry: {
      "handler.timedOut": (event) => {
        console.log(
          `    telemetry  handler.timedOut   after ${event.timeoutMs}ms, attempt ${event.attempt}`
        );
      },
      "commit.fenced": (event) => {
        console.log(
          `    telemetry  commit.fenced      reason=${event.reason} token was at seq ${event.tokenSeq}, instance is at seq ${event.currentSeq}`
        );
        fencedEvent = {
          tokenSeq: event.tokenSeq,
          currentSeq: event.currentSeq,
        };
        settleZombie();
      },
    },
  });

  console.log(`  handler sleeps ${ZOMBIE_MS}ms, timeout is ${TIMEOUT_MS}ms\n`);

  const outcome = await settled(
    ekman.entities.payments.send("p1", { type: "charge" })
  );
  console.log(`\n  the sender was told: ${outcome}`);

  const afterTimeout = ekman.entities.payments.inspect("p1");
  console.log(
    `  at that moment:      state=${afterTimeout?.state} seq=${afterTimeout?.seq} chargedBy=${afterTimeout?.values.chargedBy}`
  );

  console.log(
    `\n  now waiting for the abandoned handler to finish its ${ZOMBIE_MS}ms and try to commit...\n`
  );
  await zombieSettled;

  const after = ekman.entities.payments.inspect("p1");
  console.log(
    `\n  after the zombie settled: state=${after?.state} seq=${after?.seq} chargedBy=${after?.values.chargedBy}`
  );
  console.log(
    `  the zombie did see ctx.signal.aborted === ${sawAbort}, it just looked too late`
  );

  // The record is the proof. A commit the fence refused is not in it, so the stream shows
  // the instance exactly where it started rather than somewhere a zombie put it.
  const { events } = await ekman.entities.payments.history("p1");
  console.log("");
  stream("payments:p1", events);
  console.log(
    "    ^ nothing from the abandoned attempt, because its commit never happened"
  );

  check(outcome === "HANDLER_TIMEOUT", `expected a timeout, got ${outcome}`);
  check(
    fencedEvent !== undefined,
    "the zombie's commit was never fenced, so it was never even attempted"
  );
  check(
    after?.state === afterTimeout?.state && after?.seq === afterTimeout?.seq,
    `the instance moved after the zombie settled: ${afterTimeout?.state}@${afterTimeout?.seq} became ${after?.state}@${after?.seq}`
  );
  // Still where it started. Seq 0 is the initialization commit, so nothing the handler
  // produced was ever applied.
  check(
    after?.state === "charging" && after?.seq === 0,
    `the instance left its initial state: ${after?.state}@${after?.seq}`
  );
  check(
    after?.values.chargedBy === "nobody",
    "the zombie's values reached the instance"
  );

  console.log(
    "\n  The handler ran to completion and its result went nowhere. The instance is\n" +
      "  exactly where it was, and the only trace of the zombie is one telemetry event\n" +
      "  saying a superseded attempt showed up late."
  );

  await ekman.close();
}

/** A commit already at the store when the timeout fires. It stands, and says so. */
async function raced(): Promise<void> {
  banner("2. The other side of it: a commit that was already durable");

  let racedSeq: number | undefined;

  // Same shape as the fence: the append is still in flight when the sender is told, so
  // the outcome the demo is about happens after the `await` on `send` has already
  // returned. Something has to wait for it.
  let settleRace: () => void = () => undefined;
  const raceSettled = new Promise<void>((resolve) => {
    settleRace = resolve;
  });

  const ekman = new Ekman({
    entities: [quick],
    store: lagging(createStore("memory"), STORE_LAG_MS),
    execution: { timeoutMs: TIMEOUT_MS, maxAttempts: 1 },
    telemetry: {
      "commit.raced": (event) => {
        console.log(
          `    telemetry  commit.raced       the commit landed at seq ${event.seq} anyway`
        );
        racedSeq = event.seq;
        settleRace();
      },
    },
  });

  console.log(
    `  handler is instant, the store takes ${STORE_LAG_MS}ms, timeout is still ${TIMEOUT_MS}ms\n`
  );

  const outcome = await settled(
    ekman.entities.quick.send("q1", { type: "go" })
  );
  console.log(`\n  the sender was told: ${outcome}`);
  console.log("  waiting for the append that was already in flight...\n");
  await raceSettled;

  const after = ekman.entities.quick.inspect("q1");
  console.log(`  the instance:        state=${after?.state} seq=${after?.seq}`);

  check(outcome === "HANDLER_TIMEOUT", `expected a timeout, got ${outcome}`);
  check(
    racedSeq !== undefined,
    "the commit did not race the timeout, so this run proved nothing"
  );
  check(
    after?.seq === racedSeq,
    `the raced commit at seq ${racedSeq} is not where the instance ended up (${after?.seq})`
  );

  console.log(
    "\n  This one committed. It had already reached the store when the timer fired, and\n" +
      "  un-writing a durable append is not something a runtime gets to do. The sender\n" +
      '  still hears HANDLER_TIMEOUT, which is why the answer to "did it land?" is\n' +
      "  `commit.raced` and a read, not a guess. A sustained rate of this means the\n" +
      "  timeout is set too close to how long the store actually takes."
  );

  await ekman.close();
}

/**
 * The same store, with a slow append.
 *
 * Delegating explicitly rather than spreading, because an adapter is a class instance and
 * its methods live on the prototype where a spread will not find them.
 */
function lagging(base: Store, ms: number): Store {
  return {
    name: `${base.name}+lag`,
    capabilities: base.capabilities,
    append: async (key: string, event: EkmanEvent, expectedSeq: number) => {
      await delay(ms);
      await base.append(key, event, expectedSeq);
    },
    load: (key: string) => base.load(key),
    read: (key: string) => base.read(key),
    snapshot: (key: string, snapshot: StoreSnapshot) =>
      base.snapshot(key, snapshot),
    scan: (criteria: ScanCriteria) => base.scan(criteria),
  };
}

/** The error code, or `committed`, so both outcomes print the same way. */
async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "committed";
  } catch (error) {
    return isEkmanError(error) ? error.code : String(error);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
