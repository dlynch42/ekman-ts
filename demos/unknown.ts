/**
 * Unknown is never silent.
 *
 * Run with `npm run demo:unknown`.
 *
 * The default behaviour of most dispatch code, when handed something it does not
 * recognize, is nothing. A `switch` with no `default`. An `if` chain that falls off the
 * end. A map lookup returning undefined into a function that shrugs. The message is
 * consumed, the producer is told it succeeded, and the instance sits exactly where it was
 * while everyone downstream assumes it moved.
 *
 * There is no configuration here that turns that on. A trigger that reaches no handler is
 * refused to its sender with a code, and recorded in the instance's own stream, always.
 *
 * The second run is the version of this that actually happens in production: nobody sends
 * a nonsense message on purpose, but a deploy removes a state that persisted instances are
 * still sitting in.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { EkmanEvent } from "ekman";
import {
  defaultLogDir,
  defineEntity,
  Ekman,
  fileStore,
  isEkmanError,
  stay,
  transitionTo,
} from "ekman";

// A named directory rather than a temporary one, cleared on the way in rather than out, so
// the log this demo wrote is still there to read when it finishes. Its own subdirectory, so
// clearing it can never reach anything another demo or the example app put there.
const dir = join(defaultLogDir(), "demos", "unknown");
rmSync(dir, { recursive: true, force: true });

async function main(): Promise<void> {
  console.log(`store: ${dir}\n`);
  await undeclaredTrigger();
  await theStateThatGotRenamed();

  console.log(
    `\n${"=".repeat(78)}\n` +
      "Neither of these is an exotic failure. One is a producer sending something the\n" +
      "consumer never agreed to; the other is an ordinary deploy. What makes them\n" +
      "survivable is that both are loud: the sender got an error it can act on, and the\n" +
      "instance carries a record of exactly what showed up and was turned away.\n"
  );
}

/** A trigger type the entity never agreed to handle. */
async function undeclaredTrigger(): Promise<void> {
  banner("1. A message nobody agreed to");

  const orders = defineEntity("orders", {
    initial: "pending",
    values: { approvedBy: "" },
    // The contract. Anything not on this list never reaches a handler.
    triggers: ["approve", "cancel"],
    states: {
      pending: (order, trigger) =>
        trigger.type === "approve"
          ? transitionTo("approved", {
              approvedBy: trigger.actor as string,
            })
          : transitionTo("cancelled", order.values),
      approved: (order) => stay(order.values),
      cancelled: (order) => stay(order.values),
    },
  });

  const ekman = new Ekman({ entities: [orders] });
  const handle = ekman.entities.orders;

  console.log("  declared triggers: approve, cancel\n");

  const good = await settled(
    handle.send("a1", { type: "approve", actor: "amy" })
  );
  console.log(`  { type: "approve" }   ${good}`);

  const bad = await settled(
    handle.send("a1", { type: "aprove", actor: "amy" })
  );
  console.log(
    `  { type: "aprove" }    ${bad}   <- a typo in a producer, an hour into a deploy`
  );

  const after = handle.inspect("a1");
  console.log(`\n  the instance: state=${after?.state} seq=${after?.seq}`);

  check(good === "committed", `the valid trigger did not commit: ${good}`);
  check(
    bad === "UNKNOWN_TRIGGER",
    `the typo was not refused as UNKNOWN_TRIGGER: ${bad}`
  );
  check(
    after?.state === "approved" && after?.seq === 1,
    `the refused trigger moved the instance: ${after?.state}@${after?.seq}`
  );

  const { events } = await handle.history("a1");
  console.log("\n  and its stream:");
  for (const event of events) {
    console.log(`    ${describe(event)}`);
  }

  const rejected = events.filter((event) => event.type === "rejected");
  check(
    rejected.length === 1,
    `expected one recorded rejection, found ${rejected.length}`
  );

  console.log(
    "\n  The refusal is in the instance's own history, at the sequence it was refused at,\n" +
      "  naming the trigger that caused it. Not a log line somewhere else: the same\n" +
      '  ordered stream as the transitions, so "what has been thrown at this order" is\n' +
      '  the same question as "what has this order done".'
  );

  await ekman.close();
}

/** The realistic one: a state that existed last week. */
async function theStateThatGotRenamed(): Promise<void> {
  banner("2. A deploy that removed a state instances were sitting in");

  // Last week's code. `archived` is a real state with a real handler.
  const v1 = defineEntity("tickets", {
    initial: "open",
    values: { title: "" },
    states: {
      open: (ticket, trigger) =>
        trigger.type === "archive"
          ? transitionTo("archived", ticket.values)
          : stay(ticket.values),
      archived: (ticket) => stay(ticket.values),
    },
  });

  const before = new Ekman({ entities: [v1], store: fileStore(dir) });
  await before.entities.tickets.send("t1", { type: "archive" });
  await before.entities.tickets.send("t2", { type: "poke" });
  console.log(
    `  before the deploy:  t1=${before.entities.tickets.inspect("t1")?.state}  t2=${before.entities.tickets.inspect("t2")?.state}`
  );
  await before.close();

  // This week's code. Somebody folded `archived` into a wider `closed` state and did not
  // think about the instances already sitting in the old one. They are still on disk.
  const v2 = defineEntity("tickets", {
    initial: "open",
    values: { title: "" },
    states: {
      open: (ticket) => stay(ticket.values),
      closed: (ticket) => stay(ticket.values),
    },
  });

  const after = new Ekman({ entities: [v2], store: fileStore(dir) });
  const handle = after.entities.tickets;
  console.log("  after the deploy:   states are now open, closed\n");

  const stranded = await settled(handle.send("t1", { type: "poke" }));
  const fine = await settled(handle.send("t2", { type: "poke" }));

  console.log(`  t1 (in "archived")  ${stranded}`);
  console.log(`  t2 (in "open")      ${fine}`);

  const t1 = handle.inspect("t1");
  console.log(
    `\n  t1 is still exactly where it was: state=${t1?.state} seq=${t1?.seq}`
  );

  check(
    stranded === "UNKNOWN_STATE",
    `the stranded instance was not refused as UNKNOWN_STATE: ${stranded}`
  );
  check(fine === "committed", `the healthy instance was disturbed: ${fine}`);
  // Compared as a string on purpose. `archived` is not in this deploy's state union, so
  // the compiler is right that the comparison looks impossible. That gap between what the
  // code knows and what the store holds is the entire situation being demonstrated.
  check(
    String(t1?.state) === "archived",
    `the stranded instance was moved or reset: ${t1?.state}`
  );

  const { events } = await handle.history("t1");
  console.log("\n  t1's stream, across both deploys:");
  for (const event of events) {
    console.log(`    ${describe(event)}`);
  }

  check(
    events.some((event) => event.type === "rejected"),
    "the refusal was not recorded on the stranded instance"
  );

  console.log(
    "\n  Nothing was migrated, nothing was guessed at, and nothing was quietly reset to\n" +
      "  the initial state, which is the repair that would have destroyed the evidence.\n" +
      "  The instance is intact, the refusal is on its record, and `query({ entity:\n" +
      '  "tickets", state: "archived" })` will tell you how many more of these you have.'
  );

  await after.close();
}

/** One readable line per stream event. */
function describe(event: EkmanEvent): string {
  if (event.type === "transition") {
    return `transition  ${event.from ?? "(new)"} -> ${event.to}  (seq ${event.seq})`;
  }
  if (event.type === "rejected") {
    return `REJECTED    ${event.code}  trigger "${event.cause.type}"  (seq ${event.seq})`;
  }
  return `${event.type}  (seq ${event.seq})`;
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
