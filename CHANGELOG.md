# v0.1.0 (Mon Aug 24 2026)

The initial release: an embedded runtime for addressable stateful instances.

- **Entities and dispatch.** `defineEntity` maps states to handlers. A handler returns `transitionTo`, `stay` or `fail`, and nothing else commits. A trigger nothing handles is refused and recorded, never dropped.
- **A bounded inbox per key.** One handler runs per key at a time, in arrival order, with `reject`, `drop-newest` and `drop-oldest` overflow policies.
- **Execution policy and fencing.** Retries, timeouts and backoff per runtime, entity or state. A timed-out or superseded attempt cannot commit.
- **Four kinds of constraint.** A transition graph, guards, invariants and time-in-state bounds, each with `reject`, `warn` or `off`. The entity state graph checks transitions and can be exported as a diagram ([#1](https://github.com/dlynch42/ekman-ts/pull/1)).
- **A memory budget.** Resident instances are accounted in bytes and idle ones are evicted, then reloaded transparently.
- **Memory and file stores.** Layered stacks with one commit authority, log compaction and retention.
- **Queries and history.** Instances by state and time in state, and the full per-key event stream, with an answer that says when it is partial.
- **Audit sinks and telemetry.** Copies of committed events out of band, and the runtime's own event stream kept apart from domain history.
- **A conformance suite.** Language-agnostic scenarios, passing at the Core and Durable levels.

#### Authors: 1

- Devin Lynch ([@dlynch42](https://github.com/dlynch42))
