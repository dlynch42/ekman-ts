# Ekman

**Per-key memory and state for the things your service watches. Embedded, budgeted, queryable.**

[![npm](https://img.shields.io/npm/v/ekman.svg)](https://www.npmjs.com/package/ekman)
[![license](https://img.shields.io/npm/l/ekman.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/ekman.svg)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

Every key is one thing your service keeps track of: a deployment, an upstream API, a tenant, a
device. Ekman holds what the service knows about it, in memory you have given a budget. Its
state follows from that memory, through rules and time bounds you declare and handlers that
decide. One call shows where the whole fleet is.

Around that it owns the operational layer that homegrown versions leave out: one trigger at a
time per key, transition history, constraints, retries and timeouts, and queries. There is no
server to deploy, no cluster to run, and no sidecar: it is a library you construct at your
entrypoint. A runtime you embed, not a platform you operate.

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

Node 22.12 or newer. Zero runtime dependencies. ESM and CommonJS entry points are both shipped and
TypeScript types are bundled, so `import` from an ESM project and `require` from a CommonJS one
both work with no configuration on your side.

## Quickstart

```ts check
import { defineEntity, Ekman, patch, stay, transitionTo } from "ekman";
import type { RuleTrigger, StaleTrigger } from "ekman";

type State = "healthy" | "degraded" | "unreachable";
type Probe = { type: "probe"; ok: boolean; latencyMs: number };

// 1. What a service can be sent: a probe, or a proposal the runtime raises from 3. below.
type ServiceTrigger = Probe | RuleTrigger<State> | StaleTrigger<State>;

// 2. What is remembered about each service, and how a probe updates it. No runtime here.
const services = defineEntity.withTriggers<ServiceTrigger>()("services", {
  initial: "healthy",
  values: { failures: 0, latencyMs: 0 },
  states: {
    healthy: (service, trigger) => {
      // A proposal carries the state it asks for. The handler decides, and this one agrees.
      if (trigger.type !== "probe") return transitionTo(trigger.propose ?? "degraded");
      // patch merges: say what was learned, and the rest is kept.
      const failures = trigger.ok ? 0 : service.values.failures + 1;
      return patch({ failures, latencyMs: trigger.latencyMs });
    },
    degraded: (_service, trigger) => {
      if (trigger.type !== "probe") return transitionTo(trigger.propose ?? "unreachable");
      return trigger.ok
        ? transitionTo("healthy", { failures: 0, latencyMs: trigger.latencyMs })
        : patch({ latencyMs: trigger.latencyMs });
    },
    unreachable: (_service, trigger) =>
      trigger.type === "probe"
        ? transitionTo("healthy", { failures: 0, latencyMs: trigger.latencyMs })
        : stay(),
  },
  // 3. When state should change. Neither handler above compares a counter or reads a clock.
  constraints: {
    rules: [{ in: "healthy", when: (s) => s.values.failures >= 3, propose: "degraded" }],
    stale: [{ after: 60_000, propose: "unreachable" }],
  },
});

// 4. Build the runtime once, at your entrypoint. No store means memory only.
//    The clock is injected so this example can skip a minute. A service leaves `now` out.
let clock = Date.now();
const ekman = new Ekman({ entities: [services], now: () => clock });
const { send } = ekman.entities.services;

// 5. Record what was observed. Each send resolves when its commit lands.
await send("search-api", { type: "probe", ok: true, latencyMs: 40 });
await send("auth-api", { type: "probe", ok: true, latencyMs: 12 });
for (const latencyMs of [900, 1200, 1500, 1400]) {
  await send("payments-api", { type: "probe", ok: false, latencyMs });
}

// 6. A minute passes. Two services are still being probed. search-api has gone quiet.
clock += 61_000;
await send("auth-api", { type: "probe", ok: true, latencyMs: 15 });
await send("payments-api", { type: "probe", ok: false, latencyMs: 1300 });
await ekman.sweep();   // or `temporal: { sweepMs }` on the runtime, to sweep on a timer

// 7. Where the whole fleet is, in one call, and what one service knows.
const map = await ekman.map("services");
for (const [state, entry] of Object.entries(map.byState)) {
  console.log(state, entry?.count, entry?.keys);
}
console.log(ekman.entities.services.inspect("payments-api")?.values);

await ekman.close();
```

```
healthy 1 [ 'services:auth-api' ]
degraded 1 [ 'services:payments-api' ]
unreachable 1 [ 'services:search-api' ]
{ failures: 3, latencyMs: 1300 }
```

Nothing told `payments-api` to become `degraded`. Its third failed probe made the rule's
condition hold, the runtime sent the instance a `rule.matched` trigger proposing `degraded`,
and the handler agreed. Nothing told `search-api` it was `unreachable` either: it committed
nothing for a minute, the sweep noticed, and the freshness bound proposed it. Both arrive as
triggers, so every state change is still one handler returning `transitionTo`, and all of it is
in each key's history.

The keys of `states` are the only source of the state union, so `initial: "healthy"` is checked
and a typo is a compile error. The trigger union does the same for payloads: `trigger.latencyMs`
is a `number` once the type is narrowed to `probe`, and `entities.services.send` refuses anything
outside the union. Leave the union out, with plain `defineEntity("services", ...)`, and payload
fields are `unknown`. See [Typed triggers](./docs/entities.md#typed-triggers).

**Make it durable.** Nothing above survives the process. Name a store and it does:

```ts
const ekman = new Ekman({ entities: [services], store: "file" });   // writes to .ekman/logs/
```

Commits are written before they are applied, so a `send()` that resolves has already reached the
commit authority. What each instance knows, how long it has been in its state and when it was
last heard from all come back with it.

**Restrict which moves are legal.** Declare the graph and an illegal transition is refused before
it commits. Here a service that went `unreachable` does not come back on its own:

```ts
constraints: {
  transitions: {
    allow: { healthy: ["degraded", "unreachable"], degraded: ["healthy", "unreachable"], unreachable: [] },
  },
},
```

```
CONSTRAINT_VIOLATED | transitions: "unreachable" to "healthy" is not a declared transition.
From "unreachable" the declared targets are: (none)
```

## Why

A service that watches other things ends up remembering things about them, and the memory
drifts. A health map lives in one module, a retry counter in another, a "last seen" column in
a table somewhere, and none of them agree about what state the thing is in. Then the logic
around that memory degrades into scattered control flow:

- A large file of `switch`/`case` blocks, duplicated across every service that touches the same workflow.
- Transitions, retries, memory updates and failure paths coordinated by hand in application code.
- No answer to "what state is deployment `abc123` in right now?" without querying several systems.
- Concurrent triggers reaching the same instance while its previous work is still running.

Orchestration platforms address this by having you deploy and operate their runtime. State
machine libraries address dispatch, and leave identity, memory, persistence, retries and
querying to you. Ekman is the memory and the map, embedded: one place that holds what your
service knows about each key, decides its state one trigger at a time, and can say where every
one of them is. [How it compares](./docs/faq.md)

## Core concepts

Each of these has a full page in [docs/](./docs).

### Keys and instances

```ts
await ekman.send("services:payments-api", { type: "probe", ok: false, latencyMs: 900 });
```

A key is `<entity>:<segment>...`, and it is the identity of one thing your service watches. One
key owns one instance's state, values, inbox ordering, resident memory, persistence, sequence
numbering and history. Nothing is shared across keys, which is why nothing has to be locked
across them. [More](./docs/concepts.md)

### Memory

```ts
return patch({ latencyMs: trigger.latencyMs });   // merge what was learned; the rest is kept

memory: { maxBytes: 32 * 1024 * 1024, eviction: { policy: "lru", snapshotOnEvict: true } },
```

An instance's values are what the service knows about that key. `patch` merges one observation
into them, `stay` and `transitionTo` replace them, and every commit carries the whole of them
into history. Each instance also records when it entered its state and when it last committed
anything.

The memory has a budget. Instances are accounted at commit, in UTF-8 bytes of the key, state name
and serialized values. Eviction only touches idle instances, and reload is transparent: your code
cannot tell a resident instance from one that just came back off disk.
[More](./docs/memory.md)

### Rules and time bounds

```ts
constraints: {
  rules:    [{ in: "healthy", when: (s) => s.values.failures >= 3, propose: "degraded" }],
  stale:    [{ after: 60_000, propose: "unreachable" }],
  temporal: [{ in: "deploying", within: 10 * 60_000, escalateTo: "failed" }],
},
```

Three ways to say when state should change, none of which changes it. A rule watches a
condition over values and proposes a state once, when the condition comes to hold. A freshness
bound watches how long since an instance last committed anything, and fires once per silence.
A time-in-state bound watches how long an instance has sat in one state. Each arrives as a
trigger, so your handler decides, and each can run under `warn` first to show what it would
do. [More](./docs/constraints.md#rules-state-that-follows-from-memory)

### The state map

```ts
const map = await ekman.map("services");
// { byState: { healthy: { count: 397, keys: [...] }, degraded: { count: 3, keys: [...] } }, total: 400, ... }

const stuck = await ekman.query({ entity: "deployments", state: "deploying", olderThan: "5m" });
const quiet = await ekman.query({ entity: "services", staleFor: "5m", includeValues: true });
const { events } = await ekman.history("services:payments-api");
```

`map` is the whole fleet in one call: how many instances are in each state, and which. A query
narrows it by state, by time in state (`olderThan`, measured from the last move, so a handler
updating a counter does not reset it) and by time since the last commit (`staleFor`), carries
each match's values when asked with `includeValues`, and filters by them with `where`.
`history` is one key's whole ordered stream. Every result says whether it is the whole answer;
returning a partial one as if it were complete is the thing a query here will never do, because
an operator acting on "nothing is stuck" needs that to have meant it. [More](./docs/queries.md)

### Entities and handlers

<!-- check-docs:
import { defineEntity, stay, transitionTo } from "ekman";
-->
```ts check
type OrderTrigger = { type: "pay"; amount: number } | { type: "refund" };

const orders = defineEntity.withTriggers<OrderTrigger>()("orders", {
  initial: "pending",
  values: { total: 0 },
  triggers: ["pay", "refund"],          // anything else is refused and recorded
  states: {
    pending: (order, trigger) =>
      trigger.type === "pay" ? transitionTo("paid", { total: trigger.amount }) : stay(order.values),
    paid: (order) => stay(order.values),
  },
});
```

A handler receives the instance, the trigger and a context, and returns one of four results:
`transitionTo`, `stay`, `patch`, or `fail`. Nothing else commits, and throwing is equivalent to `fail`.
[More](./docs/entities.md)

### Constraints

```ts
constraints: {
  transitions: { allow: { pending: ["deploying"], deploying: ["live", "failed"] } },
  guards:      [{ on: "deploying", from: "pending", check: (n) => n.values.region !== undefined }],
  invariants:  [{ name: "attempts-sane", check: (n) => n.values.attempts >= 0 }],
},
```

The three kinds that refuse a result before it commits, beside the three above that propose.
All six are opt-in, each with its own `reject` / `warn` / `off` dial. `warn` lets you turn a
constraint on, read the violations real traffic produces, and switch to `reject` once you know
what your graph actually is; `observeEdges` and `allowFrom` turn those violations into the map to
paste back in. [More](./docs/constraints.md)

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

### Durability and stores

```ts
store: ["memory", "file"],   // fastest first; the last durable layer owns the truth
```

Durability is configured, never implied: omit `store` and nothing survives the process, which is a
documented mode rather than a degraded one. In a layered stack every commit goes to the authority
first, and a layer in front of it answers the load of an instance that is not resident. Every
store declares what it can do, and the runtime refuses configurations those declarations cannot
satisfy rather than quietly under-delivering.
[More](./docs/durability.md)

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
| `query(criteria)` | `Promise<QueryResult>` | Instances by entity, state and time in state, with their values on request. |
| `map(entity, options?)` | `Promise<StateMap>` | A count and the keys for each state an entity's instances are in. |
| `residentMap(entity)` | `StateMap` | **Synchronous.** The same map from resident instances only. |
| `forget(key)` | `Promise<void>` | Delete an instance from memory and every store layer. |
| `sweep()` | `Promise<number>` | Evaluate time-in-state constraints now. |
| `sweepStorage()` | `Promise<StorageSweep>` | Run the store's retention pass. |
| `close(options?)` | `Promise<void>` | Refuse new triggers, let in-flight work land up to `timeoutMs`, then close the stores. |
| `entities.<name>` | `EntityHandle` | Typed handle: `send`, `post`, `inspect`, `history`, `query`, `map`, `forget`, `key`, all by id. |
| `memoryUsage` / `storageUsage` | `{ bytes, ... }` | Resident bytes, and bytes on disk. |

### Exports

| Group | Names |
|---|---|
| Runtime | `Ekman` |
| Entities | `defineEntity`, `statesFromEntries` |
| Results | `transitionTo`, `stay`, `patch`, `fail` |
| Keys | `buildKey`, `parseKey`, `KEY_SEPARATOR` |
| Errors | `EkmanError`, `ConstraintViolationError`, `isEkmanError`, `isConstraintViolation`, `ERROR_CODES`, `ERROR_FALLBACK` |
| Events | `isTransitionEvent` |
| Diagrams | `analyze`, `toMermaid`, `toDot`, `observeEdges`, `allowFrom` |
| Stores | `createStore`, `defaultLogDir`, `replay`, `latestSeq`, `scanKeys`, `EMPTY_SEQ` |
| Option lists | `OVERFLOW_POLICIES`, `EVICTION_POLICIES`, `RETENTION_POLICIES`, `DEFAULT_CAPACITY` |
| Misc | `parseDuration`, `accountBytes`, `DEFAULT_TEMPORAL_TRIGGER`, `DEFAULT_RULE_TRIGGER`, `DEFAULT_STALE_TRIGGER`, `TELEMETRY_FALLBACK`, `SPEC_VERSION` |

That is every runtime export. The types they take and return are exported alongside them:
the config shapes (`EkmanConfig`, `EntityConfig`, `ExecutionPolicy`, `StorageConfig`), the
results (`CommitResult`, `QueryResult`, `StateMap`, `StorageSweep`), every event and telemetry event,
`TemporalTrigger`, the trigger a time-in-state bound delivers, `RuleTrigger` and `StaleTrigger`, the ones a
rule and a freshness bound deliver, `UnhandledContext`, what
`onUnhandled` is told about a failure, and `StateGraph`, the read-only view of an entity's
states.

Store adapters import from `ekman/store`, which carries the `Store` types, the helpers
`replay`, `latestSeq`, `previousSeq`, `scanKeys` and `EMPTY_SEQ`, and `storeContract`, the
test suite an adapter proves itself with. See
[Writing a store adapter](./docs/durability.md#writing-a-store-adapter).

### Handler context

`ctx` carries `key`, `entity`, `attempt` (1 on the first try, incrementing per retry), and
`signal` (an `AbortSignal` that aborts on timeout).

### Error codes

Every failure carries a stable `code`; branch on that rather than the message. The full table with
suggested HTTP mappings is in [docs/errors.md](./docs/errors.md). The distinction a caller needs
is that `CONSTRAINT_VIOLATED` will happen again in exactly the same way, and `INBOX_OVERFLOW` is
this instant only.

## Examples and demos

Two small services, each built the way you would actually build one.

[`examples/service-health`](./examples/service-health) is shaped like memory. Each key is a
dependency, its values are what has been observed about it, a rule and a freshness bound propose
its state, and `/map` says where all of them are.

```
npm run example:health         # start it and watch /map change
npm run example:health:smoke   # boot it on an ephemeral port, drive it end to end, assert
```

[`examples/deploy-service`](./examples/deploy-service) is shaped like a workflow: a deployment
tracker with two entities, an HTTP API, a queue consumer, and one runtime shared by both.

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
<summary>Fourteen runnable demos</summary>

Each demo asserts rather than only printing, so a broken claim fails the run instead of scrolling
past, and each ends by saying what its output means.

| Command | What it makes checkable |
|---|---|
| `demo:service-health` | Forty services remembered by key. Handlers only record probes: a rule proposes `degraded` after three failures in a row, a freshness bound proposes `unreachable` after a minute of silence, and one `map` call says where all forty are. |
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

This package targets **Ekman spec 0.1**, which it also exports as `SPEC_VERSION`.

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
| Node | 22.12 or newer |
| Module formats | ESM (`import`) and CommonJS (`require`), both shipped |
| TypeScript | Types bundled. Resolves under `NodeNext`, `Bundler` and `Node16`. |
| Runtime dependencies | None |
| Versioning | Pre-1.0, so minor versions may make breaking changes |

## Documentation

[docs/](./docs) has the full reference.

| Page | Covers |
|---|---|
| [Concepts](./docs/concepts.md) | The key as the identity of one thing, per-key ordering, what a commit is |
| [Memory and eviction](./docs/memory.md) | The byte budget and eviction policies |
| [Constraints](./docs/constraints.md) | Rules, freshness and time bounds, then graphs, guards, invariants, graph discovery |
| [Queries and history](./docs/queries.md) | `map`, `query`, `history`, and the partiality contract |
| [Entities](./docs/entities.md) | `defineEntity`, handlers, results, error handlers, unknown policy |
| [Runtime and API](./docs/api.md) | Every config option and every method |
| [Ordering and the inbox](./docs/ordering.md) | Capacity and the three overflow policies |
| [Execution policy](./docs/execution.md) | Retries, timeouts, backoff, fencing |
| [Handlers that own external resources](./docs/external-resources.md) | What the runtime cannot do for a handler that creates things outside it |
| [Durability and stores](./docs/durability.md) | Store kinds, layering, compaction, retention |
| [Telemetry and audit](./docs/telemetry.md) | The runtime's own event stream, and audit sinks |
| [Error codes](./docs/errors.md) | Every code, and a suggested HTTP mapping |
| [Questions people ask first](./docs/faq.md) | How this compares, and when not to use it |

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
