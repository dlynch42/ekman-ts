# Entities

[Back to the docs index](./README.md)

```ts
import { defineEntity, stay, transitionTo } from "ekman";

export const orders = defineEntity("orders", {
  initial: "pending",
  values: { total: 0, receipt: "" },
  states: {
    pending: async (order, trigger) => {
      if (trigger.type !== "pay") return stay(order.values);
      const receipt = await chargeCard(trigger.amount as number);
      return transitionTo("paid", { ...order.values, receipt });
    },
    paid: (order) => stay(order.values),
  },
});
```

An entity is a description of how one kind of thing behaves. It is a plain object, it has no
runtime attached, and it does not know where its triggers come from. Register it with a runtime
to bring instances of it to life.

## `defineEntity(name, config)`

| Field | Type | Required | What it does |
|---|---|---|---|
| `initial` | a key of `states` | yes | The state a new instance starts in. Checked against `states`, so a typo is a compile error. |
| `states` | map of state name to handler or `{ handler, ...policy }` | yes | The state machine. Its keys are the only source of the state union. |
| `values` | object | no | The starting values for a new instance, and the type of `instance.values` everywhere. |
| `triggers` | `string[]` | no | The contract with producers. Any trigger type not in this list is refused and recorded rather than ignored. |
| `unknown` | `"reject"` | no | What happens when the current state has no handler or the trigger type is unrecognized. `"reject"` is the only value, and also the default: there is deliberately no silent-discard setting. |
| `policy` | `ExecutionPolicy` | no | Retries, timeout and backoff for every state in this entity. Overrides the runtime's. See [Execution](./execution.md). |
| `onError` | map of classification to handler | no | Handlers for failures, resolved specific-then-fallback. |
| `classify` | `(error) => string` | no | Turns a thrown error into the key `onError` looks up. |
| `constraints` | `ConstraintsConfig` | no | Transition graph, guards, invariants, time-in-state bounds. See [Constraints](./constraints.md). |

### Typing `values`

Declare `values` as an inline object literal and everything infers:

```ts
values: { total: 0, receipt: "" },
```

If you want a named type, declare it as an `interface` extending `Record<string, unknown>` and
assert at the declaration site. An `interface` has no implicit index signature, which is why the
assertion is needed:

```ts
export interface OrderValues extends Record<string, unknown> {
  total: number;
  receipt: string;
}

values: { total: 0, receipt: "" } as OrderValues,
```

## Handlers

```ts
type Handler = (
  instance: InstanceSnapshot,   // { key, entity, state, values, seq }
  trigger: Trigger,             // { type: string } plus arbitrary fields, all unknown
  ctx: HandlerContext,          // { key, entity, attempt, signal }
) => HandlerResult | Promise<HandlerResult>;
```

`instance.values` is the committed values as of dispatch. Trigger payload fields are `unknown`
by design, so read them with a cast or a type guard:

```ts
const amount = trigger.amount as number;
```

`ctx.attempt` is 1 on the first try and increments per retry. Read it to behave differently on a
later attempt; do not count with it, because it is runtime state and putting it in committed
values makes it domain state.

`ctx.signal` is an `AbortSignal` that aborts when the attempt times out. Watching it is optional:
a handler that ignores it is covered by the fence instead. See [Execution](./execution.md).

## Results

A handler must return one of three things. Nothing else commits.

```ts
import { fail, stay, transitionTo } from "ekman";

transitionTo("paid", { total: 4200 })   // change state, optionally replace values
stay({ progress: 40 })                  // same state, new values
fail(new Error("card declined"))        // no commit of state or values; recorded
```

`transitionTo` is checked against the transition graph and guards when you have declared them.
`stay` is deliberately not a transition: the graph gates state changes, not value updates, so a
handler is free to update a progress counter inside a state without every tick walking the graph.

Throwing from a handler is equivalent to returning `fail` with the thrown error, so you do not
have to wrap everything in try/catch.

## Per-state execution policy

A state that talks to something flaky can carry its own retry and timeout settings, written where
the work is declared:

```ts
states: {
  pending: handlePending,
  deploying: { handler: handleDeploying, maxAttempts: 5, timeoutMs: 30_000 },
  failed: handleFailed,
},
```

Settings layer runtime, then entity, then state, field by field. See [Execution](./execution.md).

## Error handlers

```ts
onError: {
  unauthorized: (order) => transitionTo("blocked", order.values),
  [ERROR_FALLBACK]: (order, error) => transitionTo("failed", { ...order.values, note: error.message }),
},
classify: (error) => (error.message.includes("401") ? "unauthorized" : "other"),
```

An error handler returns a result like any other handler, so a failure can commit something legal
instead of leaving the instance where it was. A refused constraint is classified too, so `onError`
can catch a `CONSTRAINT_VIOLATED` and commit a permitted move.

Resolution is specific first, then `ERROR_FALLBACK` (which is the string `"*"`). Exactly one
handler runs.

## Declaring triggers

```ts
triggers: ["deploy", "succeeded", "failed", "rollback"],
```

Omit `triggers` and any type is accepted. Declare it and the list becomes a contract: a typo in a
message a queue is redelivering is refused with `UNKNOWN_TRIGGER` and written to the instance's
history, rather than being handled by whatever state happened to be current.

```
npm run demo:unknown    # a typo'd trigger, and a deploy that removed a state instances were in
```

## Next

- [Runtime and API](./api.md) for registering an entity and sending it triggers.
- [Constraints](./constraints.md) for restricting which transitions are legal.
