// The README quickstart, reduced to its assertions.
//
// verify-package.mjs writes this into a throwaway project three times: once as
// probe.mjs to run under ESM, once as an ESM .ts file and once wrapped in an
// async function as a CJS .ts file, both compiled under NodeNext. Keeping it
// here rather than as string literals inside the script means it stays readable
// and the published example stays checkable: if the README's code stops working
// against the published package, this fails.
//
// It must be valid as both plain JavaScript and TypeScript, so no annotations. The
// README declares a trigger union and uses defineEntity.withTriggers; a type alias is
// not JavaScript, so this stays on plain defineEntity. Without the union a trigger's
// fields are unknown, so a handler names the state it moves to and a probe carries only
// whether it succeeded.
import { defineEntity, Ekman, patch, stay, transitionTo } from "ekman";

const services = defineEntity("services", {
  initial: "healthy",
  values: { failures: 0 },
  states: {
    healthy: (service, trigger) => {
      if (trigger.type === "rule.matched") {
        return transitionTo("degraded");
      }
      if (trigger.type === "constraint.stale") {
        return transitionTo("unreachable");
      }
      return patch({
        failures: trigger.ok === true ? 0 : service.values.failures + 1,
      });
    },
    degraded: (_service, trigger) =>
      trigger.type === "constraint.stale"
        ? transitionTo("unreachable")
        : stay(),
    unreachable: () => stay(),
  },
  constraints: {
    rules: [
      {
        in: "healthy",
        when: (service) => service.values.failures >= 3,
        propose: "degraded",
      },
    ],
    stale: [{ after: 60_000, propose: "unreachable" }],
  },
});

let clock = 0;
const ekman = new Ekman({ entities: [services], now: () => clock });

await ekman.entities.services.send("search-api", { type: "probe", ok: true });
// Four, because the rule's proposal is queued behind the third probe's commit and the
// fourth probe is queued behind the proposal. Awaiting the fourth awaits both.
for (let sent = 0; sent < 4; sent += 1) {
  // biome-ignore lint/performance/noAwaitInLoops: one probe after another is the point
  await ekman.send("services:payments-api", { type: "probe", ok: false });
}

clock += 61_000;
await ekman.send("services:payments-api", { type: "probe", ok: false });
const escalated = await ekman.sweep();
if (escalated !== 1) {
  throw new Error(`expected one escalation, got ${escalated}`);
}

const map = await ekman.map("services");
const where = Object.entries(map.byState)
  .map(([state, entry]) => `${state}: ${entry?.keys.join(",")}`)
  .sort()
  .join("; ");
if (
  where !== "degraded: services:payments-api; unreachable: services:search-api"
) {
  throw new Error(`unexpected map: ${where}`);
}
if (map.total !== 2 || map.complete) {
  throw new Error(`unexpected map totals: ${map.total}, ${map.complete}`);
}

const known = ekman.entities.services.inspect("payments-api");
if (known?.values.failures !== 3) {
  throw new Error(`expected 3 failures, got ${known?.values.failures}`);
}

await ekman.close();
