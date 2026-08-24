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
| `onUnhandled` | `(error) => void` | none | [Telemetry](./telemetry.md#unhandled-errors) |

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
| `inspect(key)` | `InstanceSnapshot \| undefined` | **Synchronous.** Current committed state of a resident instance. Does not touch the store and does not reload. |
| `history(key)` | `Promise<HistoryResult>` | The per-key ordered stream, read through the commit authority. |
| `query(criteria)` | `Promise<QueryResult>` | Instances by entity, state and time in state. |
| `forget(key)` | `Promise<void>` | Delete an instance outright, from memory and every store layer. |
| `sweep()` | `Promise<number>` | Evaluate every time-in-state constraint once and deliver whatever escalations are due. Returns how many fired. |
| `sweepStorage()` | `Promise<StorageSweep>` | Run the store's retention pass. Returns `{ logs, reclaimed, overBudget }`. |
| `close()` | `Promise<void>` | Stop sweep timers and release the runtime. |
| `define(definition)` | `EntityHandle` | Register an already-defined entity after construction. |
| `entityNames` | `readonly string[]` | Registered entity names. |
| `residentKeys` | `readonly string[]` | Keys currently in memory. |
| `memoryUsage` | `{ bytes, instances, maxBytes }` | Resident accounting. |
| `storageUsage` | `{ bytes, logs, maxBytes }` | What the durable layers hold. |
| `entities` | typed handles | See below. |

### `forget` is refused while a key is busy

`forget` raises `KEY_BUSY` while a handler is in flight. A commit landing into a key that had
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
await orders.forget("a-1");
orders.key("a-1");                      // "orders:a-1"
```

Each handle carries its entity's own state, values and trigger types, so a typo'd state name or a
missing value field is a compile error at the call site rather than a refusal at runtime. Handles
address instances **by id**; the runtime's own methods take the **full key**.

```ts
await ekman.entities.orders.send("a-1", trigger);   // by id
await ekman.send("orders:a-1", trigger);            // by key, same instance
```

## Result shapes

```ts
// send() resolves to:
{ key, state, values, seq, event }

// inspect() returns:
{ key, entity, state, values, seq }

// query() resolves to:
{ instances: [{ key, entity, state, seq, enteredAt, ageMs, resident }], complete, reasons, sources }

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

`close()` stops the sweep timers. Without it a process with `temporal: { sweepMs }` configured
will not exit on its own.
