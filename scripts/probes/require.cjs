"use strict";
// The CJS runtime probe: proves `require("ekman")` resolves through the exports
// map and hands back a working runtime, not just an object with the right keys.
const ekman = require("ekman");

const expected = [
  "Ekman",
  "defineEntity",
  "transitionTo",
  "stay",
  "isTransitionEvent",
];
const missing = expected.filter((name) => typeof ekman[name] !== "function");
if (missing.length > 0) {
  throw new Error(`require("ekman") is missing: ${missing.join(", ")}`);
}

const store = require("ekman/store");
if (typeof store.replay !== "function") {
  throw new Error('require("ekman/store") did not hand back replay');
}

const printed = String(new ekman.EkmanError("INVALID_KEY", "x"));
if (
  ekman.EkmanError.name !== "EkmanError" ||
  !printed.startsWith("EkmanError:")
) {
  throw new Error(`an EkmanError prints as "${printed}"`);
}

const orders = ekman.defineEntity("orders", {
  initial: "pending",
  states: {
    pending: (order) => ekman.stay(order.values),
  },
});

const runtime = new ekman.Ekman({ entities: [orders] });

runtime
  .send("orders:a-1", { type: "poke" })
  .then((committed) => {
    if (committed.state !== "pending") {
      throw new Error(`expected pending, got ${committed.state}`);
    }
    return runtime.close();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
