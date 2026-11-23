# Architecture

[Back to the docs index](./README.md)

This page is for people changing Ekman, or writing a second implementation of it. It says
which module owns what, what each must not know about, and which parts of the public surface
would have to change before the runtime could be split across threads. If you are using Ekman,
you do not need it.

## Module map

Everything is in `src/`, and `src/index.ts` is the only public entry point. The modules fall
into five groups, ordered from what stands alone to what ties everything together.

### Definitions: no runtime anywhere

| Module | Owns | Must not know about |
|---|---|---|
| `key.ts` | The key grammar: parsing, building, and why a segment is refused. | Entities, stores. |
| `results.ts` | The four results a handler can return, and telling a result from anything else. | What happens to a result. |
| `values.ts` | Copying and freezing values where they become committed state. | Who commits them. |
| `states.ts` | The states an entity has and the moves between them it allows. | Handlers, instances. |
| `policy.ts` | Execution policy: attempts, timeout, backoff, and how the three layers merge. | What an attempt runs. |
| `constraints.ts` | Compiling the six constraint kinds, and checking the three that refuse a result. | When a check is made. Delivering a trigger. |
| `entity.ts` | `defineEntity`: validating a config and producing a definition. | Any runtime. A definition can be registered with several. |
| `compiled.ts` | The one place the runtime reads a definition's compiled internals. | Everything else. It is a door, not a room. |
| `analysis.ts`, `diagram.ts`, `observed.ts` | Reading an entity's shape, drawing it, and folding real transitions out of a stream. | The runtime. They work on a definition or on events. |

### One key

| Module | Owns | Must not know about |
|---|---|---|
| `inbox.ts` | Order and capacity for one key: the queue, the overflow policy, one trigger running at a time. | Entities, handlers, stores. It runs a closure it is given. |
| `fence.ts` | The commit token: what binds an attempt to the sequence it started from, and what invalidates it. | Why an attempt was superseded. |
| `instance.ts` | One instance's committed state, its stream, and the single gate every commit goes through. Loading and reloading from the store. | Other keys. Which handler produced a result. |
| `dispatch.ts` | Running one trigger: choosing the handler, the attempt loop, constraints, the commit, the refusal. | The inbox. It assumes the key's turn has been taken. |
| `temporal.ts` | The index of keys by entity and state, and the latch that says which bounds and rules have fired for an instance. | Scanning stores. Sending triggers. |

### Storage

| Module | Owns | Must not know about |
|---|---|---|
| `store.ts` | The adapter contract, and the helpers every adapter shares: replay, sequence arithmetic. | Any particular store. |
| `stores/memory.ts`, `stores/file.ts` | Durability, and an honest declaration of what each can do. | Entities, handlers, the runtime that uses them. |
| `stores/contract.ts` | The test suite an adapter proves itself with. | A test framework. It takes one structurally. |
| `stack.ts` | Turning the `store` option into layers, and choosing the one commit authority. | What is written to them. |
| `caches.ts` | The layers that are not the authority: reads, writes, time bounds, suspension. | Committed truth. A cache can be wrong and the runtime still be right. |

### The runtime's parts

Each of these is handed one `RuntimeDeps` (`config.ts`): the clock, telemetry, the stores, the
memory configuration, and the hooks back into the runtime. There is one bag so there is one
clock and one place each dependency is defined.

| Module | Owns | Must not know about |
|---|---|---|
| `residency.ts` | What is in memory. See [the residency unit](#the-residency-unit). | Handlers, constraints, what a trigger means. |
| `memory.ts` | The budget's configuration, the accounting basis, and the ledger of bytes in least-recently-used order. | Instances. It counts what it is told. |
| `query.ts` | The read path: `query`, the state map, `history`, and the store scan with whatever filtering a store could not do. | Writing anything. |
| `sweep.ts` | The two passes the runtime makes by itself: time, raising what each bound is owed, and storage, reclaiming what each layer can. | Committing. An escalation is sent as a trigger. |
| `rules.ts` | Condition rules: asked after each commit, proposing a state as a trigger. | Committing. A proposal is sent as a trigger. |
| `audit.ts` | Delivering committed events to audit sinks, off the commit path, with bounded retries. | Whether the commit should have happened. |
| `telemetry.ts` | The runtime's own event stream and the sink that receives it. | The per-key event stream. The two never mix. |

### The runtime

`ekman.ts` is what is left: the registry of entities and their handles, the entry points
(`send`, `post`, `inspect`), trigger ids, the glue between an inbox turn and a dispatch,
deletion, and shutdown. It builds the parts above and delegates to them.

Two rules cross every module and are easy to break in a refactor:

- **Nothing is awaited between a `send()` and the push onto the key's inbox.** Call order is
  queue order. A load from the store happens inside the key's turn, never before it.
- **A runtime with no store reaches the handler in the same turn it always has.** Adding an
  `await` on that path delays `handler.started` by a microtask and changes how telemetry
  interleaves with the sends around it, which conformance scenarios observe.

## The residency unit

Three structures describe what is in memory, and they have to agree:

- the **table** of instance records, by key;
- the **ledger** of what each costs, in least-recently-used order;
- the **index** of keys by entity and state, which the time pass and the queries read.

`Residency` holds all three and is the only thing that writes to any of them. Its operations
are the ones that touch more than one:

| Operation | Table | Ledger | Index |
|---|---|---|---|
| `materialize` | adds the record | records its bytes | enters it, unless it still has to load |
| `loaded` | | records its bytes | enters it in the state the store held |
| `committed` | | records its bytes | re-enters it, when the commit moved it |
| `offer` (a key went idle) | may release | may release | may release |
| `evict` | releases | releases | releases |
| `release` | removes the record | releases its bytes | removes it |

It decides nothing about the truth. Eviction snapshots before it releases, and deletion
removes the stream afterwards, and both are the caller's business. Only an idle record is
ever evicted: one with a handler running or a trigger waiting is skipped however far over
budget the runtime is.

This is the unit a shard would own. A thread that owned a set of keys would own exactly one
`Residency`, with its own budget and its own index.

## What sharding would change

Ekman runs in one isolate. Per-key ordering is a queue per key and needs no locks. Running
instances across worker threads is not built, and it must not change what `send` means when it
is. This section records what in today's public surface could not survive it unchanged, so
that nothing here is frozen at 1.0 by accident.

**Additive: can be added later without breaking anything.**

| Today | With shards |
|---|---|
| `entities: [definition]` takes a definition built in this process. | A worker cannot be handed a closure, so it would load definitions by module path. A path form can join the `entities` list as a second kind of member. |

**Breaking: a decision is needed before 1.0.**

| Today | Why it breaks | Smallest change that makes it additive |
|---|---|---|
| `inspect`, `residentMap`, `residentKeys`, `entityNames`, `memoryUsage`, `storageUsage` answer synchronously. | An answer held by another thread cannot be read synchronously. | An async variant of each, added now, with the synchronous one documented as answering for this thread only. |
| `now`, `onUnhandled`, `telemetry`, `audit[].deliver`, `memory.sizeOf`, `execution.retryable` are functions passed in config. | A function cannot cross to a worker. | A module-path form for each option that takes a function. |
| A store is passed as an instance. | An instance cannot cross either. | The descriptor form (`"file"`, `{ kind: "file", ... }`) already crosses. An adapter needs a path form. |
| Handlers, `classify`, guard and invariant checks, and a rule's `when` are functions inside a definition. | Same reason. | Solved by loading the definition by module path, above. |
| `query({ where })` takes a function per call. | It would have to run where the values are. | Run it on each shard's answer in the calling thread, at the cost of moving the values. |
| Trigger ids come from one counter per runtime: `t1`, `t2`, and so on. | Two shards would both issue `t1`. | A shard prefix. The conformance suite asserts these ids, so this changes the contract and not only the API. |
| `memory.maxBytes` is one budget. | Each shard evicts for itself. | A per-shard budget declared in config, with the single figure meaning the sum. |

None of these has to be decided to ship 0.x. All of them have to be decided before 1.0,
because after it each one costs a major version.

## Next

- [Concepts](./concepts.md) for the model these modules implement.
- [Durability and stores](./durability.md#writing-a-store-adapter) for the adapter contract.
- [`scenarios/`](../scenarios) for the behaviour a second implementation has to match.
