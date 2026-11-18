# Handlers that own external resources

[Back to the docs index](./README.md)

A handler that only computes the next values has nothing to read here. A handler that starts a
process, opens a consumer, charges a card or creates anything else outside the runtime does,
because the runtime commits state and nothing more. Four facts follow from that, and each one
changes how such a handler should be written.

## A refusal does not undo what the handler already did

Constraints are checked on the result a handler returns, after it has run. If a guard refuses
the result, the commit does not happen, and whatever the handler created is still there.

So a guard is a backstop, not a gate. Check what you can before opening anything:

<!-- check-docs:
import { defineEntity, fail, stay, transitionTo } from "ekman";
declare const startWorker: (region: string) => Promise<string>;
-->
```ts check
type Trigger = { type: "start"; region: string };

const workers = defineEntity.withTriggers<Trigger>()("workers", {
  initial: "idle",
  values: { region: "", workerId: "" },
  states: {
    idle: async (worker, trigger) => {
      // Validate first. Nothing has been created yet, so refusing here costs nothing.
      if (trigger.region === "") return fail(new Error("a worker needs a region"));

      const workerId = await startWorker(trigger.region);
      return transitionTo("running", { region: trigger.region, workerId });
    },
    running: (worker) => stay(worker.values),
  },
  constraints: {
    // Still worth having. It holds whichever handler or producer gets there.
    guards: [{ on: "running", check: (next) => next.values.region !== "" }],
  },
});
```

## The commit and the side effect are not atomic

A handler does its work and then returns, and the commit happens after that. Between the two
there is a window where the world has changed and the committed state has not. A crash in that
window, a timeout, or a retry all leave you there.

Design for it:

- **Make the side effect idempotent.** Derive its identity from the key and the trigger, not
  from a fresh random id, so a second attempt finds the first one's work and does not repeat it.
  `ctx.key` and the trigger's `id` are stable across retries of the same trigger.
- **Commit what was attempted, not only what succeeded.** Moving to a `starting` state before
  the call, and to `running` after it, leaves a record that says a call may be in flight.
- **Expect the abandoned attempt to finish.** A timed-out handler is not stopped. Its result is
  refused by the fence, and its side effects still happen. Watch `ctx.signal` where you can.

## Restored state outlives the resources it describes

With a durable store, an instance comes back after a restart in the state it committed. The
process it started does not. A stream that says `running` is restored faithfully, and nothing is
running.

The runtime cannot fix that, because it does not know what `running` means outside itself. A
component that owns external resources needs a reconciliation pass at boot:

<!-- check-docs:
import type { Ekman } from "ekman";
declare const ekman: Ekman;
declare const isAlive: (key: string) => Promise<boolean>;
-->
```ts check
const claimed = await ekman.query({ entity: "workers", state: "running" });

for (const instance of claimed.instances) {
  // The worker is named after the key, so there is nothing else to look up.
  if (!(await isAlive(instance.key))) {
    // Tell the instance what is true. Its handler decides what to do about it.
    ekman.post(instance.key, { type: "lost" });
  }
}
```

Reconcile by sending a trigger, as above. Reality reaches an instance the same way everything
else does, so the correction is recorded in its history like any other change.

## A complete query is complete about commits, not about the world

`query()` reports `complete: true` when it read every instance the store holds. That is a
statement about the record of commits. It says nothing about whether the things those commits
describe still exist. "Every worker is `running`" from a query means every worker last committed
`running`.

Use queries to find what to check, and check against the real system before acting on it.

## Next

- [Execution policy](./execution.md) for timeouts, retries and the fence.
- [Ordering and the inbox](./ordering.md) for why a handler must not await a send to its own key.
- [Constraints](./constraints.md) for what a guard and a time-in-state bound can enforce.
