// The README quickstart, reduced to its assertions.
//
// verify-package.mjs writes this into a throwaway project three times: once as
// probe.mjs to run under ESM, once as an ESM .ts file and once wrapped in an
// async function as a CJS .ts file, both compiled under NodeNext. Keeping it
// here rather than as string literals inside the script means it stays readable
// and the published example stays checkable: if the README's code stops working
// against the published package, this fails.
//
// It must be valid as both plain JavaScript and TypeScript, so no annotations.
import {
  defineEntity,
  Ekman,
  isTransitionEvent,
  stay,
  transitionTo,
} from "ekman";

const orders = defineEntity("orders", {
  initial: "pending",
  values: { total: 0 },
  states: {
    pending: (order, trigger) =>
      trigger.type === "pay"
        ? transitionTo("paid", { total: order.values.total + 4200 })
        : stay(order.values),
    paid: (order) => stay(order.values),
  },
});

const ekman = new Ekman({ entities: [orders] });

const committed = await ekman.send("orders:a-1", { type: "pay" });
if (committed.state !== "paid") {
  throw new Error(`expected paid, got ${committed.state}`);
}
if (committed.values.total !== 4200) {
  throw new Error(`expected 4200, got ${committed.values.total}`);
}

const { events } = await ekman.entities.orders.history("a-1");
const path = events
  .filter(isTransitionEvent)
  .map((e) => `${e.from ?? "(new)"} -> ${e.to}`)
  .join(", ");
if (path !== "(new) -> pending, pending -> paid") {
  throw new Error(`unexpected history: ${path}`);
}

await ekman.close();
