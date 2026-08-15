# Ekman conformance scenarios

Language-agnostic conformance scenarios for Ekman. Every scenario is a single JSON file.
Every implementation copies this directory verbatim and writes a thin runner that reads
these files, drives its own runtime through its **public API only**, and diffs actual
behaviour against the expectations.

Passing the scenarios at a level is the definition of conforming at that level.

JSON rather than YAML so no implementation needs a parser dependency: JavaScript has JSON
natively and Go has `encoding/json` in its standard library.

## Layout

```
scenarios/
├── schema/scenario.schema.json    JSON Schema for every scenario file
├── core/                          dispatch, commit, ordering, memory store
├── durable/                       durable store, replay, snapshot on evict, queries
└── coordinated/                   multi-runtime conflict detection
```

Levels stack: Durable includes Core, Coordinated includes Durable. A runner reports per
level. An implementation that claims only Core runs `core/` and reports the other levels
as unclaimed rather than as passing.

## File shape

```json
{
  "id": "core/020-transition-to",
  "name": "a transitionTo result commits state, values and seq",
  "level": "core",
  "given": { "runtime": {}, "entities": [] },
  "when": [],
  "then": {}
}
```

| Field | Meaning |
|---|---|
| `id` | Path-like unique id. Must match the file's location and basename. |
| `name` | One sentence describing the behaviour under test. |
| `level` | `core`, `durable`, or `coordinated`. |
| `given` | The runtime and entity configuration to build. |
| `when` | Ordered steps to execute. |
| `then` | Expectations to assert after all steps settle. |

## `given`

### `given.runtime`

```json
{ "clock": { "start": 0, "stepMs": 1000 } }
```

`clock` is optional. When present the runtime must be built with a deterministic clock
starting at `start` milliseconds and advancing `stepMs` on each read, which makes an
event's `at` timestamp assertable. When absent, runners must ignore `at` in all event
assertions.

This clock is the *domain* clock: it stamps the per-key event stream and nothing else.
Telemetry uses wall time and must not draw from it, or the number of times an
implementation happens to read the clock internally would change the timestamps a
scenario asserts, and no two implementations would agree.

```json
{ "inbox": { "capacity": 1, "overflow": "reject", "recordOverflow": false } }
```

`inbox` is optional and configures the bounded per-key inbox for every instance.

| Field | Default | Meaning |
|---|---|---|
| `capacity` | 128 | How many triggers may **wait** per key. A queue length in triggers, never a size in bytes. |
| `overflow` | `reject` | What happens to a trigger arriving at a full inbox. |
| `recordOverflow` | `false` | Also record an overflow refusal in the key's event stream, not only in telemetry. |

`capacity` counts triggers that are waiting. The one currently being handled has already
left the queue and does not count against it, so a trigger arriving at a completely idle
instance is always admitted, and `capacity: 0` means "one at a time, no backlog" rather
than "refuse everything".

Overflow policies:

| Policy | Effect | The sender gets |
|---|---|---|
| `reject` | Refuses the arriving trigger, queue untouched. | `INBOX_OVERFLOW` |
| `drop-newest` | Refuses the arriving trigger, queue untouched. | `TRIGGER_DROPPED` |
| `drop-oldest` | Refuses the longest-waiting trigger and admits the arriving one. | `TRIGGER_DROPPED` |

`reject` and `drop-newest` have the same effect on the queue and differ in what the sender
is told: `INBOX_OVERFLOW` is backpressure, meaning the trigger did not land and the
producer should slow down; `TRIGGER_DROPPED` is shedding, meaning the trigger is gone on
purpose and should not be retried. `drop-oldest` with a `capacity` of 0 has no waiting
trigger to drop, so it drops the arriving one.

```json
{ "execution": { "maxAttempts": 3, "timeoutMs": 500,
                 "backoff": { "kind": "fixed", "delayMs": 10 } } }
```

`execution` is optional and sets the default execution policy for every handler.

| Field | Default | Meaning |
|---|---|---|
| `maxAttempts` | 1 | Total attempts including the first. 1 means no retries. |
| `timeoutMs` | none | How long one attempt may take before it is abandoned and fenced. |
| `backoff` | exponential, 50ms base, factor 2, 30s ceiling | Wait between attempts. Only consulted when `maxAttempts` is above 1. |

Backoff is `{ "kind": "fixed", "delayMs": N }` or
`{ "kind": "exponential", "baseMs": N, "factor": F, "maxDelayMs": M }`. There is no jitter:
a shared suite cannot assert on a randomized delay.

The same shape may be declared on an entity (`policy`) and on a single state
(`states[].policy`). The three levels are layered field by field, narrowest winning, so a
state that sets only `timeoutMs` keeps the wider `maxAttempts`.

```json
{ "temporal": { "sweepMs": 1000 } }
```

`temporal` is optional and sets how often the runtime evaluates temporal constraints on its
own. Scenarios normally leave it out and use the `sweep` step instead, which is
deterministic; an automatic interval makes a scenario depend on real elapsed time.

### `given.entities`

An array of entity specifications.

```json
{
  "name": "orders",
  "initial": "pending",
  "values": { "total": 0 },
  "unknown": "reject",
  "triggers": ["approve", "cancel"],
  "states": []
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Entity name. Also the first key segment. |
| `initial` | yes | The single initial state. Must appear in `states`. |
| `values` | no | Declared initial values. Omitted means `{}`. |
| `unknown` | no | Unknown policy. Defaults to `reject`. |
| `triggers` | no | Recognized trigger types. Omitted means every type is recognized. |
| `policy` | no | Execution policy for this entity, over the runtime's and under any state's. |
| `constraints` | no | The strictness dial. See below. |
| `onError` | no | Recovery handlers keyed by error classification, with `*` as the fallback. |
| `states` | yes | Handler specifications, one per state. |

`onError` maps a classification to a `do` object, which runs in place of the failed result:

```json
{ "onError": { "ConstraintViolation": { "result": "transitionTo", "to": "blocked" } } }
```

Classification is the error's name. `ConstraintViolation` is the one the runtime raises
itself; a handler that throws contributes whatever `errorName` its `do` declared.

### `given.entities[].states[]`

Handlers cannot be code in a language-neutral file, so each state declares a small
behaviour that every runner compiles into a real handler function.

```json
{
  "state": "pending",
  "cases": [
    { "when": { "trigger": "approve" },
      "do": { "result": "transitionTo", "to": "approved" } }
  ],
  "else": { "result": "fail", "error": "not approvable" }
}
```

Cases are evaluated in order and the first match wins. `when.trigger` matches the
trigger's `type`. A case with no `when` matches anything. If no case matches, `else` runs;
if `else` is absent, the handler returns `stay` with the current values unchanged.

Note the difference from the unknown policy: a state with **no entry in `states`** reaches
the unknown policy. A state that has an entry but whose cases do not match a trigger is
ordinary handler logic, and returns whatever `else` says.

### The `do` object

Exactly one of `result` or `throw`.

| Field | Applies to | Meaning |
|---|---|---|
| `result` | all | `transitionTo`, `stay`, or `fail`. |
| `to` | `transitionTo` | Target state name. Required. |
| `values` | `transitionTo`, `stay` | A value expression, see below. Omitted means the current values unchanged. |
| `error` | `fail` | Error message. |
| `errorName` | `fail`, `throw` | Error name, used for error-handler classification. Defaults to `Error`. |
| `throw` | all | Throw instead of returning. The message. Exercises the thrown-error path. |
| `delayMs` | all | Await this many milliseconds before producing the result. Drives ordering and timeout scenarios. |

A case's `when` may also match on `attempt`, the 1-based attempt number. Every declared
condition must match. This is what makes retry behaviour expressible:

```json
{
  "state": "pending",
  "policy": { "maxAttempts": 3 },
  "cases": [
    { "when": { "attempt": 1 }, "do": { "result": "fail", "error": "transient" } },
    { "do": { "result": "transitionTo", "to": "shipped" } }
  ]
}
```

### Value expressions

A value expression is JSON. Any object that has exactly one key and that key begins with
`$` is a reference, resolved against the current dispatch:

| Reference | Resolves to |
|---|---|
| `{ "$trigger": "region" }` | The trigger's `region` field. Dot paths allowed. |
| `{ "$trigger": "" }` | The whole trigger object. |
| `{ "$values": "attempt" }` | The current committed values' `attempt` field. |
| `{ "$values": "" }` | The whole current values object. |
| `{ "$key": "" }` | The instance key as a string. |

References may appear at any depth. Everything else is a literal.

```json
{ "region": { "$trigger": "region" }, "attempt": 1, "note": "literal" }
```

### `given.entities[].constraints`

Constraints are the strictness dial. All of them are opt-in, and an entity that declares
none accepts any well-formed result.

```json
{
  "transitions": { "policy": "reject", "allow": { "pending": ["deploying"] } },
  "guards": [
    { "name": "region-required", "on": "deploying",
      "check": { "values": "region", "exists": true } }
  ],
  "invariants": [
    { "name": "balance-non-negative", "in": ["open"],
      "check": { "values": "balance", "gte": 0 } }
  ],
  "temporal": [
    { "name": "deploy-timeout", "in": "deploying", "within": 600000,
      "escalateTo": "stalled", "trigger": "deploy.stalled" }
  ]
}
```

Four kinds, each checked at a defined moment:

| Kind | Checked |
|---|---|
| `transitions` | Before committing a `transitionTo`. |
| `guards` | Before committing a `transitionTo` into the state named by `on`. |
| `invariants` | Before committing any result that changes state or values. |
| `temporal` | On a sweep, against how long the instance has been in `in`. |

Every constraint carries a `policy`, defaulting to `reject`:

| Policy | Effect |
|---|---|
| `reject` | The result fails with `CONSTRAINT_VIOLATED`, the instance does not move, and a violation event is recorded. |
| `warn` | A violation event is recorded and the commit proceeds. |
| `off` | Not evaluated at all, and nothing is recorded. |

`warn` is the reason the dial exists: a team that does not yet know its real transition
graph turns constraints on in `warn`, reads the violations out of production, and only then
switches to `reject`. A violation is recorded under both policies, distinguished by the
event's `policy` field, so one query answers "everything that would have been refused".

Details worth knowing, each of which has a scenario:

- **Every `transitionTo` is graph-checked**, including one targeting the state the instance
  is already in. Use `stay` to change values without transitioning.
- **A guard runs only when its `on` state is the one being entered.**
- **An invariant applies to the state being entered**, filtered by `in`, or to every state
  when `in` is omitted. A `stay` that supplies no values changes nothing and is not checked.
- **A check that throws is a violation**, not a pass. Deciding a condition holds because the
  code asking about it is broken is the silent fall-through constraints exist to prevent.
- **A refused result is classified**, so `onError` can catch it under `ConstraintViolation`
  and commit something legal instead. A recovery is itself a commit and faces the same
  constraints, with no second error handler behind it.
- **`escalateTo` is carried on the trigger**, not applied by the runtime. A trigger never
  changes state on its own; the handler decides, exactly as with any other input.
- **A temporal constraint fires once per entry** into its state. Leaving and re-entering
  arms it again. Without this, sweeping a stuck instance produces an escalation per pass.

Under `reject` a temporal constraint records the violation and delivers its escalation
trigger. Under `warn` it records the violation and delivers nothing.

The escalation trigger carries:

```json
{ "type": "deploy.stalled", "constraint": "deploy-timeout",
  "state": "deploying", "sinceMs": 600000, "escalateTo": "stalled" }
```

`type` defaults to `constraint.temporal` when the constraint declares no `trigger`.

### Checks

A handler cannot be code in a language-neutral file, and neither can a condition. A check
declares one source and one predicate:

| Field | Meaning |
|---|---|
| `values` | Dot path into the values being proposed. Empty string is the whole map. |
| `trigger` | Dot path into the trigger. |
| `state` | `true` to read the proposed state name. |
| `exists` | Whether the subject is expected to be present. |
| `equals` | The subject must equal this. |
| `gte`, `lte` | Numeric bounds. |
| `reason` | Reported as the violation's `reason` when the check does not hold. |
| `throw` | Throw instead of answering, exercising the broken-check path. |

```json
{ "values": "region", "exists": true, "reason": "a deployment needs a region" }
```

This is deliberately not an expression language. Every implementation has to reproduce it
exactly, and a small vocabulary is the difference between inheriting the constraint
scenarios and reimplementing an evaluator.

## `when`

An ordered array of steps.

```json
[
  { "send": { "key": "orders:1", "trigger": { "type": "approve", "actor": "amy" } } },
  { "send": { "key": "orders:1", "trigger": { "type": "ship" } }, "await": false },
  { "drain": true }
]
```

| Step | Meaning |
|---|---|
| `send` | Deliver a trigger to a key. `await` defaults to `true`, meaning the runner waits for the send to settle before the next step. |
| `drain` | Wait for every outstanding send to settle. |
| `wait` | Pause this many milliseconds. |
| `advance` | Move the declared clock forward this many milliseconds. |
| `sweep` | Evaluate temporal constraints once and settle whatever they escalate. |

`wait` exists for work the runtime is still doing after every send has settled. A handler
abandoned at its timeout keeps running and eventually tries to commit; `drain` will not
wait for it, because its sender was told the outcome long before.

`advance` and `sweep` are what make a temporal constraint testable without waiting on real
time. Declare a frozen clock (`"stepMs": 0`), age the instance with `advance`, then run one
evaluation with `sweep`:

```json
"given": { "runtime": { "clock": { "start": 0, "stepMs": 0 } } },
"when": [
  { "send": { "key": "deployments:a", "trigger": { "type": "start" } } },
  { "advance": 600000 },
  { "sweep": true }
]
```

A frozen clock matters here specifically. Under a stepping clock, elapsed time would depend
on how many times the implementation happens to read its own clock, and no two ports would
agree. `sweep` settles every escalation it raised before the next step runs, so the
assertions afterwards see the finished picture.

A sweep reads the clock once. Every violation one pass records is stamped with that single
instant, rather than with whatever moment the walk happened to reach each instance.

`"await": false` leaves the send in flight, which is how ordering and concurrency
scenarios overlap work on one key. A scenario that uses it should end with
`{ "drain": true }`.

The runner records the outcome of every `send` step in order, whether awaited or not.

## `then`

Every field is optional. Only what is present is asserted.

### `then.sends`

Outcomes of the `send` steps, in the order the steps appear.

```json
[
  { "outcome": "committed", "state": "approved", "seq": 1 },
  { "outcome": "rejected", "code": "UNKNOWN_STATE" }
]
```

| Field | Meaning |
|---|---|
| `outcome` | `committed` or `rejected`. |
| `state`, `seq`, `values` | Asserted on `committed` when present. |
| `code` | The stable error code, asserted on `rejected`. |

### `then.events`

The per-key ordered event stream, keyed by instance key. The assertion is a full ordered
list: an extra or missing event is a failure. Each event is matched as a subset, so a
scenario asserts only the fields it cares about.

```json
{
  "orders:1": [
    { "type": "transition", "from": null, "to": "pending", "seq": 0,
      "cause": { "type": "init" } },
    { "type": "transition", "from": "pending", "to": "approved", "seq": 1 }
  ]
}
```

`at` is asserted only when `given.runtime.clock` is declared.

Event types:

| Type | Meaning | Advances `seq`? |
|---|---|---|
| `transition` | A committed state or values change. | yes |
| `rejected` | A trigger refused before it reached a handler. | no |
| `violation` | A constraint that did not hold. | no |

Only `transition` events reconstruct state. Everything else carries the sequence of the
commit it followed, which is why `seq` is non-decreasing across a stream rather than unique.

A `violation` event carries `constraint` (`{ kind, name }`), `policy`, `reason`, and, when
it was refusing a result, `attempted` (`{ from, to }`). A `warn` violation sits immediately
before the commit it did not stop, so the pair reads in order.

### `then.telemetry`

Runtime telemetry: queue depth, drops, handler duration. A separate stream from
`then.events`, and nothing that appears here may appear there.

```json
[
  { "type": "handler.started", "key": "orders:1", "state": "a", "depth": 0 },
  { "type": "inbox.dropped", "dropped": "newest", "trigger": { "id": "t3" } },
  { "type": "handler.settled", "outcome": "committed", "durationMs": "$number" }
]
```

Asserted as an **ordered subsequence** of what was emitted, not as an exact list. Order
between the matchers is asserted, so "started before settled" is provable, but unrelated
events in between are ignored. Telemetry is a firehose, and a scenario about one dropped
trigger should not have to enumerate every enqueue around it.

Each matcher is a subset match, like an event assertion.

| Event | Emitted when | Notable fields |
|---|---|---|
| `inbox.enqueued` | A trigger is accepted into an inbox. | `depth`, `capacity`, `trigger` |
| `inbox.rejected` | A trigger is refused by the `reject` policy. | `depth`, `capacity`, `overflow`, `trigger` |
| `inbox.dropped` | A trigger is dropped by a drop policy. | `dropped` (`newest`/`oldest`), `trigger` |
| `handler.started` | A handler attempt begins. Once per attempt. | `state`, `attempt`, `depth` |
| `handler.settled` | A trigger finishes being processed. Once per trigger. | `outcome`, `durationMs`, `attempt` |
| `handler.retried` | An attempt failed and another will follow. | `attempt`, `maxAttempts`, `delayMs`, `error` |
| `handler.timedOut` | An attempt ran past its timeout and was abandoned. | `attempt`, `timeoutMs` |
| `commit.fenced` | A superseded attempt tried to commit and was refused. | `attempt`, `reason`, `tokenSeq`, `currentSeq` |
| `constraint.violated` | A constraint did not hold. | `kind`, `constraint`, `policy`, `state`, `reason` |
| `constraint.escalated` | A temporal constraint fired and its trigger was delivered. | `constraint`, `elapsedMs`, `escalateTo`, `delivered` |

`handler.settled.outcome` is `committed`, `failed`, or `refused`. `refused` means the
trigger never reached a handler.

A constraint violation appears in both streams on purpose, and the direction matters. The
per-key `violation` event is the record; `constraint.violated` is the mirror an operator
alerts on, because a rising rate of violations is a runtime signal even when each one is a
domain fact. Nothing travels the other way: no telemetry event ever reaches a key's history.

`constraint.escalated` is separate from the violation because delivery can fail on its own.
`delivered: false` usually means the instance is stranded in a state whose handler cannot
take the trigger, which is exactly the situation the constraint was watching for.

### Type matchers

Some values are real but not deterministic, a handler's duration being the obvious one.
Asserting the shape is the most a scenario can honestly say about them, so a matcher
string may stand in for a value anywhere in `then`:

| Matcher | Matches |
|---|---|
| `"$number"` | Any number that is not `NaN`. |
| `"$string"` | Any string. |
| `"$any"` | Any value that is present. |

### `then.state`

Current committed state per key, after all steps settle.

```json
{ "orders:1": { "state": "approved", "values": { "by": "amy" }, "seq": 1 } }
```

Use `null` as the value for a key to assert that no instance exists for it.

### `then.buildError`

Asserts that `given` is itself invalid and must be rejected when the runtime or entity is
built, before any trigger is sent. This is how entity-validation requirements are tested.

```json
{ "code": "DUPLICATE_STATE_HANDLER" }
```

When `buildError` is present, `when` and the other `then` fields must be absent.

## Error codes

Stable across implementations. A runner asserts on these strings, never on messages.

| Code | Raised when |
|---|---|
| `INVALID_KEY` | Key is malformed. |
| `UNKNOWN_ENTITY` | The key's first segment names no registered entity. |
| `UNKNOWN_STATE` | The current state has no handler and the unknown policy is `reject`. |
| `UNKNOWN_TRIGGER` | The trigger type is not in the declared `triggers`. |
| `HANDLER_FAILED` | The handler produced `fail`, or threw. |
| `INBOX_OVERFLOW` | The inbox was full and the overflow policy is `reject`. |
| `TRIGGER_DROPPED` | The inbox was full and a drop policy discarded this trigger. |
| `HANDLER_TIMEOUT` | An attempt ran past its configured timeout. |
| `COMMIT_FENCED` | A commit was refused because its attempt had been superseded. |
| `CONSTRAINT_VIOLATED` | A result did not satisfy a constraint whose policy is `reject`. |
| `DUPLICATE_ENTITY` | Two entities registered with the same name. |
| `DUPLICATE_STATE_HANDLER` | Two handlers for one state. |
| `MISSING_INITIAL_STATE` | No initial state declared. |
| `INITIAL_STATE_NOT_IN_STATES` | The initial state has no handler. |
| `INVALID_CONFIG` | Configuration is recognized but cannot be satisfied, and is refused rather than adjusted. |
| `NOT_IMPLEMENTED` | Configuration is recognized but unimplemented at this phase. |

Later phases add codes for store conflicts and memory exhaustion.

## Determinism

Scenarios must be deterministic. Two rules make that possible:

1. **Trigger ids.** A trigger may carry an explicit `id`. When it does not, the runtime
   assigns one from a per-runtime counter formatted `t1`, `t2`, and so on, in the order
   triggers are accepted. Scenarios may assert on `cause.id`.
2. **Time.** `at` is only assertable under a declared clock, per `given.runtime.clock`.

Anything that cannot be made deterministic must not be asserted.

## Adding a scenario

1. Pick the lowest conformance level that can exercise the behaviour.
2. Name the file `NNN-kebab-summary.json`. The number carries no meaning to the runner:
   it sorts the report and keeps related scenarios adjacent. Gaps are deliberate so a new
   case slots in without renumbering its neighbours.

   | Prefix | Group |
   |---|---|
   | `00x` | reserved |
   | `01x` | initialization and initial values |
   | `02x` | handler results: transitionTo, stay, fail, throw |
   | `03x` | unknown policy: unrecognized state, unrecognized trigger |
   | `04x` | sequence numbering and the event stream |
   | `05x` | keys and addressing |
   | `06x` | ordering and per-key serialization |
   | `07x` | definition-time validation |
   | `08x` | inbox capacity and overflow policies |
   | `09x` | telemetry |
   | `10x` | execution policy: retries and backoff |
   | `11x` | timeouts and commit fencing |
   | `12x` | transition graph constraints, and violation classification |
   | `13x` | guards and invariants |
   | `14x` | temporal constraints |

3. Assert the narrowest thing that proves the requirement. Over-asserting makes the suite
   brittle for the next port.
