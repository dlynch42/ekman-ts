# Ekman

**Declarative, embeddable state management for backend services.**

Define your states. Attach handlers. Configure the runtime. Ekman owns the mechanics around state (per-instance memory, ordered processing, transitions, constraints, retries, persistence, history) without requiring a separate orchestration platform.

> **Status: v0.1 in progress.** The TypeScript reference implementation passes the Core and Durable conformance levels. Go to follow. Feedback welcome.

---

## The problem

Stateful backend logic starts simple and degrades into scattered control flow:

- A 1,200-line file of `switch`/`case` blocks, duplicated across every service that touches the same workflow.
- Transitions, retries, memory updates, and failure paths manually coordinated by application code.
- No answer to "what state is deployment `abc123` in right now?" without querying multiple systems.
- No answer to "show me everything stuck in `deploying` for more than 5 minutes."
- Cache, in-process memory, and the database silently disagreeing about an instance's state.
- Concurrent triggers reaching the same instance while its previous work is still running.

Orchestration platforms solve this by making you deploy and operate their runtime. State machine libraries solve dispatch, but leave identity, ordering, persistence, retries, and querying to you.

Ekman is the middle: **a runtime you embed, not a platform you operate.**

## What it looks like

```ts
// Define an entity: states → handlers, once, in its own file
export const deployments = defineEntity("deployments", {
  initial: "pending",
  states: {
    pending:   handlePending,
    // A state that talks to something flaky can carry its own execution policy
    deploying: { handler: handleDeploying, maxAttempts: 5, timeoutMs: 30_000 },
    failed:    handleFailed,
  },
  onError: { unauthorized: handleUnauthorized },
  unknown: "reject",
  // Opt-in strictness, each piece with its own reject / warn / off dial
  constraints: {
    transitions: { allow: { pending: ["deploying"], deploying: ["live", "failed"] } },
    guards:      [{ on: "deploying", check: (next) => next.values.region !== undefined }],
    invariants:  [{ name: "attempts-sane", check: (next) => next.values.attempts >= 0 }],
    temporal:    [{ in: "deploying", within: 10 * MINUTE, escalateTo: "failed" }],
  },
})

// Configure the runtime once at the entrypoint
export const ekman = new Ekman({
  entities: [deployments],
  memory:   { maxBytes: 32 * MB, eviction: { policy: "lru", snapshotOnEvict: true } },
  inbox:    { capacity: 128, overflow: "reject" },   // 128 triggers waiting per key, not bytes
  execution: { maxAttempts: 3, timeoutMs: 10_000, backoff: { kind: "exponential", baseMs: 50 } },
  temporal: { sweepMs: 1_000 },                      // how often time-in-state bounds are checked
  store:    ["memory", "file"],                      // fastest first; the last durable layer owns the truth
  audit:    [kafkaSink("state-transitions")],
  telemetry: {
    "inbox.dropped":   (e) => metrics.inc("ekman.inbox.dropped", { entity: e.entity }),
    "handler.settled": (e) => metrics.observe("ekman.handler.ms", e.durationMs),
  },
})

// Anywhere in your app: address an instance by key, send it a trigger
await ekman.entities.deployments.send("abc123", message)
await ekman.send("deployments:abc123", message)

// Debug and operate
await ekman.query({ entity: "deployments", state: "deploying", olderThan: "5m" })
await ekman.history("deployments:abc123")
```

Every instance gets a human-readable key, its own state and values, a bounded inbox that serializes its triggers, and an append-only transition history. Unknown states and triggers fail loudly.

Constraints (transition graphs, guards, invariants, time-in-state bounds) are opt-in, each with a `reject` / `warn` / `off` dial. `warn` is the point of the dial: turn a constraint on in `warn`, read the violations your real traffic produces, and switch to `reject` once you know what your graph actually is. Violations land in the same per-key stream as transitions under either policy, so "everything that would have been refused last week" is one query rather than a log-scraping exercise. A refused result is classified, so `onError` can catch it and commit something legal instead.

A time-in-state bound fires as a *trigger*, never as a write. The runtime hands your handler the escalation and your handler decides, exactly as with any other input, which keeps every state change attributable to one piece of your code. Evaluate on your own schedule with `temporal: { sweepMs }`, or call `await ekman.sweep()` yourself.

```
npm run demo:no-going-backwards   # a redelivered message tries to rewind an order
```

That one is worth running. Queues redeliver, and a handler written to "just apply the message" will happily walk a shipped order back to `paid` without anything failing. The same naive handler runs three times: unconstrained, in `warn`, and in `reject`. It is one of ten runnable demos, listed [further down](#demos).

The inbox is bounded in **triggers, not bytes**: `capacity` is how many triggers may wait behind the one being handled, and is unrelated to `memory`, which is the byte budget. A `capacity` of 0 means one at a time with no backlog. When it fills, the overflow policy decides, and the sender always finds out. `reject` is backpressure (`INBOX_OVERFLOW`, the trigger did not land); `drop-newest` and `drop-oldest` are shedding (`TRIGGER_DROPPED`, the trigger is gone on purpose). Overflow is always visible in telemetry, and never in the transition history unless you ask for it with `recordOverflow`.

Retries, timeouts, and backoff are the runtime's job, not your handler's. Configure them once on the runtime, override them per entity or per state, and write handlers that do the work and nothing else. During retries the key stays occupied, so a queued trigger can never slip past an attempt in flight.

A running JavaScript function cannot be stopped, so a timeout does two things: it aborts `ctx.signal` for handlers that watch it, and it invalidates the attempt's commit token for those that do not. The abandoned handler keeps running, eventually tries to commit, and is refused. That is what makes a zombie harmless rather than merely unlikely.

Telemetry is a separate stream from history, by design. Queue depth, handler duration, drops, and retries are Ekman's business; your transition history stays domain-only. Handlers are keyed by event name with `"*"` as the catch-all, so there is no event union to narrow.

## Durability

Durability is configured, never implied. Omit `store` and you get a memory-only runtime: nothing survives the process, and nothing pretends to. That is a documented mode, not a degraded one.

Configure one and commits are written before they are applied. A `send()` that resolves has already reached the commit authority, so a crash a microsecond later loses nothing. Stores layer, fastest first, and exactly one layer owns the truth: the rest are caches, written after the fact, and a cache that fails to write is reported without failing the commit.

Stores are named rather than constructed: `store: "file"` is durable, `store: "memory"` is an in-process event log, and `store: "none"` says out loud that this runtime keeps nothing. An adapter Ekman does not ship is passed as an instance instead, so configuring a store never means importing a database client you are not using.

`"file"` writes to `.ekman/logs/`, found by walking up from the working directory to the nearest `package.json`, so the same service finds the same state however it was launched. Pass `{ kind: "file", dir }` to put it somewhere else. A deployment with no `package.json` beside it, such as a bundled single-file build, should name the path explicitly rather than take the default.

Each log compacts once it passes 5MB: the events already folded into a snapshot are dropped, so current state and replay are untouched and only `history()` shortens, reporting itself incomplete when it does. `ekman.storageUsage` answers what the durable layers are holding. Give it a ceiling with `retention: { totalBytes }` and it is measured against one; add `policy: "reject"` and new instances are refused rather than filling the disk. Deleting is never automatic: `forget(id)` destroys an instance outright, and a retention sweep is that plus the `query()` you already have.

Every store declares what it can actually do (durable or ephemeral, conditional append, safe across processes), and the runtime **refuses configurations those declarations cannot satisfy** rather than quietly under-delivering. Claiming durability a store does not have is the one lie a state runtime must never tell.

Memory is a budget you set, not a hope. Resident instances are accounted at commit, in UTF-8 bytes of the key, the state name and the serialized values, which is a number you can reason about because it is roughly what the instance costs to persist. When the budget is full:

- `lru` releases the coldest **idle** instances, snapshotting them on the way out.
- `reject` refuses to materialize new instances and leaves the resident ones working.
- `none` measures and reports without acting, which is how you learn what your real working set is before enforcing a limit on it.

Eviction only ever touches idle instances, and only once a key goes idle, so a commit in flight can never be thrown away. A trigger for an evicted instance reloads it transparently: your code cannot tell a resident instance from one that just came back off disk.

```
npm run demo:recovery       # commit, crash, restart, everything resumes
npm run demo:memory-bound   # 5000 instances inside a 64 KB budget
npm run demo:retention      # a log that compacts, a budget, and a delete you ask for
npm run demo:durability     # four configurations the runtime refuses to start with
```

## Asking the questions you actually have

"What is stuck in `deploying`, and for how long" is the question that makes a state runtime worth embedding, and the one homegrown versions never answer.

```ts
const stuck = await ekman.query({
  entity: "deployments",
  state: "deploying",
  olderThan: "5m",         // or a number of milliseconds
})

for (const instance of stuck.instances) {
  console.log(instance.key, instance.state, instance.ageMs)
}
```

Results come back oldest-first, which is the order the question is asked in. Time in state is measured from the last **move**, so a handler that updates a progress counter every second does not keep resetting the clock on something that has not gone anywhere. That is the same measurement a time-in-state constraint uses, deliberately: two implementations of one question is how two answers start disagreeing.

`history(key)` returns the whole per-key stream, reading through the store: transitions, refused triggers, constraint violations, and reloads, in order, so "what happened to this instance" is one call.

Every result says whether it is the whole answer:

```ts
const { instances, complete, reasons } = await ekman.query({ entity: "deployments" })
if (!complete) {
  // e.g. ["no-durable-store"], ["limit-reached"], ["unsupported-criteria"]
}
```

A memory-only runtime can only report what it retains, and a store that cannot evaluate a filter says so rather than quietly ignoring it. Returning a partial answer as if it were complete is the one thing a query here will never do, because an operator acting on "nothing is stuck" needs that to have meant it.

## Demos

Every claim on this page has something runnable behind it. Each demo asserts rather than
only printing, so a broken claim fails the run instead of scrolling past, and each one ends
by saying what its output means.

| Command | What it makes checkable |
|---|---|
| `demo:ordering` | Five triggers at one slow key, doing a read-modify-write with an `await` in the middle, and not one lost update. No lock anywhere in the handler. Ends with a full queue refusing a trigger. |
| `demo:fencing` | A handler that ignores its timeout, runs to completion, tries to commit, and is refused. Plus `commit.raced`, the honest counterpart, where a commit that already reached the store stands. |
| `demo:stuck` | "Everything stuck in `deploying` for more than five minutes", as a query and as a constraint, on one injected clock. Two handlers accept the escalation and one declines it. |
| `demo:no-going-backwards` | A redelivered message tries to rewind an order. The same naive handler runs unconstrained, under `warn`, and under `reject`. |
| `demo:recovery` | Commit, crash without ceremony, restart, and everything resumes in its exact state with history intact. |
| `demo:memory-bound` | 5000 instances inside a 64 KB budget. Cold ones evict with a snapshot and reload transparently. |
| `demo:retention` | The other axis: bytes on disk. A log compacting under a cap, a budget that measures before it enforces, a retention sweep built from `query` plus `forget`, and a delete refused because the key was busy. |
| `demo:durability` | Four configurations the runtime refuses to start with, each with the message it actually prints, then the layered stack they were protecting. |
| `demo:execution-policy` | Retries, timeouts and backoff layered runtime → entity → state, field by field. A trigger queued behind a retrying attempt waits for it. |
| `demo:audit` | One audit sink that throws, one that hangs forever, one that is merely slow. Every commit lands anyway. |
| `demo:unknown` | A typo'd trigger type, and a deploy that removed a state instances were still sitting in. Both refused loudly and recorded. |

## What it looks like in a real service

[`examples/deploy-service`](./examples/deploy-service) is a small deployment tracker built
the way you would actually build one: two entities, an HTTP API, a queue consumer, and one
runtime shared by both.

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

The route handlers are the point. They read a request, `send()` a trigger, and shape the
answer: no locks, no transactions, no read-modify-write, no retry loops. Two requests for
the same deployment arriving at the same instant need nothing there to be safe. What error
codes mean over HTTP is a lookup table, because every failure carries a stable one:
`CONSTRAINT_VIOLATED` is a 409 and the client should stop, `INBOX_OVERFLOW` is a 503 with
`Retry-After` and the client should not.

Then stop the process and start it again. Everything is still there.

## What it is not

- **Not an orchestration platform.** No mandatory server, cluster, sidecar, or control plane.
- **Not a workflow DSL.** States are data, handlers are functions, configuration is code.
- **Not tied to any transport.** Kafka messages, HTTP requests, timers, and direct calls are all just triggers.
- **Not a distributed transaction coordinator.** The transition log is the source of truth; caches are derived.
- **Not automatically durable.** Memory-only configuration is valid and intentionally ephemeral; durability exists when you configure a durable store.

## Design principles

1. Semantic structure is the product. Ekman removes repetitive state mechanics, not branch instructions.
2. One active handler per key; later triggers queue in a bounded inbox.
3. Memory is a first-class, budgeted resource with explicit eviction.
4. Domain state and runtime state are separate: `pending` is yours; `busy`, retry count, and queue depth are Ekman's.
5. Unknown is never silent.

The server runtime is the reference target. The behavioral contract is written so client and embedded implementations remain possible.

## Conformance

Ekman's behaviour is defined by a language-agnostic scenario suite in [`scenarios/`](./scenarios),
which every implementation copies verbatim and runs through its own public API. Passing the
scenarios at a level is what it means to conform at that level.

| Level | Status | Covers |
|---|---|---|
| Core | **passing** | Entities, dispatch, commit, ordering, bounded inbox, execution policy, fencing, constraints, memory budget, telemetry |
| Durable | **passing** | Durable store, replay, snapshot on evict, conditional append, audit, queries |
| Coordinated | not claimed | Multi-runtime conflict detection |

A level is claimed only when everything it requires is implemented, not when its scenarios
happen to pass. A partial claim is worse than no claim, because somebody will believe it.

```
npm run conformance
```

Reports pass or fail per scenario per level, and exits non-zero if a claimed level fails.

## Roadmap

- **v0.1**: TypeScript reference implementation. Entities, dispatch, per-key inbox, retries/timeouts/fencing, constraints (transition graph, guards, invariants, temporal), memory budget and eviction, memory and file stores, storage retention, transition history, queries, audit sinks. Passes Core and Durable.
- **v0.2**: Redis adapter, Kafka trigger adapter.
- **v0.3**: Postgres adapter, multi-runtime conflict detection (the Coordinated level).
- **v0.4**: Go implementation against the conformance suite.

Multi-runtime coordination sits with the adapters rather than ahead of them, because it is
not something a runtime can provide on its own: it needs a store whose conditional append is
atomic between processes, and neither of the two that ship today can honestly claim that.
Asking for it on a store that cannot is refused at startup rather than quietly
under-delivered.

**Killer demo:** kill a service mid-workflow, restart it, and watch every instance resume in its exact state with full history intact.

---

*License: Apache-2.0.*
