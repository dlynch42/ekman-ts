/**
 * No going backwards: a redelivered message must not rewind an order.
 *
 * Run with `npm run demo:no-going-backwards`.
 *
 * Queues redeliver. A `payment.received` that was already handled shows up again an hour
 * later, and a handler written to "just apply the message" cheerfully walks a shipped order
 * back to paid. Nothing crashes. Nobody notices until the numbers stop adding up.
 *
 * The handler below is exactly that naive: it maps a message type to a state and commits.
 * It is identical in all three runs. The only thing that changes is the transition graph,
 * which is what makes the lifecycle a rule rather than a hope.
 */

import type { Handler } from "ekman";
import { defineEntity, Ekman, stay, transitionTo } from "ekman";
import { stream } from "./lib";

type State = "pending" | "paid" | "shipped" | "delivered" | "cancelled";

interface Values extends Record<string, unknown> {
  total: number;
  lastEvent: string;
}

/** Which state each message is asking for. */
const TARGET: Partial<Record<string, State>> = {
  "payment.received": "paid",
  "shipment.dispatched": "shipped",
  "shipment.delivered": "delivered",
  "order.cancelled": "cancelled",
};

/**
 * The handler under test, and the point of the demo: it is not defensive at all.
 *
 * It does not know what state it is in, what came before, or whether it has seen this
 * message already. Real handlers look like this, because the alternative is every handler
 * re-deriving the lifecycle from first principles and getting it subtly wrong.
 */
const apply: Handler<State, Values> = (order, trigger) => {
  const target = TARGET[trigger.type];
  if (target === undefined) {
    return stay(order.values);
  }
  return transitionTo(target, { ...order.values, lastEvent: trigger.type });
};

const states = {
  pending: apply,
  paid: apply,
  shipped: apply,
  delivered: apply,
  cancelled: apply,
};

/** The real lifecycle. Everything not named here is a move that should never happen. */
const FORWARD_ONLY = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: ["delivered"],
  // Terminal. Nothing leaves.
  delivered: [],
  cancelled: [],
} as const;

/**
 * What the order actually lived through, including the redelivery.
 *
 * Steps 3 and 4 are the interesting ones: a duplicate payment that arrives after shipping,
 * and a cancellation for an order that has already left the building.
 */
const INCOMING = [
  { type: "payment.received", note: "the real payment" },
  { type: "shipment.dispatched", note: "off it goes" },
  { type: "payment.received", note: "REDELIVERED an hour later" },
  { type: "order.cancelled", note: "support cancels an order already shipped" },
  { type: "shipment.delivered", note: "signed for" },
];

async function main(): Promise<void> {
  await run(
    "1. No constraints: the redelivery rewinds the order",
    undefined,
    "Nothing failed. The order went backwards and then got cancelled after delivery,\n" +
      "  and the only record that anything was wrong is that the states stopped making sense."
  );

  await run(
    "2. warn: discover the real graph without blocking anything",
    "warn",
    "Same outcome as run 1, on purpose: warn records and lets through, so you can read\n" +
      "  what your traffic actually does before you start refusing any of it.\n\n" +
      "  Look at the second violation. It is cancelled -> delivered, not shipped ->\n" +
      "  cancelled, because the rewind at step 3 had already put the order back in paid,\n" +
      "  where cancelling IS legal. One accepted illegal move makes the next one look\n" +
      "  fine. That compounding is the argument for not staying in warn."
  );

  await run(
    "3. reject: the order cannot go backwards",
    "reject",
    "The redelivery and the late cancellation were both refused, the order never left\n" +
      "  shipped, and delivery still worked. Both violations sit at seq 2 because a\n" +
      "  refused result is not a commit and does not advance the sequence: it carries the\n" +
      "  sequence it was refused at."
  );

  console.log(
    `\n${"=".repeat(78)}\n` +
      "The handler was identical in all three runs, and wrong in all three runs.\n" +
      "What changed is whether the lifecycle was written down somewhere the runtime\n" +
      "could enforce it.\n"
  );
}

async function run(
  title: string,
  policy: "warn" | "reject" | undefined,
  moral: string
): Promise<void> {
  const orders = defineEntity("orders", {
    initial: "pending",
    values: { total: 4200, lastEvent: "none" } as Values,
    states,
    ...(policy === undefined
      ? {}
      : { constraints: { transitions: { policy, allow: FORWARD_ONLY } } }),
  });

  const ekman = new Ekman({ entities: [orders] });

  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);

  for (const message of INCOMING) {
    // biome-ignore lint/performance/noAwaitInLoops: this is a queue consumer, one message at a time, which is the situation being demonstrated
    const outcome = await deliver(ekman, message.type);
    console.log(
      `  ${message.type.padEnd(21)} ${outcome.padEnd(34)} ${message.note}`
    );
  }

  const final = ekman.entities.orders.inspect("a1");
  console.log(`\n  final state: ${final?.state}  (seq ${final?.seq})`);

  const { events } = await ekman.entities.orders.history("a1");

  // The whole stream, not just the violations: what makes this legible is that the
  // refused moves sit in the same ordered record as the ones that landed, at the sequence
  // they were refused at.
  console.log("");
  stream("orders:a1", events);

  console.log(`\n  ${moral}`);
  await ekman.close();
}

/**
 * Deliver one message and report what became of it, the way a consumer would.
 *
 * A refusal arrives as a rejected promise carrying a stable code, so a consumer can tell
 * "this will never work, stop redelivering it" from "the handler broke, try again".
 */
async function deliver(ekman: Ekman, type: string): Promise<string> {
  try {
    const result = await ekman.send("orders:a1", { type });
    return `committed -> ${result.state}`;
  } catch (error) {
    const failure = error as { code?: string; constraint?: string };
    return failure.code === "CONSTRAINT_VIOLATED"
      ? `REFUSED (${failure.constraint})`
      : `failed (${failure.code})`;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
