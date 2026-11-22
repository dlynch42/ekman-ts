# Entities

[Back to the docs index](./README.md)

<!-- check-docs:
declare const chargeCard: (cents: number) => Promise<string>;
-->
```ts check
import { defineEntity, stay, transitionTo } from "ekman";

type OrderTrigger = { type: "pay"; amount: number } | { type: "cancel" };

export const orders = defineEntity.withTriggers<OrderTrigger>()("orders", {
  initial: "pending",
  values: { total: 0, receipt: "" },
  states: {
    pending: {
      on: {
        pay: async (order, trigger) => {
          const receipt = await chargeCard(trigger.amount);
          return transitionTo("paid", { ...order.values, receipt });
        },
        cancel: (order) => transitionTo("cancelled", order.values),
      },
    },
    paid: (order) => stay(order.values),
    cancelled: (order) => stay(order.values),
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
| `states` | map of state name to a handler, `{ on, ...policy }` or `{ handler, ...policy }` | yes | The state machine. Its keys are the only source of the state union. A state takes every trigger with one handler, or names the types it handles under [`on`](#handling-by-trigger-type). |
| `values` | object | no | The starting values for a new instance, and the type of `instance.values` everywhere. Must be plain JSON data. They are copied and frozen at every depth, as committed values are, so a handler cannot change them in place. |
| `triggers` | list of trigger types | no | The contract with producers. Any trigger type not in this list is refused and recorded rather than ignored. Checked against the trigger union when the entity has one. Left out, every type is recognized, unless every state uses `on`: then the recognized types are the ones those maps name. |
| `unknown` | `"reject"` | no | What happens when the current state has no handler, has none for the trigger's type, or the type is unrecognized. `"reject"` is the only value, and also the default: there is deliberately no silent-discard setting. |
| `policy` | `ExecutionPolicy` | no | Retries, timeout and backoff for every state in this entity. Overrides the runtime's. See [Execution](./execution.md). |
| `onError` | map of classification to handler | no | Handlers for failures, resolved specific-then-fallback. |
| `classify` | `(error) => string` | no | Turns a thrown error into the key `onError` looks up. |
| `constraints` | `ConstraintsConfig` | no | Transition graph, guards, invariants, time-in-state bounds. See [Constraints](./constraints.md). |

### Typing `values`

Declare `values` as an inline object literal and everything infers:

```ts
values: { total: 0, receipt: "" },
```

If you want a named type, declare it as an `interface` extending `Record<string, unknown>`,
since an `interface` has no implicit index signature of its own, and annotate a constant with
it:

<!-- check-docs:
import { defineEntity, stay } from "ekman";
-->
```ts check
export interface OrderValues extends Record<string, unknown> {
  total: number;
  receipt: string;
}

const initialOrder: OrderValues = { total: 0, receipt: "" };

export const orders = defineEntity("orders", {
  initial: "pending",
  values: initialOrder,
  states: { pending: (order) => stay(order.values) },
});
```

`values: { total: 0, receipt: "" } satisfies OrderValues` also works. Do not write
`as OrderValues`: an assertion is not checked for missing fields, so a field you forgot
compiles and is `undefined` at runtime.

## Handling by trigger type

A state that does different things for different triggers names them under `on`, one handler
per type:

```ts
states: {
  pending: {
    on: {
      pay: (order, trigger) => transitionTo("paid", { total: trigger.amount }),
      cancel: (order) => transitionTo("cancelled", order.values),
    },
  },
  paid: (order) => stay(order.values),
}
```

The runtime picks the handler, so no handler opens with a branch on `trigger.type`. With a
[trigger union](#typed-triggers) each handler receives the member its key names: `trigger.amount`
above is a `number`, with no narrowing and no cast.

**A type with no entry is refused.** A `refund` arriving while the order is `pending` never
reaches a handler. The sender gets `UNHANDLED_TRIGGER`, the refusal is written to the instance's
history, and the instance stays where it was. That is a different refusal from
`UNKNOWN_TRIGGER`: the entity knows what a `refund` is, and this state has nothing to do with
one. There is no fallback entry, because a fallback is a way to drop a trigger without saying so.

**A plain handler still takes everything.** Write a state as a function when it should see
every trigger type, including the ones it answers with `stay()`. The two forms mix freely within
one entity, and `paid` above is the function form.

**The map takes the same policy fields** a `{ handler }` state does, beside `on`:
`{ on: { ... }, maxAttempts: 5, timeoutMs: 30_000 }`. The policy belongs to the state, not to
one trigger type. A state cannot declare both `handler` and `on`.

**Triggers the runtime delivers need an entry too.** A state under a
[time-in-state bound, a freshness bound or a rule](./constraints.md) receives that bound's
trigger like any other, so its `on` map lists the type: `"constraint.temporal"`,
`"constraint.stale"` or `"rule.matched"`, or the bound's own `trigger` name. Leaving it out is
refused when the entity is defined, where the bound names the state. A bound that applies in
every state is not checked this way, and a state that does not list its trigger refuses it on
arrival.

`on` here is not the `on` of a [guard](./constraints.md), which names the state a guard
protects.

## Typed triggers

By default a trigger is `{ type: string }` plus arbitrary fields, all `unknown`. Give the entity
a union of what it can be sent and the payloads are typed everywhere:

<!-- check-docs:
import { defineEntity, stay, transitionTo } from "ekman";
-->
```ts check
type OrderTrigger =
  | { type: "pay"; amount: number }
  | { type: "refund"; reason: string };

export const orders = defineEntity.withTriggers<OrderTrigger>()("orders", {
  initial: "pending",
  values: { total: 0 },
  triggers: ["pay", "refund"],
  states: {
    pending: {
      on: { pay: (_order, trigger) => transitionTo("paid", { total: trigger.amount }) },
    },
    paid: (order, trigger) =>
      trigger.type === "refund" ? transitionTo("refunded", order.values) : stay(order.values),
    refunded: (order) => stay(order.values),
  },
});
```

The union comes first, in its own call, and the name, states and values are inferred from the
config as usual. It cannot be inferred from a handler's parameter, so annotating `trigger`
there does not work.

What the union buys:

- **Handlers read payload fields without a cast.** An `on` entry receives the one member its
  key names, and a plain handler narrows on `trigger.type`.
- **`entities.orders.send` checks the caller.** `send("a-1", { type: "bogus" })` and a `pay` with
  no `amount` are compile errors.
- **`triggers` and the keys of `on` are checked against the union,** so a typo in either is a
  compile error too.

Two things it does not change:

- **`ekman.send(key, trigger)` takes any trigger.** It is addressed by key, so it does not know
  which entity it is talking to. Use it for input you did not build yourself, such as a
  request body or a queue message: the runtime still refuses a type that is not in `triggers`.
- **The union is a compile-time claim.** A trigger sent by key with a field missing reaches the
  handler with that field `undefined`. Validate untrusted input before it is sent, and keep a
  guard as the backstop.

### Time-in-state escalations

A [time-in-state bound](./constraints.md) delivers a trigger of its own. An entity with a
trigger union and a bound adds `TemporalTrigger` to the union:

```ts
import type { TemporalTrigger } from "ekman";
import { DEFAULT_TEMPORAL_TRIGGER } from "ekman";

type State = "pending" | "overdue";
type InvoiceTrigger = { type: "pay"; amount: number } | TemporalTrigger<State>;

// in a handler:
if (trigger.type === DEFAULT_TEMPORAL_TRIGGER) {
  return transitionTo(trigger.escalateTo ?? "overdue");   // a State, no cast
}

// or as an entry in the state's `on` map:
on: {
  [DEFAULT_TEMPORAL_TRIGGER]: (_invoice, trigger) =>
    transitionTo(trigger.escalateTo ?? "overdue"),
}
```

It carries `constraint` (the bound's name), `state`, `sinceMs` and, when the bound names one,
`escalateTo`. A bound that sets its own `trigger` name is written
`TemporalTrigger<State, "invoice.stuck">`.

## Handlers

```ts
type Handler = (
  instance: InstanceSnapshot,   // { key, entity, state, values, seq }
  trigger: Trigger,             // { type: string } plus arbitrary fields, all unknown
  ctx: HandlerContext,          // { key, entity, attempt, signal }
) => HandlerResult | Promise<HandlerResult>;
```

`instance.values` is the committed values as of dispatch. Trigger payload fields are `unknown`
unless the entity declares a trigger union, in which case `trigger` is that union. See
[Typed triggers](#typed-triggers).

`ctx.attempt` is 1 on the first try and increments per retry. Read it to behave differently on a
later attempt; do not count with it, because it is runtime state and putting it in committed
values makes it domain state.

`ctx.signal` is an `AbortSignal` that aborts when the attempt times out. Watching it is optional:
a handler that ignores it is covered by the fence instead. See [Execution](./execution.md).

A handler that creates or calls something outside the runtime, such as a process, a queue
consumer or a payment, should read [Handlers that own external resources](./external-resources.md).
A handler must not await a `send()` to its own key; see
[Reentrancy](./ordering.md#reentrancy-do-not-await-a-send-to-your-own-key).

## Results

A handler must return one of four things. Nothing else commits.

```ts
import { fail, patch, stay, transitionTo } from "ekman";

transitionTo("paid", { total: 4200 })   // change state, optionally replace values
stay({ progress: 40 })                  // same state, replace values
patch({ progress: 40 })                 // same state, merge into the values held
fail(new Error("card declined"))        // no commit of state or values; recorded
```

`stay` and `transitionTo` **replace** values when given any. `patch` **merges**: it names what
changed and everything else the instance knows is carried forward. That is the update for an
instance that is memory about something, where each trigger teaches it one thing:

```ts
// Replacing: every handler restates everything, and a forgotten spread drops what it left out.
return stay({ ...service.values, latencyMs: trigger.latencyMs });

// Merging: say what was learned.
return patch({ latencyMs: trigger.latencyMs });
```

The merge is shallow. A field named in a patch replaces the one held, whole, including when it
is an object or an array. The committed event carries the full merged values, as every commit
does, so history, replay and [invariants](./constraints.md#invariants) all see whole values and
none of them has to know a merge happened. `patch` does not move the instance; a move that
also wants to keep what it knows spreads the values into `transitionTo`, as before.

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

A state written with `on` takes the same fields beside the map.

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

The list says what the entity recognizes at all. What one state does with a recognized type is
the state's business: a plain handler sees it, and a state written with
[`on`](#handling-by-trigger-type) refuses any type it has no entry for with `UNHANDLED_TRIGGER`.

```
npm run demo:unknown    # a typo'd trigger, and a deploy that removed a state instances were in
```

## Next

- [Runtime and API](./api.md) for registering an entity and sending it triggers.
- [Constraints](./constraints.md) for restricting which transitions are legal.
