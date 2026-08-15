# Ekman

**Declarative, embeddable state management for backend services.**

Define your states. Attach handlers. Configure the runtime. Ekman owns the mechanics around state (per-entity memory, ordered processing, transitions, constraints, retries, persistence, history) without requiring a separate orchestration platform.

> **Status: design phase.** TypeScript reference implementation first, Go to follow. Feedback welcome.

---

## The problem

Stateful backend logic starts simple and degrades into scattered control flow:

- A 1,200-line file of `switch`/`case` blocks, duplicated across every service that touches the same workflow.
- Transitions, retries, memory updates, and failure paths manually coordinated by application code.
- No answer to "what state is deployment `abc123` in right now?" without querying multiple systems.
- No answer to "show me everything stuck in `deploying` for more than 5 minutes."
- Cache, in-process memory, and the database silently disagreeing about an entity's state.
- Concurrent triggers reaching the same entity while its previous work is still running.

Orchestration platforms solve this by making you deploy and operate their runtime. State machine libraries solve dispatch, but leave identity, ordering, persistence, retries, and querying to you.

Ekman is the middle: **a runtime you embed, not a platform you operate.**

## What it looks like

```pseudo
// Define a module: states → handlers, once, in its own file
deployments = Module("deployments")
  .on("pending",    handlePending)
  .on("deploying",  handleDeploying)
  .on("failed",     handleFailed)
  .onError("unauthorized", handleUnauthorized)
  .onUnknown(rejectAndLog)

// Configure the runtime once at the entrypoint
app = Ekman(
  memory: Memory(maxBytes: 32mb, eviction: LRU(snapshotOnEvict: true)),
  inbox:  Inbox(capacity: 128, overflow: "reject"),
  store:  [MemoryStore(), RedisStore(url), PostgresStore(dsn)],
  audit:  KafkaSink("state-transitions"),
)
app.register(deployments)

// Anywhere in your app: address an entity by key, send it a trigger
app.send("deployments:abc123", message)

// Debug and operate
app.query(module: "deployments", state: "deploying", olderThan: 5m)
app.history("deployments:abc123")
```

Every entity gets a human-readable key, its own state and values, a bounded inbox that serializes its triggers, and an append-only transition history. Unknown states and triggers fail loudly. Constraints (transition graphs, guards, invariants, time-in-state bounds) are opt-in, each with a `reject` / `warn` / `off` dial.

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

- **v0.1**: TypeScript reference implementation. Modules, dispatch, per-key inbox, memory budget, memory/file stores, transition history.
- **v0.2**: Redis adapter, query API, retries/timeouts, constraints (graph + guards).
- **v0.3**: Postgres adapter, invariants, temporal constraints, optimistic concurrency, Kafka adapters.
- **v0.4**: Go implementation against the conformance spec.

**Killer demo:** kill a service mid-workflow, restart it, and watch every instance resume in its exact state with full history intact.

---

*License: Apache-2.0.*
