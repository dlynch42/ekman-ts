# Queries and history

[Back to the docs index](./README.md)

```ts
const stuck = await ekman.query({
  entity: "deployments",
  state: "deploying",
  olderThan: "5m",         // or a number of milliseconds
});

for (const instance of stuck.instances) {
  console.log(instance.key, instance.state, instance.ageMs);
}
```

"What is stuck in `deploying`, and for how long" is the question a state runtime exists to
answer, and it is one call.

## `query(criteria)`

| Field | Type | What it does |
|---|---|---|
| `entity` | `string` | Required. Which entity to search. One that is not registered is refused with `UNKNOWN_ENTITY`. |
| `state` | `string` | Only instances currently in this state. |
| `olderThan` | `number` \| `string` | Time in state, as milliseconds or a duration string such as `"5m"`, `"2h"`, `"30d"`. |
| `limit` | `number` | Cap the answer to the oldest this many. Truncation is reported, never silent. Anything but a non-negative integer is refused with `INVALID_CONFIG`. |

The string form for `olderThan` exists because `"5m"` is what an operator actually wants to
write, and `300000` is a number nobody checks twice. A string that is not a duration is refused
rather than guessed at.

Each match is:

```ts
{ key, entity, state, seq, enteredAt, ageMs, resident }
```

Results come back oldest first, which is the order the question is asked in. Instances that
entered their state at the same instant are ordered by key, compared as plain strings and not by
locale, so `orders:B` comes before `orders:a` on every machine and a limited answer is the same
answer twice.

### Where the answer comes from

Resident instances are answered from memory and stored ones from the commit authority. An
instance that is resident and matches is not read from the store as well: the store is told
which keys the runtime has already answered and leaves them out. So a query costs one read per
stored instance the runtime could not answer itself, and nothing for the ones it could.

A resident instance that does not match is still asked about. So is one that is still loading.
If another writer has moved either into the state you asked for, the stored row is the answer,
and it comes back with `resident: false`.

### Time in state is measured from the last move

A handler that updates a progress counter every second does not keep resetting the clock on
something that has not gone anywhere. `stay` updates values; it does not restart the timer.

That is the same measurement a [time-in-state constraint](./constraints.md#time-in-state) uses,
deliberately. Two implementations of one question is how two answers start disagreeing.

## `history(key)`

```ts
const { events } = await ekman.history("deployments:abc123");
```

The whole per-key ordered stream: transitions, refused triggers, constraint violations, and
reloads, in order. It reads through the commit authority when one is configured, so it covers
the instance's whole life and not only what this process happened to see.

With no store, the answer comes from what the runtime holds in memory, which is the most
recent 1,000 events for the key. A longer history is reported as `history-capped`, below.

```ts
import { isTransitionEvent } from "ekman";

console.log(events.filter(isTransitionEvent).map((e) => `${e.from ?? "(new)"} -> ${e.to}`));
// [ '(new) -> pending', 'pending -> paid' ]
```

`from` is null exactly once per instance, on initialization.

Because violations land in the same stream as transitions, "every violation in the last hour" is
a query rather than a log-scraping exercise. And because [telemetry](./telemetry.md) is a
separate stream, the history stays domain-only: no queue depths, no handler durations, no retry
counts.

## Every result says whether it is the whole answer

```ts
const { instances, complete, reasons } = await ekman.query({ entity: "deployments" });
if (!complete) {
  // reasons is one or more of the values below
}
```

| Reason | Means |
|---|---|
| `no-durable-store` | Nothing durable is configured, so the answer covers what this runtime happens to retain, and nothing evicted or committed before it started. |
| `unsupported-criteria` | A store could not evaluate one of the filters, so it was applied after the fact. |
| `limit-reached` | The answer was truncated by `limit`. |
| `compacted` | The stream was compacted, so events before the snapshot are gone. Current state, values and sequence are unaffected; what is missing is the middle of the history. |
| `history-capped` | No store holds the stream, and the instance has more events than a runtime keeps in memory per key (the most recent 1,000), so the oldest are gone. Current state, values and sequence are unaffected. Only `history` reports this, and always alongside `no-durable-store`. |

`complete: false` does not mean the answer is wrong. It means something in the configuration
cannot see everything, and `reasons` says what.

Returning a partial answer as if it were complete is the one thing a query here will never do.
An operator acting on "nothing is stuck" needs that to have meant it.

`sources` names the layers that contributed, which is how you tell an answer from cache from an
answer from the commit authority.

## Reading one instance

```ts
ekman.inspect("orders:a-1");                 // synchronous, resident instances only
ekman.entities.orders.inspect("a-1");        // same, typed, addressed by id
```

`inspect` returns `{ key, entity, state, values, seq }`, or `undefined` if the instance is not
resident. It does not touch the store and it does not reload. Use `history` or `query` when you
need an answer that covers instances this process has not loaded.

`inspect` also returns `undefined` for an instance that is still being loaded from the store,
or that another writer has moved since it was loaded, so a caller never reads a state the
store has already moved past. The next trigger for the key reconciles it.

The cheapest read of all is the one `send` already gives you: it resolves to the committed
`{ key, state, values, seq, event }`.

```
npm run demo:stuck   # the query and the constraint, on one injected clock
```

## Next

- [Error codes](./errors.md) for what a failed `send` tells a caller.
- [Telemetry](./telemetry.md) for the runtime's own stream.
