# v0.2.0 (Mon Nov 23 2026)

### Release Notes

#### Closing track: a handler per trigger type, the runtime split along its seams ([#49](https://github.com/dlynch42/ekman-ts/pull/49))

A state can now name the trigger types it handles: `{ on: { pay: handler, cancel: handler } }`. The runtime picks the handler, and with `defineEntity.withTriggers` each one receives its own trigger type with no cast. A type the state has no entry for is refused with the new code `UNHANDLED_TRIGGER` and recorded in the instance's history. States written as a function are unchanged and still receive every type. A state declared as an object with neither `handler` nor `on` is now refused when the entity is defined. There is a new page for contributors, `docs/architecture.md`, and `replay`, `latestSeq`, `scanKeys` and `EMPTY_SEQ` are deprecated on the main entry point in favour of `ekman/store`.

#### EKM-32: Split the runtime class along its seams: residency, the read path, the sweeps and the rules ([#47](https://github.com/dlynch42/ekman-ts/pull/47))

No change in behaviour. The runtime's internals are split along their seams, and a new page, `docs/architecture.md`, says which module owns what and what running across threads would change in the public surface before 1.0.


---

<sub>Stack created with <a href="https://github.com/github/gh-stack">GitHub Stacks CLI</a> • <a href="https://gh.io/stacks-feedback">Give Feedback 💬</a></sub>

#### Store follow-ups: bounded cache calls, a shutdown that waits for a lasting cache, and a memory cache that holds state ([#45](https://github.com/dlynch42/ekman-ts/pull/45))

Cache layers in a layered store are now bounded in three ways. Calls into a cache have a time limit, `cache.timeoutMs`, 5 seconds by default: a cache that does not answer is treated as a miss or a failed write, and one that keeps failing to answer is no longer used, reported as `store.cacheSuspended`. `close()` waits, within its existing `timeoutMs`, for writes to a cache that outlives the process, and `runtime.closed` reports `cachePending`. A `"memory"` cache keeps the state of each key and not its whole stream, and a new `maxKeys` option limits how many keys it holds. Store adapters: the new `evicts` capability is optional.

#### Bound what a memory cache layer holds: state and not the stream, and a limit on keys ([#44](https://github.com/dlynch42/ekman-ts/pull/44))

A `"memory"` layer used as a cache now keeps the state of each key and not its whole event stream, so it no longer grows with a key's history. A new `maxKeys` option limits how many keys it holds, dropping the least recently used. Both `keep: "state"` and `maxKeys` are refused on a commit authority.

The output sample is written from what the tests assert, not captured from a run. One line in Additional Notes reads awkwardly ("A two-commit Additional Note from the existing tests"); replace it with "Two existing tests changed:" when you paste.

---

<sub>Stack created with <a href="https://github.com/github/gh-stack">GitHub Stacks CLI</a> • <a href="https://gh.io/stacks-feedback">Give Feedback 💬</a></sub>

#### Memory model: a state map, rules that propose, values as memory with a freshness clock, and a pitch to match ([#39](https://github.com/dlynch42/ekman-ts/pull/39))

Ekman can now be used as per-key memory. `patch` merges into an instance's values. Rules propose a state when a condition over those values comes to hold, and a `stale` bound proposes one when an instance has gone too long without a commit; both arrive as triggers, so the handler decides. `map` shows how many instances are in each state and which, queries can carry and filter by values and by time since the last commit, and every instance exposes `enteredAt` and `lastCommittedAt`. On an entity's handle a query is typed, so a misspelt state is a compile error. Store adapters: everything new is optional.

#### Re-pitch Ekman as per-key memory and state for the things a service watches ([#38](https://github.com/dlynch42/ekman-ts/pull/38))

The README now leads with what Ekman is for: per-key memory and state for the things a service watches. The quickstart shows a service recording probes with `patch`, a rule and a freshness bound proposing its state, and `map` showing the fleet. A new `examples/service-health` and `demo:service-health` run the same story end to end, and `docs/faq.md` answers how this compares with a state machine library, a platform, and a mutex.

---

<sub>Stack created with <a href="https://github.com/github/gh-stack">GitHub Stacks CLI</a> • <a href="https://gh.io/stacks-feedback">Give Feedback 💬</a></sub>

#### Temporal and coverage: bounds that hold for stored instances, audit sinks that see only commits, and a stricter store contract ([#32](https://github.com/dlynch42/ekman-ts/pull/32))

Time-in-state bounds now hold for instances a store holds and the runtime does not, and fire once per stay in a state across eviction and restarts. Audit sinks receive committed events only. Store adapters: `load` must also return refusals and violations recorded at the snapshot's sequence, a snapshot's `temporal` field must be kept, `usage` is a method, and `ScanResult.unsupported` is typed. `SPEC_VERSION` is exported.

#### Assert what the suite took on faith, and hold stores to more of the contract ([#31](https://github.com/dlynch42/ekman-ts/pull/31))

Store adapters: `usage`, where implemented, is now a method, and `ScanResult.unsupported` is typed as `"state" | "olderThan"`. `storeContract` gained cases for concurrent appends, snapshots, deletion, scans and compaction. `SPEC_VERSION` is exported.



---

<sub>Stack created with <a href="https://github.com/github/gh-stack">GitHub Stacks CLI</a> • <a href="https://gh.io/stacks-feedback">Give Feedback 💬</a></sub>

---

#### 🚀 Enhancement

- Release 0.2.0: hardening, the memory model, bounded cache layers and a handler per trigger type [#50](https://github.com/dlynch42/ekman-ts/pull/50) ([@dlynch42](https://github.com/dlynch42))
- Release candidate: runtime core, stores, surface and docs, temporal and coverage [#33](https://github.com/dlynch42/ekman-ts/pull/33) ([@dlynch42](https://github.com/dlynch42))

#### 🔩 Dependency Updates

- Closing track: a handler per trigger type, the runtime split along its seams [#49](https://github.com/dlynch42/ekman-ts/pull/49) ([@dlynch42](https://github.com/dlynch42))
- EKM-32: Split the runtime class along its seams: residency, the read path, the sweeps and the rules [#47](https://github.com/dlynch42/ekman-ts/pull/47) ([@dlynch42](https://github.com/dlynch42))
- Store follow-ups: bounded cache calls, a shutdown that waits for a lasting cache, and a memory cache that holds state [#45](https://github.com/dlynch42/ekman-ts/pull/45) ([@dlynch42](https://github.com/dlynch42))
- Bound what a memory cache layer holds: state and not the stream, and a limit on keys [#44](https://github.com/dlynch42/ekman-ts/pull/44) ([@dlynch42](https://github.com/dlynch42))
- Memory model: a state map, rules that propose, values as memory with a freshness clock, and a pitch to match [#39](https://github.com/dlynch42/ekman-ts/pull/39) ([@dlynch42](https://github.com/dlynch42))
- Re-pitch Ekman as per-key memory and state for the things a service watches [#38](https://github.com/dlynch42/ekman-ts/pull/38) ([@dlynch42](https://github.com/dlynch42))
- Temporal and coverage: bounds that hold for stored instances, audit sinks that see only commits, and a stricter store contract [#32](https://github.com/dlynch42/ekman-ts/pull/32) ([@dlynch42](https://github.com/dlynch42))
- Assert what the suite took on faith, and hold stores to more of the contract [#31](https://github.com/dlynch42/ekman-ts/pull/31) ([@dlynch42](https://github.com/dlynch42))
- Surface and docs: a settled public API, typed triggers, corrected docs, a hardened example and release pipeline [#26](https://github.com/dlynch42/ekman-ts/pull/26) ([@dlynch42](https://github.com/dlynch42))
- Split the release job, pin actions, raise the Node floor, and watch dependencies [#25](https://github.com/dlynch42/ekman-ts/pull/25) ([@dlynch42](https://github.com/dlynch42))
- Stores: file store durability, safe names, faster queries and commits, and cache layers that are read [#18](https://github.com/dlynch42/ekman-ts/pull/18) ([@dlynch42](https://github.com/dlynch42))
- Read instance loads through cache layers and keep them honest [#16](https://github.com/dlynch42/ekman-ts/pull/16) ([@dlynch42](https://github.com/dlynch42))
- Runtime core: conformance hardening, lifecycle correctness, and commit path performance [#10](https://github.com/dlynch42/ekman-ts/pull/10) ([@dlynch42](https://github.com/dlynch42))
- Give the runtime a real shutdown and keep audit and telemetry off the commit path [#9](https://github.com/dlynch42/ekman-ts/pull/9) ([@dlynch42](https://github.com/dlynch42))

#### Authors: 1

- Devin Lynch ([@dlynch42](https://github.com/dlynch42))

---

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
