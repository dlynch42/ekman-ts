# Ekman

**Declarative, embeddable state management for backend services.**

Define your states. Attach handlers. Configure the runtime. Ekman owns the mechanics around state (per-instance memory, ordered processing, transitions, constraints, retries, persistence, history) without requiring a separate orchestration platform.

> **Status: design phase.** TypeScript reference implementation first, Go to follow. Feedback welcome.

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
})

// Configure the runtime once at the entrypoint
export const ekman = new Ekman({
  entities: [deployments],
  memory:   { maxBytes: 32 * MB, eviction: { policy: "lru", snapshotOnEvict: true } },
  inbox:    { capacity: 128, overflow: "reject" },   // 128 triggers waiting per key, not bytes
  execution: { maxAttempts: 3, timeoutMs: 10_000, backoff: { kind: "exponential", baseMs: 50 } },
  store:    [memoryStore(), redisStore(url), postgresStore(dsn)],
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
ekman.query({ entity: "deployments", state: "deploying", olderThan: "5m" })
ekman.history("deployments:abc123")
```

Every instance gets a human-readable key, its own state and values, a bounded inbox that serializes its triggers, and an append-only transition history. Unknown states and triggers fail loudly. Constraints (transition graphs, guards, invariants, time-in-state bounds) are opt-in, each with a `reject` / `warn` / `off` dial.

The inbox is bounded in **triggers, not bytes**: `capacity` is how many triggers may wait behind the one being handled, and is unrelated to `memory`, which is the byte budget. A `capacity` of 0 means one at a time with no backlog. When it fills, the overflow policy decides, and the sender always finds out. `reject` is backpressure (`INBOX_OVERFLOW`, the trigger did not land); `drop-newest` and `drop-oldest` are shedding (`TRIGGER_DROPPED`, the trigger is gone on purpose). Overflow is always visible in telemetry, and never in the transition history unless you ask for it with `recordOverflow`.

Retries, timeouts, and backoff are the runtime's job, not your handler's. Configure them once on the runtime, override them per entity or per state, and write handlers that do the work and nothing else. During retries the key stays occupied, so a queued trigger can never slip past an attempt in flight.

A running JavaScript function cannot be stopped, so a timeout does two things: it aborts `ctx.signal` for handlers that watch it, and it invalidates the attempt's commit token for those that do not. The abandoned handler keeps running, eventually tries to commit, and is refused. That is what makes a zombie harmless rather than merely unlikely.

Telemetry is a separate stream from history, by design. Queue depth, handler duration, drops, and retries are Ekman's business; your transition history stays domain-only. Handlers are keyed by event name with `"*"` as the catch-all, so there is no event union to narrow.

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

## Roadmap

- **v0.1**: TypeScript reference implementation. Entities, dispatch, per-key inbox, retries/timeouts/fencing, memory budget, memory/file stores, transition history.
- **v0.2**: Redis adapter, query API, constraints (graph + guards).
- **v0.3**: Postgres adapter, invariants, temporal constraints, optimistic concurrency, Kafka adapters.
- **v0.4**: Go implementation against the conformance spec.

**Killer demo:** kill a service mid-workflow, restart it, and watch every instance resume in its exact state with full history intact.

---

*License: Apache-2.0.*
