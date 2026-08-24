# Constraints

[Back to the docs index](./README.md)

```ts
constraints: {
  transitions: { allow: { pending: ["deploying"], deploying: ["live", "failed"] } },
  guards:      [{ on: "deploying", check: (next) => next.values.region !== undefined }],
  invariants:  [{ name: "attempts-sane", check: (next) => next.values.attempts >= 0 }],
  temporal:    [{ in: "deploying", within: 10 * 60_000, escalateTo: "failed" }],
},
```

Four kinds, all opt-in per entity, each checked at a defined moment, each carrying its own
`reject` / `warn` / `off` dial.

| Kind | Checked | Against |
|---|---|---|
| `transitions` | before commit of a `transitionTo` | the declared graph |
| `guards` | before commit of a `transitionTo` | a condition on the proposed commit |
| `invariants` | before commit of any result that changes values | a condition that must hold |
| `temporal` | by sweep, timer, or `ekman.sweep()` | how long an instance has been in a state |

`stay` is deliberately not a transition. The graph and guards gate state changes; invariants
gate value changes. Putting the graph in front of every `stay` would break every entity that
updates values freely inside a state.

## The check signature

```ts
type ConstraintCheck = (
  next: { state, values },        // the proposed commit
  instance: InstanceSnapshot,     // where it is now
  trigger: Trigger,               // what caused it
) => boolean | string;
```

Return `true` to allow. Return `false` to refuse, or return a **string** to refuse with that
string as the explanation, which is what shows up in the violation event and in the error
message.

```ts
guards: [{
  on: "shipped",
  check: (next) => next.values.paid === true || "cannot ship before payment clears",
}],
```

## Transition graph

```ts
transitions: {
  policy: "reject",
  allow: { pending: ["deploying"], deploying: ["live", "failed"], live: [], failed: [] },
},
```

A state that only ever appears as a target does not need an entry. A refusal explains itself:

```
CONSTRAINT_VIOLATED | transitions: "paid" to "pending" is not a declared transition.
From "paid" the declared targets are: (none)
```

## Guards

A guard is a condition on entering a state. It can be scoped to where the transition comes
*from* as well as where it goes:

```ts
guards: [
  { name: "payment-cleared", on: "shipped", from: "paid", check: (next) => next.values.paid },
  { name: "override-noted",  on: "shipped", from: "manual_override", check: (next) => next.values.note !== "" },
],
```

So "entering `shipped` from `paid` requires payment cleared, but entering it from
`manual_override` does not" is something you declare rather than something you hide inside a
check.

A guard scoped to a transition the graph does not allow is refused when the entity is defined.
A condition on something that cannot happen reads like protection that is in force, and it is
not.

## Invariants

```ts
invariants: [
  { name: "attempts-sane", check: (next) => next.values.attempts >= 0 },
  { name: "total-matches", in: ["paid", "shipped"], check: (next) => next.values.total > 0 },
],
```

Checked before committing any result that changes values, `stay` included. `in` scopes an
invariant to particular states; omit it and it holds everywhere.

## Time in state

```ts
temporal: [{ in: "deploying", within: 10 * 60_000, escalateTo: "failed" }],
```

**A time-in-state bound fires as a trigger, never as a write.** The runtime hands your handler
the escalation and your handler decides, exactly as with any other input. That keeps every state
change attributable to one piece of your code, and it means a handler can decline an escalation.

```ts
import { DEFAULT_TEMPORAL_TRIGGER } from "ekman";

triggers: ["deploy", "succeeded", DEFAULT_TEMPORAL_TRIGGER],

states: {
  deploying: (deployment, trigger) => {
    if (trigger.type === DEFAULT_TEMPORAL_TRIGGER) {
      if (deployment.values.attempts < 3) return stay(deployment.values);  // decline it
      return transitionTo("failed", deployment.values);
    }
    // ...
  },
},
```

Set `trigger` on the constraint to use a type of your own instead of the default.

Evaluate on a schedule with `temporal: { sweepMs }` on the runtime, or call `await ekman.sweep()`
yourself. Without either, a bound is only checked when something asks.

```
npm run demo:stuck    # "stuck in deploying for more than five minutes", as query and as constraint
```

## The `warn` dial, and why it exists

```ts
transitions: { policy: "warn", allow: { /* your best guess */ } },
```

`warn` is the point of the dial. Turn a constraint on in `warn`, let real traffic run against
it, read the violations it produces, and switch to `reject` once you know what your graph
actually is. Violations land in the same per-key stream as transitions under either policy, so
"everything that would have been refused last week" is one query rather than a log-scraping
exercise.

Under `reject`, a refused result is classified, so `onError` can catch it and commit something
legal instead.

## Discovering the graph you actually have

`warn` mode ends with a diagram rather than a log read.

```ts
import { allowFrom, observeEdges, toMermaid } from "ekman";

// Fold every key's stream into the edges the traffic actually walked.
let observed;
for (const key of keys) {
  observed = observeEdges((await ekman.history(key)).events, observed);
}

// Turn that into a map you paste straight into the constraint.
console.log(allowFrom(observed));
// { pending: ["deploying"], deploying: ["live", "failed"] }

// Draw declared and observed together. Moves you never declared are marked as observed.
console.log(toMermaid(orders, { observed: observed.taken }));
```

For an entity that declared `pending -> paid` and `paid -> shipped`, whose traffic also walked
`paid -> pending`, that prints:

```
stateDiagram-v2
  [*] --> pending
  pending --> paid
  paid --> shipped
  paid --> pending : observed
```

The marked edge is the edit you are being asked to make: either add it to `allow`, or fix the
handler that produced it, then switch the policy to `reject`.

`observeEdges` accumulates across streams, because history is per key and a graph is per entity.
`allowFrom` deliberately leaves out refused edges: enforcement already decided against them, and
a map that re-admitted them would declare the thing you rejected.

`toDot` produces Graphviz instead of Mermaid. `analyze(definition)` returns the declared graph
plus reachability, without needing any history.

```
npm run demo:no-going-backwards   # unconstrained, then warn, then reject, on one naive handler
```

## Next

- [Queries and history](./queries.md) for reading violations back.
- [Error codes](./errors.md) for `CONSTRAINT_VIOLATED`.
