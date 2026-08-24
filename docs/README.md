# Ekman documentation

[Back to the main README](../README.md)

Start with the [main README](../README.md) for the install line and a quickstart that runs.
These pages are the depth behind it.

## Reading order

If you are working out whether Ekman fits, read the first two. If you are building something,
read the first four and come back for the rest.

| Page | What it covers |
|---|---|
| [Concepts](./concepts.md) | The execution model: keys, instances, per-key ordering, and what a commit is. |
| [Entities](./entities.md) | `defineEntity`, handler signatures, `transitionTo` / `stay` / `fail`, error handlers, unknown policy. |
| [Runtime and API](./api.md) | Every `new Ekman({...})` option and every method on the runtime. |
| [Ordering and the inbox](./ordering.md) | The bounded per-key inbox, capacity, and the three overflow policies. |
| [Execution policy](./execution.md) | Retries, timeouts, backoff, and the fencing token that makes a zombie handler harmless. |
| [Constraints](./constraints.md) | Transition graphs, guards, invariants, time-in-state bounds, and discovering a graph from real traffic. |
| [Durability and stores](./durability.md) | Store kinds, layering, capability declaration, log compaction, retention. |
| [Memory and eviction](./memory.md) | The byte budget, how instances are accounted, and the three eviction policies. |
| [Queries and history](./queries.md) | `query`, `history`, and the partiality contract that keeps a partial answer from reading as a complete one. |
| [Telemetry and audit](./telemetry.md) | The runtime's own event stream, kept separate from per-key history, and audit sinks. |
| [Error codes](./errors.md) | Every code Ekman raises, what it means, and a suggested HTTP mapping. |

## Related

- [`examples/deploy-service`](../examples/deploy-service) is a working service built on Ekman.
- [`demos/`](../demos) has runnable programs, one per behaviour, each asserting rather than printing.
- [`scenarios/`](../scenarios) is the language-agnostic conformance suite.
- [`benchmarks/`](../benchmarks) is what the performance figures come from.
