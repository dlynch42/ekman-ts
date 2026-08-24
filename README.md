# Ekman

**Declarative, embeddable state management for backend services.**

[![npm](https://img.shields.io/npm/v/ekman.svg)](https://www.npmjs.com/package/ekman)
[![license](https://img.shields.io/npm/l/ekman.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/ekman.svg)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

Ekman gives a backend service addressable stateful instances: each one identified by a
human-readable key, holding its own state and values, processing its triggers one at a time.
Around that it owns the operational layer that homegrown versions leave out, including
transition history, constraints, retries and timeouts, queries, and a memory budget. There is no
server to deploy, no cluster to run, and no sidecar: it is a library you construct at your
entrypoint. A runtime you embed, not a platform you operate.

> **v0.1.** Targets Ekman spec 0.1. Passes the Core and Durable conformance levels; Coordinated
> is not claimed. Pre-1.0, so minor versions may make breaking changes.

<details>
<summary>Contents</summary>

- [Install](#install)
- [Quickstart](#quickstart)
- [Why](#why)
- [Core concepts](#core-concepts)
- [API reference](#api-reference)
- [Examples and demos](#examples-and-demos)
- [Performance](#performance)
- [Conformance](#conformance)
- [Compatibility](#compatibility)
- [Documentation](#documentation)
- [Scope](#scope)
- [Design principles](#design-principles)
- [Contributing](#contributing)
- [License](#license)

</details>

## Install

```
npm install ekman
```

Node 20 or newer. Zero runtime dependencies. ESM and CommonJS entry points are both shipped, and
TypeScript types are bundled.

## Quickstart

```
npm install ekman
npm pkg set type=module     # Ekman is ESM-first, and tsx needs this for top-level await
npx tsx quickstart.ts
```

```ts
// quickstart.ts
import { defineEntity, Ekman, isTransitionEvent, stay, transitionTo } from "ekman";

/** Stand-in for whatever actually takes the money. */
const chargeCard = async (cents: number) =>
  new Promise<string>((ok) => setTimeout(() => ok(`rc_${cents}`), 20));

// 1. Describe how an order behaves: states to handlers. No runtime here, no I/O.
const orders = defineEntity("orders", {
  initial: "pending",
  values: { total: 0, receipt: "" },
  states: {
    // One handler runs per key at a time, so read, await, write needs no lock.
    pending: async (order, trigger) => {
      if (trigger.type !== "pay") return stay(order.values);
      const amount = trigger.amount as number;
      const receipt = await chargeCard(amount);
      return transitionTo("paid", { total: order.values.total + amount, receipt });
    },
    paid: (order) => stay(order.values),
  },
});

// 2. Build the runtime once, at your entrypoint. No store means memory only.
const ekman = new Ekman({ entities: [orders] });

// 3. Address an instance by id and send it a trigger. Resolves when the commit lands.
const committed = await ekman.entities.orders.send("a-1", { type: "pay", amount: 4200 });
// same thing by full key: await ekman.send("orders:a-1", { type: "pay", amount: 4200 })
console.log(committed.state, committed.values);

// 4. Read it back. inspect() is synchronous; history() is the whole per-key stream.
const { events } = await ekman.entities.orders.history("a-1");
console.log(events.filter(isTransitionEvent).map((e) => `${e.from ?? "(new)"} -> ${e.to}`));

await ekman.close();
```

```
paid { total: 4200, receipt: 'rc_4200' }
[ '(new) -> pending', 'pending -> paid' ]
```

The keys of `states` are the only source of the state union, so `initial: "pending"` is checked
and a typo is a compile error. Trigger payload fields are `unknown` by design, which is why
`trigger.amount` is cast.

**Make it durable.** Nothing above survives the process. Name a store and it does:

```ts
const ekman = new Ekman({ entities: [orders], store: "file" });   // writes to .ekman/logs/
```

Commits are written before they are applied, so a `send()` that resolves has already reached the
commit authority.

**Restrict which moves are legal.** Declare the graph and an illegal transition is refused before
it commits:

```ts
constraints: { transitions: { allow: { pending: ["paid"], paid: [] } } },
```

```
CONSTRAINT_VIOLATED | transitions: "paid" to "pending" is not a declared transition.
From "paid" the declared targets are: (none)
```

## Why

Stateful backend logic starts simple and degrades into scattered control flow:

- A large file of `switch`/`case` blocks, duplicated across every service that touches the same workflow.
- Transitions, retries, memory updates and failure paths coordinated by hand in application code.
- No answer to "what state is deployment `abc123` in right now?" without querying several systems.
- Concurrent triggers reaching the same instance while its previous work is still running.

Orchestration platforms address this by having you deploy and operate their runtime. State
machine libraries address dispatch, and leave identity, ordering, persistence, retries and
querying to you. Ekman is the middle: the semantics of the first, delivered the way the second is.

## Core concepts

Each of these has a full page in [docs/](./docs).

### Entities and handlers

```ts
const orders = defineEntity("orders", {
  initial: "pending",
  values: { total: 0 },
  triggers: ["pay", "refund"],          // anything else is refused and recorded
  states: {
    pending: (order, trigger) => transitionTo("paid", { total: trigger.amount as number }),
    paid: (order) => stay(order.values),
  },
});
```

A handler receives the instance, the trigger and a context, and returns one of three results:
`transitionTo`, `stay`, or `fail`. Nothing else commits, and throwing is equivalent to `fail`.
[More](./docs/entities.md)

### Keys and instances

```ts
await ekman.send("deployments:abc123", { type: "deploy" });
```

A key is `<entity>:<segment>...`. One key owns one instance's state, values, inbox ordering,
resident memory, persistence, sequence numbering and history. Nothing is shared across keys,
which is why nothing has to be locked across them. [More](./docs/concepts.md)

### Ordering and the bounded inbox

```ts
inbox: { capacity: 128, overflow: "reject" },   // 128 triggers waiting per key, not bytes
```

One handler runs per key at a time, so a handler can read, `await` something slow, and write back
without checking whether anyone else is mid-flight. Handlers for different keys overlap freely.
The inbox is bounded in triggers rather than bytes, and when it fills the sender always finds out:
`reject` is backpressure, `drop-newest` and `drop-oldest` are shedding. [More](./docs/ordering.md)

### Retries, timeouts and fencing

```ts
execution: { maxAttempts: 3, timeoutMs: 10_000, backoff: { kind: "exponential", baseMs: 50 } },
```

Configured once, overridden per entity or per state, field by field. During retries the key stays
occupied, so a queued trigger cannot slip past an attempt in flight.

A running JavaScript function cannot be stopped, so a timeout aborts `ctx.signal` for handlers
that watch it and invalidates the attempt's commit token for those that do not. The abandoned
handler keeps running, eventually tries to commit, and is refused. That is what makes a zombie
handler harmless rather than merely unlikely. [More](./docs/execution.md)

### Constraints

```ts
constraints: {
  transitions: { allow: { pending: ["deploying"], deploying: ["live", "failed"] } },
  guards:      [{ on: "deploying", from: "pending", check: (n) => n.values.region !== undefined }],
  invariants:  [{ name: "attempts-sane", check: (n) => n.values.attempts >= 0 }],
  temporal:    [{ in: "deploying", within: 10 * 60_000, escalateTo: "failed" }],
},
```

Four kinds, all opt-in, each with its own `reject` / `warn` / `off` dial. `warn` lets you turn a
constraint on, read the violations real traffic produces, and switch to `reject` once you know
what your graph actually is; `observeEdges` and `allowFrom` turn those violations into the map to
paste back in. A time-in-state bound fires as a trigger rather than a write, so your handler
decides. [More](./docs/constraints.md)

### Durability and stores

```ts
store: ["memory", "file"],   // fastest first; the last durable layer owns the truth
```

Durability is configured, never implied: omit `store` and nothing survives the process, which is a
documented mode rather than a degraded one. Every store declares what it can do, and the runtime
refuses configurations those declarations cannot satisfy rather than quietly under-delivering.
[More](./docs/durability.md)

### Memory budget

```ts
memory: { maxBytes: 32 * 1024 * 1024, eviction: { policy: "lru", snapshotOnEvict: true } },
```

Instances are accounted at commit, in UTF-8 bytes of the key, state name and serialized values.
Eviction only touches idle instances, and reload is transparent: your code cannot tell a resident
instance from one that just came back off disk. [More](./docs/memory.md)

### Queries and history

```ts
const stuck = await ekman.query({ entity: "deployments", state: "deploying", olderThan: "5m" });
const { instances, complete, reasons } = stuck;
```

Time in state is measured from the last move, so a handler updating a progress counter does not
keep resetting the clock. Every result says whether it is the whole answer; returning a partial
one as if it were complete is the thing a query here will never do, because an operator acting on
"nothing is stuck" needs that to have meant it. [More](./docs/queries.md)

### Telemetry and audit

```ts
telemetry: { "handler.settled": (e) => metrics.observe("ekman.handler.ms", e.durationMs) },
audit: [auditLog],
```

Telemetry is a separate stream from history by design: queue depth, handler duration, drops and
retries are Ekman's business, and your transition history stays domain-only. Audit sinks get a
copy of every committed event out of band, and never gate a commit. [More](./docs/telemetry.md)

## API reference

Full surface in [docs/api.md](./docs/api.md). The parts you need first:

### Runtime

| Member | Returns | Does |
|---|---|---|
| `send(key, trigger)` | `Promise<CommitResult>` | Deliver a trigger. Resolves at commit, rejects on refusal or failure. |
| `post(key, trigger)` | `void` | Fire and forget. Failures go to `onUnhandled`. |
| `inspect(key)` | `InstanceSnapshot \| undefined` | Synchronous. Resident instances only. |
| `history(key)` | `Promise<HistoryResult>` | The per-key ordered stream. |
| `query(criteria)` | `Promise<QueryResult>` | Instances by entity, state and time in state. |
| `forget(key)` | `Promise<void>` | Delete an instance from memory and every store layer. |
| `sweep()` | `Promise<number>` | Evaluate time-in-state constraints now. |
| `sweepStorage()` | `Promise<StorageSweep>` | Run the store's retention pass. |
| `close()` | `Promise<void>` | Stop sweep timers. |
| `entities.<name>` | `EntityHandle` | Typed handle: `send`, `post`, `inspect`, `history`, `query`, `forget`, `key`, all by id. |
| `memoryUsage` / `storageUsage` | `{ bytes, ... }` | Resident bytes, and bytes on disk. |

### Exports

| Group | Names |
|---|---|
| Runtime | `Ekman` |
| Entities | `defineEntity`, `statesFromEntries` |
| Results | `transitionTo`, `stay`, `fail` |
| Keys | `buildKey`, `parseKey`, `KEY_SEPARATOR` |
| Errors | `EkmanError`, `ConstraintViolationError`, `isEkmanError`, `isConstraintViolation`, `ERROR_CODES`, `ERROR_FALLBACK` |
| Events | `isTransitionEvent` |
| Diagrams | `analyze`, `toMermaid`, `toDot`, `observeEdges`, `allowFrom` |
| Stores | `createStore`, `resolveStack`, `replay`, `scanKeys`, `defaultLogDir` |
| Misc | `parseDuration`, `accountBytes`, `DEFAULT_TEMPORAL_TRIGGER`, `TELEMETRY_FALLBACK` |

Plus the types for every one of them.

### Handler context

`ctx` carries `key`, `entity`, `attempt` (1 on the first try, incrementing per retry), and
`signal` (an `AbortSignal` that aborts on timeout).

### Error codes

Every failure carries a stable `code`; branch on that rather than the message. The full table with
suggested HTTP mappings is in [docs/errors.md](./docs/errors.md). The distinction a caller needs
is that `CONSTRAINT_VIOLATED` will happen again in exactly the same way, and `INBOX_OVERFLOW` is
this instant only.

## Examples and demos

[`examples/deploy-service`](./examples/deploy-service) is a small deployment tracker built the way
you would actually build one: two entities, an HTTP API, a queue consumer, and one runtime shared
by both.

```
examples/deploy-service/src/
  entities/     deployment.ts, incident.ts    the domain: states, handlers, constraints
  lib/          runtime.ts                    the single new Ekman({...}) for the process
                metrics.ts, audit-log.ts,     telemetry and audit sinks
                reactions.ts, config.ts
  api/          server.ts, routes/            thin handlers: read request, send trigger
  workers/      consumer.ts                   a queue driving the same runtime
```

```
npm run example:api     # start it and poke it with curl
npm run example:smoke   # boot it on an ephemeral port, drive it end to end, assert
```

The route handlers read a request, `send()` a trigger, and shape the answer: no locks, no
transactions, no read-modify-write, no retry loops. Two requests for the same deployment arriving
at the same instant need nothing there to be safe. Then stop the process and start it again;
everything is still there.

<details>
<summary>Thirteen runnable demos</summary>

Each demo asserts rather than only printing, so a broken claim fails the run instead of scrolling
past, and each ends by saying what its output means.

| Command | What it makes checkable |
|---|---|
| `demo:ordering` | Five triggers at one slow key, doing a read-modify-write with an `await` in the middle, and not one lost update. No lock anywhere in the handler. Ends with a full queue refusing a trigger. |
| `demo:concurrency` | The same argument under load. 5,000 increments across 200 keys, run three ways: no coordination (fast, thousands of lost updates), a promise chain per key by hand (correct), and through the runtime. Samples itself every 5ms, then reports what the runtime costs per commit over hand-rolling the same serialization. |
| `demo:fencing` | A handler that ignores its timeout, runs to completion, tries to commit, and is refused. Plus `commit.raced`, where a commit that already reached the store stands. |
| `demo:stuck` | "Everything stuck in `deploying` for more than five minutes", as a query and as a constraint, on one injected clock. Two handlers accept the escalation and one declines it. |
| `demo:no-going-backwards` | A redelivered message tries to rewind an order. The same naive handler runs unconstrained, under `warn`, and under `reject`. |
| `demo:recovery` | Commit, crash without ceremony, restart, and everything resumes in its exact state with history intact. |
| `demo:memory-bound` | 5000 instances inside a 64 KB budget. Cold ones evict with a snapshot and reload transparently. |
| `demo:retention` | Bytes on disk as they accumulate. 400 commits to one key with the cap off and on, ending 80x apart with the same sequence and values. Then a budget pulled back under its ceiling by a sweep, and 40 finished instances pruned with `query` plus `forget`. |
| `demo:durability` | Four configurations the runtime refuses to start with, each with the message it prints, then the layered stack they were protecting. |
| `demo:coordination` | Two runtimes taking turns over one directory, 400 writes, and 44% of what was acknowledged missing afterwards. Nothing errors. Then the startup refusal that stops you configuring it, and the same load against a store that can see both writers. |
| `demo:execution-policy` | Retries, timeouts and backoff layered runtime to entity to state, field by field. A trigger queued behind a retrying attempt waits for it. |
| `demo:audit` | One audit sink that throws, one that hangs forever, one that is merely slow. Every commit lands anyway. |
| `demo:unknown` | A typo'd trigger type, and a deploy that removed a state instances were still sitting in. Both refused loudly and recorded. |

</details>

## Performance

| Workload | Throughput |
|---|---|
| One key, fully serialized | 280,000 commits/sec |
| 500 keys, handler returns immediately | 200,000 commits/sec |
| 50 keys, 1ms handler | 28,000 commits/sec |
| One key, 1ms handler | 838 commits/sec |
| 2,000-trigger burst against a 128-deep inbox | settles in 19ms |

A single commit costs a few microseconds, so anything that touches a database, a queue or the
network is three orders of magnitude slower than the machinery around it. Per-key ordering is not
a throughput ceiling: one key with a 1ms handler does 838 commits a second and fifty keys do
28,000, because handlers overlap across keys while each key stays strictly in order.

```
npm run bench                 # every suite
npm run bench -- edge-check   # one suite
```

Per-operation figures, the cost of turning constraint enforcement up, what each suite measures and
what it deliberately does not are in [`benchmarks/README.md`](./benchmarks/README.md). These
figures are the runtime with no store configured: what Ekman adds to your handler, not what your
whole system will do.

## Conformance

Ekman's behaviour is defined by a language-agnostic scenario suite in
[`scenarios/`](./scenarios), which every implementation copies verbatim and runs through its own
public API. Passing the scenarios at a level is what it means to conform at that level.

This package targets **Ekman spec 0.1**.

| Level | Status | Covers |
|---|---|---|
| Core | **passing** | Entities, dispatch, commit, ordering, bounded inbox, execution policy, fencing, constraints, memory budget, telemetry |
| Durable | **passing** | Durable store, replay, snapshot on evict, conditional append, audit, queries |
| Coordinated | not claimed | Multi-runtime conflict detection |

A level is claimed only when everything it requires is implemented, not when its scenarios happen
to pass. A partial claim is worse than no claim, because somebody will believe it.

```
npm run conformance
```

Reports pass or fail per scenario per level, and exits non-zero if a claimed level fails. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for running the suite against another implementation.

## Compatibility

| | |
|---|---|
| Node | 20 or newer |
| Module formats | ESM (`import`) and CommonJS (`require`), both shipped |
| TypeScript | Types bundled. Resolves under `NodeNext`, `Bundler` and `Node16`. |
| Runtime dependencies | None |

## Documentation

[docs/](./docs) has the full reference.

| Page | Covers |
|---|---|
| [Concepts](./docs/concepts.md) | The execution model, keys, per-key ordering, what a commit is |
| [Entities](./docs/entities.md) | `defineEntity`, handlers, results, error handlers, unknown policy |
| [Runtime and API](./docs/api.md) | Every config option and every method |
| [Ordering and the inbox](./docs/ordering.md) | Capacity and the three overflow policies |
| [Execution policy](./docs/execution.md) | Retries, timeouts, backoff, fencing |
| [Constraints](./docs/constraints.md) | Graphs, guards, invariants, time bounds, graph discovery |
| [Durability and stores](./docs/durability.md) | Store kinds, layering, compaction, retention |
| [Memory and eviction](./docs/memory.md) | The byte budget and eviction policies |
| [Queries and history](./docs/queries.md) | `query`, `history`, and the partiality contract |
| [Telemetry and audit](./docs/telemetry.md) | The runtime's own event stream, and audit sinks |
| [Error codes](./docs/errors.md) | Every code, and a suggested HTTP mapping |

## Scope

- **Nothing to deploy or operate.** Ekman is constructed in your process. There is no server, cluster, sidecar or control plane.
- **States are data, handlers are functions, configuration is code.** There is no workflow DSL to learn.
- **Transport-agnostic.** Kafka messages, HTTP requests, timers and direct calls are all triggers.
- **The transition log is the source of truth**, and cache layers are derived from it. Ekman does not coordinate distributed transactions.
- **Durability exists when you configure a store.** Memory-only is a valid and intentionally ephemeral mode.

## Design principles

1. Semantic structure is the product. Ekman removes repetitive state mechanics, not branch instructions.
2. One active handler per key; later triggers queue in a bounded inbox.
3. Memory is a first-class, budgeted resource with explicit eviction.
4. Domain state and runtime state are separate: `pending` is yours; `busy`, retry count and queue depth are Ekman's.
5. Unknown is never silent.

The server runtime is the reference target. The behavioral contract is written so client and
embedded implementations remain possible.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) covers the development
setup, the checks a change has to pass, and how to add a conformance scenario. Participation is
governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).

Note that contributions are made under an inbound copyright assignment, and the project may be
relicensed at the maintainer's discretion. Read
[Contributor copyright assignment and relicensing](./CONTRIBUTING.md#contributor-copyright-assignment-and-relicensing)
before submitting one.

## License

Apache-2.0. See [LICENSE](./LICENSE).
