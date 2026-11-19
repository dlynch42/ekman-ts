# Runtime and API

[Back to the docs index](./README.md)

```ts
import { Ekman } from "ekman";

export const ekman = new Ekman({
  entities: [orders, incidents],
  store: ["memory", "file"],
  memory: { maxBytes: 32 * 1024 * 1024, eviction: { policy: "lru", snapshotOnEvict: true } },
  inbox: { capacity: 128, overflow: "reject" },
  execution: { maxAttempts: 3, timeoutMs: 10_000, backoff: { kind: "exponential", baseMs: 50 } },
  temporal: { sweepMs: 1_000 },
  audit: [auditLog],
  telemetry,
});
```

One runtime per process. Construct it once at your entrypoint and import that object everywhere,
so a given instance is the same instance whichever door its trigger came through.

Every option is optional. `new Ekman()` is legal and gives you a memory-only runtime with no
entities registered yet.

Configuration is checked when the runtime is constructed, and again for each entity at
`define()`. An option the runtime does not recognize, at any level, is refused with
`INVALID_CONFIG` and the list of options that level does take, so a misspelling cannot leave a
setting at its default unnoticed. An execution policy no attempt could run under is refused
then too, rather than by the first trigger. Every setting that becomes a timer (`timeoutMs`,
backoff delays, `sweepMs`) may be at most 2,147,483,647 ms, a little under 25 days, which is
the longest delay a timer can hold.

## `new Ekman(config)`

| Option | Type | Default | See |
|---|---|---|---|
| `entities` | `EntityDefinition[]` | none | [Entities](./entities.md) |
| `store` | `StoreLayer` \| `StoreLayer[]` | memory only | [Durability](./durability.md) |
| `memory` | `{ maxBytes?, sizeOf?, eviction? }` | unbounded | [Memory](./memory.md) |
| `inbox` | `{ capacity?, overflow?, recordOverflow? }` | capacity default, `reject` | [Ordering](./ordering.md) |
| `execution` | `{ maxAttempts?, timeoutMs?, backoff?, retryable? }` | 1 attempt, no timeout | [Execution](./execution.md) |
| `temporal` | `{ sweepMs? }` | no automatic sweep | [Constraints](./constraints.md#time-in-state) |
| `storage` | `{ sweepMs? }` | no automatic sweep | [Durability](./durability.md#retention) |
| `audit` | `AuditSink[]` | none | [Telemetry](./telemetry.md#audit-sinks) |
| `telemetry` | map of event name to handler | none | [Telemetry](./telemetry.md) |
| `coordination` | `"single"` \| `"multi"` | `"single"` | below |
| `now` | `() => number` | `Date.now` | below |
| `onUnhandled` | `(error, { source, key? }) => void` | logs to stderr, naming the source | [Telemetry](./telemetry.md#unhandled-errors) |

### `coordination`

`"multi"` declares that more than one runtime will share this store. It is refused at startup
unless every layer can honestly support it, which requires a conditional append that is atomic
between processes. Neither shipped store can declare that, so asking for it is a startup error
rather than a quiet under-delivery.

### `now`

Inject a clock. Time-in-state constraints and `query({ olderThan })` both read it, so a test can
move time without sleeping.

`sweep()` reads the clock once per pass, so every violation a pass records is true at one
instant rather than at whichever moment the walk happened to reach it. Overlapping passes are
not useful, so a call made while one is running returns 0 immediately rather than queueing.

## Methods

| Method | Returns | What it does |
|---|---|---|
| `send(key, trigger)` | `Promise<CommitResult>` | Deliver a trigger. Resolves at commit with the committed state, values and sequence. Rejects on refusal or failure. |
| `post(key, trigger)` | `void` | Fire and forget. Wraps `send`; failures go to `onUnhandled` rather than becoming an unhandled rejection. |
| `inspect(key)` | `InstanceSnapshot \| undefined` | **Synchronous.** Current committed state of a resident instance. Does not touch the store and does not reload, so it is `undefined` for an instance that was evicted or is still loading. |
| `history(key)` | `Promise<HistoryResult>` | The per-key ordered stream, read through the commit authority. Rejects with `UNKNOWN_ENTITY` for an entity that is not registered. |
| `query(criteria)` | `Promise<QueryResult>` | Instances by entity, state and time in state, with their values on request. Rejects with `UNKNOWN_ENTITY` for an entity that is not registered. |
| `map(entity, options?)` | `Promise<StateMap>` | Where every instance of an entity is: a count and the keys for each state. Rejects with `UNKNOWN_ENTITY` for an entity that is not registered. |
| `residentMap(entity)` | `StateMap` | **Synchronous.** The same map from resident instances only. Never complete. |
| `forget(key)` | `Promise<void>` | Delete an instance outright, from memory and every store layer. Rejects with `UNKNOWN_ENTITY` for an entity that is not registered. |
| `sweep()` | `Promise<number>` | Evaluate every time-in-state constraint once, for resident instances and for those a store holds, and deliver whatever escalations are due. Returns how many fired. |
| `sweepStorage()` | `Promise<StorageSweep>` | Run the store's retention pass. Returns `{ logs, reclaimed, overBudget }`. |
| `close(options?)` | `Promise<void>` | Refuse new triggers, let in-flight work land up to `timeoutMs` (30 seconds by default), then close the store layers. See [below](#shutting-down). |
| `define(definition)` | `EntityHandle` | Register an already-defined entity after construction. |
| `entityNames` | `readonly string[]` | Registered entity names. |
| `residentKeys` | `readonly string[]` | Keys currently in memory. |
| `memoryUsage` | `{ bytes, instances, maxBytes }` | Resident accounting. |
| `storageUsage` | `{ bytes, logs, maxBytes }` | What the durable layers hold. |
| `entities` | typed handles | See below. |

### `forget` is refused while a key is busy

`forget` raises `KEY_BUSY` while a handler is in flight, or while a time-in-state sweep is
loading the instance and reading its bounds. A commit landing into a key that had
just been deleted would resurrect it at a sequence nothing accounts for, and the fence cannot
help, because an attempt already writing has sealed its token. Refusing is the honest answer, and
a caller that wants to wait can retry.

Forgetting a key that was never there is not an error, so a sweep that dies halfway behaves the
same way when it is run again.

## Typed entity handles

```ts
export const { orders, incidents } = ekman.entities;

await orders.send("a-1", { type: "pay", amount: 4200 });
orders.inspect("a-1");
await orders.history("a-1");
await orders.query({ state: "paid", olderThan: "1h" });
await orders.map();
await orders.forget("a-1");
orders.key("a-1");                      // "orders:a-1"
```

Each handle carries its entity's own state, values and trigger types. What `send`, `inspect` and
`history` return is typed with them, and with a [trigger union](./entities.md#typed-triggers)
`send` checks what you pass it, so a missing value field or a payload outside the union is a
compile error at the call site rather than a refusal at runtime. A `query` is typed the same
way: its `state` must be one of the entity's states, so a misspelt one is a compile error, and
the matches it returns carry the entity's state and value types. `map` keys its answer by those
states. A state that arrives as text, from a URL for instance, has to be checked against the
entity's states before it is passed in.
Handles address instances **by id**; the runtime's own methods take the **full key**.

```ts
await ekman.entities.orders.send("a-1", trigger);   // by id
await ekman.send("orders:a-1", trigger);            // by key, same instance
```

## Result shapes

```ts
// send() resolves to:
{ key, state, values, seq, event }

// inspect() returns, and a handler is handed:
{ key, entity, state, values, seq, enteredAt, lastCommittedAt }

// query() resolves to:
{ instances: [{ key, entity, state, seq, enteredAt, ageMs, resident, lastCommittedAt, staleMs, values? }],
  complete, reasons, sources }

// map() resolves to, and residentMap() returns:
{ entity, byState: { [state]: { count, keys } }, total, complete, reasons, sources }

// history() resolves to:
{ key, events, complete, reasons, sources }
```

See [Queries and history](./queries.md) for `complete` and `reasons`.

## Shutting down

```ts
process.on("SIGTERM", async () => {
  await ekman.close();
  process.exit(0);
});
```

`close()` shuts the runtime down in order, so work it has already accepted lands:

1. It stops accepting triggers. From this point `send()` rejects with `RUNTIME_CLOSED`, `post()`
   reports the same error through `onUnhandled`, and no sweep runs.
2. It waits for handlers that are already running to finish and commit, for refusals and
   violations still on their way to the store, and for a `forget()`, a storage sweep or a
   time-in-state sweep that had already begun. A time-in-state sweep loads nothing more from
   this point. `forget()` called after this point rejects with `RUNTIME_CLOSED`. A retry that is waiting out its backoff is not
   started: its sender receives `RUNTIME_CLOSED`.
3. It closes the store layers.

The wait in step 2 is bounded by `close({ timeoutMs })`, 30 seconds by default. A handler that
never settles cannot hold shutdown open: at the deadline the layers are closed anyway, and the
`runtime.closed` [telemetry](./telemetry.md) event reports `drained: false` and how many keys
were still busy. Calling `close()` again, or from two places at once, joins the same shutdown.

Call it on `SIGTERM`. The sweep timers do not keep a process alive on their own, but without
`close()` a commit in flight when the process exits has no chance to land.
