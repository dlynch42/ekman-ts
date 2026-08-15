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
| `states` | yes | Handler specifications, one per state. |

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
| `delayMs` | all | Await this many milliseconds before producing the result. Drives ordering scenarios. |

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
| `DUPLICATE_ENTITY` | Two entities registered with the same name. |
| `DUPLICATE_STATE_HANDLER` | Two handlers for one state. |
| `MISSING_INITIAL_STATE` | No initial state declared. |
| `INITIAL_STATE_NOT_IN_STATES` | The initial state has no handler. |
| `NOT_IMPLEMENTED` | Configuration is recognized but unimplemented at this phase. |

Later phases add codes for inbox overflow, fencing, and timeouts.

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

3. Assert the narrowest thing that proves the requirement. Over-asserting makes the suite
   brittle for the next port.
