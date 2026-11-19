# Constraints

[Back to the docs index](./README.md)

```ts
constraints: {
  transitions: { allow: { pending: ["deploying"], deploying: ["live", "failed"] } },
  guards:      [{ on: "deploying", check: (next) => next.values.region !== undefined }],
  invariants:  [{ name: "attempts-sane", check: (next) => next.values.attempts >= 0 }],
  temporal:    [{ in: "deploying", within: 10 * 60_000, escalateTo: "failed" }],
  rules:       [{ in: "deploying", when: (d) => d.values.errors >= 5, propose: "failed" }],
},
```

Five kinds, all opt-in per entity, each checked at a defined moment, each carrying its own
`reject` / `warn` / `off` dial. The first three refuse a result. The last two never refuse
anything: they deliver a trigger, and a handler decides.

| Kind | Checked | Against |
|---|---|---|
| `transitions` | before commit of a `transitionTo` | the declared graph |
| `guards` | before commit of a `transitionTo` | a condition on the proposed commit |
| `invariants` | before commit of any result that changes values | a condition that must hold |
| `rules` | after every commit, in a watched state | a condition on what was just committed |
| `temporal` | by sweep, timer, or `ekman.sweep()` | how long an instance has been in a state |

`stay` is deliberately not a transition. The graph and guards gate state changes; invariants
gate value changes. Putting the graph in front of every `stay` would break every entity that
updates values freely inside a state.

## The check signature

```ts
type ConstraintCheck = (
  next: { state, values },        // the proposed commit
  instance: InstanceSnapshot,     // where it is now
  trigger: Trigger,               // what caused it
) => boolean | string;
```

Return `true` to allow. Return `false` to refuse, or return a **string** to refuse with that
string as the explanation, which is what shows up in the violation event and in the error
message.

```ts
guards: [{
  on: "shipped",
  check: (next) => next.values.paid === true || "cannot ship before payment clears",
}],
```

## Transition graph

```ts
transitions: {
  policy: "reject",
  allow: { pending: ["deploying"], deploying: ["live", "failed"], live: [], failed: [] },
},
```

A state that only ever appears as a target does not need an entry. A refusal explains itself:

```
CONSTRAINT_VIOLATED | transitions: "paid" to "pending" is not a declared transition.
From "paid" the declared targets are: (none)
```

### A transition to the same state is still a transition

Every `transitionTo` is checked against the graph, including one that targets the state the
instance is already in. `transitionTo("error", ...)` from `error` needs `error: ["error"]` in
`allow`, or it is refused like any other undeclared move.

This bites hardest in a failure path. A handler or an `onError` handler that reports a repeated
failure by transitioning to `error` again is refused the second time, with `CONSTRAINT_VIOLATED`,
from inside the code that was supposed to be handling the problem:

```ts
allow: {
  running: ["error"],
  error: ["running", "error"],   // the second entry is what lets a repeated failure be recorded
},
```

Two ways to stay out of it:

- **Use `stay(values)` when the state is not changing.** It updates values without asking to
  move, so the graph is not consulted.
- **List a self-edge on purpose** when asking to enter the state again means something: the
  state's guards are checked again, and the move is recorded as a transition.

A self-transition does not restart the clock. Time in state is measured from the last move to a
*different* state, so transitioning to the state an instance is already in neither extends a
time-in-state bound nor arms again one that has fired.

Rolling a graph out under `policy: "warn"` first shows every self-transition your handlers
actually make before any of them is refused.

## Guards

A guard is a condition on entering a state. It can be scoped to where the transition comes
*from* as well as where it goes:

```ts
guards: [
  { name: "payment-cleared", on: "shipped", from: "paid", check: (next) => next.values.paid },
  { name: "override-noted",  on: "shipped", from: "manual_override", check: (next) => next.values.note !== "" },
],
```

So "entering `shipped` from `paid` requires payment cleared, but entering it from
`manual_override` does not" is something you declare rather than something you hide inside a
check.

A guard scoped to a transition the graph does not allow is refused when the entity is defined.
A condition on something that cannot happen reads like protection that is in force, and it is
not.

## Invariants

```ts
invariants: [
  { name: "attempts-sane", check: (next) => next.values.attempts >= 0 },
  { name: "total-matches", in: ["paid", "shipped"], check: (next) => next.values.total > 0 },
],
```

Checked before committing any result that changes values, `stay` included. `in` scopes an
invariant to particular states; omit it and it holds everywhere.

## Rules: state that follows from memory

```ts
rules: [
  { in: "healthy", when: (service) => service.values.failures >= 3, propose: "degraded" },
],
```

A rule is a condition over what an instance knows. When the condition comes to hold on what
was just committed, the runtime delivers a trigger carrying the state the rule proposes.

**A rule proposes and the handler decides.** Like a time-in-state bound, it fires as a trigger,
never as a write, so every state change is still one piece of your code returning
`transitionTo`. What a rule takes out of the handler is the watching: the handler that records
a failed probe does not also have to remember to compare a counter with a threshold.

```ts
import { DEFAULT_RULE_TRIGGER } from "ekman";

triggers: ["probe", DEFAULT_RULE_TRIGGER],

states: {
  healthy: (service, trigger) => {
    if (trigger.type === DEFAULT_RULE_TRIGGER) {
      return transitionTo("degraded", service.values);   // or stay(), to decline
    }
    const failures = trigger.ok ? 0 : service.values.failures + 1;
    return stay({ ...service.values, failures });
  },
},
```

| Field | What it does |
|---|---|
| `when` | The condition, handed the committed instance: `{ key, entity, state, values, seq }`. Return `true`, or a string saying why, when it holds, and `false` when it does not. |
| `in` | The state, or states, the rule watches. Omitted means every state. |
| `propose` | The state the rule asks for. Carried on the trigger; the runtime never applies it. |
| `trigger` | The type of the delivered trigger. Defaults to `rule.matched`. |
| `name` | Defaults to `rule:<in>:<propose>`. |
| `policy` | `reject` delivers the proposal. `warn` records the match and delivers nothing. `off` is not evaluated. |

The trigger a handler receives is:

```ts
{ type: "rule.matched", id, rule, state, propose?, reason }
```

`rule` is the rule's name, `state` is the state the instance was in when the condition came to
hold, and `reason` is the string the condition returned, or `the condition held`. An entity
with a [trigger union](./entities.md#typed-triggers) adds `RuleTrigger<State>` to it, which
types `propose` as one of the entity's states.

### Once per edge

A rule fires when its condition **comes to hold**, and not again while it goes on holding. A
counter that reaches the threshold and keeps climbing is one proposal, however many commits
follow. The rule is armed again when the condition stops holding, or when the instance moves
to another state. So a handler that declines a proposal is not asked again until something
has changed.

A handler that flips a value back and forth across a threshold is proposed to on every
crossing. That is the rule doing what it says, and not a loop: each proposal follows a commit
the handler made.

A rule is not asked in the state it proposes. An instance already in `degraded` has nothing
to be told by a rule proposing `degraded`, so a rule that watches every state does not echo
after the move it asked for.

Every match is recorded in the instance's own stream as a violation of kind `rule`, under
`reject` and under `warn` alike, with the reason. Under `warn` that record is all that
happens, which is how you find out which rules would fire, and how often, before letting any
of them act.

### What a rule does not do

- **It does not reach across keys.** A rule reads one instance and proposes to that instance.
  Reacting to one instance by sending a trigger to another is what an
  [audit sink](./telemetry.md) is for.
- **It is not a sequence or a language.** A predicate, a trigger type and a proposed state.
- **It does not run on a clock.** It is evaluated when the instance commits, so an instance
  nothing is sent to is never asked. "It has sat here too long" is a
  [time-in-state bound](#time-in-state).
- **It is not evaluated when an instance is created or loaded.** The first commit after
  either is the first time it is asked. A rule that already fired stays fired across an
  eviction or a restart; one whose condition no longer holds when the instance is loaded is
  armed again.

### Refusals and delivery

`defineEntity` refuses a rule that could not work: one naming a state the entity does not
have, one whose `propose` is not a declared transition from a state it watches (when the
entity declares a transition graph; a rule that watches every state is not held to this), one
sharing a name with another rule or with a time-in-state bound, and, for an entity that
declares `triggers`, one whose trigger type is not in the list. A rule with `policy: "warn"`
delivers nothing and is exempt from the last.

The proposal is queued behind the commit that raised it, in the instance's own inbox, like any
other trigger. If it is turned away for a reason that passes, such as a full inbox, it is sent
again after the instance's next commit, under the same id, and the match is recorded only
once. A proposal the handler fails on is not retried by the runtime that sent it. A handler
failure is not an event in the stream, so a runtime that later rebuilds the instance from its
stream alone, with no snapshot, still sees the proposal as owed and sends it once more. Either
way the failure goes to `onUnhandled` with `source: "escalation"`.

A condition that throws counts as holding, with what it threw as the reason, whatever was
thrown. A broken
condition read as "does not hold" would be a rule that silently never fires.

## Time in state

```ts
temporal: [{ in: "deploying", within: 10 * 60_000, escalateTo: "failed" }],
```

**A time-in-state bound fires as a trigger, never as a write.** The runtime hands your handler
the escalation and your handler decides, exactly as with any other input. That keeps every state
change attributable to one piece of your code, and it means a handler can decline an escalation.

```ts
import { DEFAULT_TEMPORAL_TRIGGER } from "ekman";

triggers: ["deploy", "succeeded", DEFAULT_TEMPORAL_TRIGGER],

states: {
  deploying: (deployment, trigger) => {
    if (trigger.type === DEFAULT_TEMPORAL_TRIGGER) {
      if (deployment.values.attempts < 3) return stay(deployment.values);  // decline it
      return transitionTo("failed", deployment.values);
    }
    // ...
  },
},
```

Set `trigger` on the constraint to use a type of your own instead of the default.

An entity with a [trigger union](./entities.md#typed-triggers) adds `TemporalTrigger<State>` to
it, which types the escalation's `escalateTo` as one of the entity's states.

An entity that declares `triggers` must list the type its bounds deliver, as above. A bound
whose escalation the entity would refuse as unknown is rejected by `defineEntity`, because
the instance it was watching would stay stuck. A bound with `policy: "warn"` delivers nothing
and is exempt.

A bound's `name` defaults to `temporal:<in>:<within>`. Names must be distinct within an entity,
across its bounds and its rules, since a bound fires once per entry into its state and that is
tracked by name.

When several bounds on one state are due, they are evaluated in declaration order, and
evaluation stops as soon as an escalation has moved the instance: the rest were watching a
state it has left. An escalation refused for a reason that passes (a full inbox, a full
memory budget, a timeout, a store that could not take the write) is raised again by the next
sweep, and its violation is recorded only once. An escalation the handler refuses is not retried.

Evaluate on a schedule with `temporal: { sweepMs }` on the runtime, or call `await ekman.sweep()`
yourself. Without either, a bound is only checked when something asks.

### Instances that are not resident

With a store configured, a bound holds for every instance of the entity, resident or not. An
instance that is stuck is usually idle, and an idle instance is the first one a
[memory budget](./memory.md) releases; after a restart nothing is resident at all. So each
sweep also asks the store which instances have sat in a watched state past its bound, loads
each one, and escalates it as it would a resident one. The instance is released again once it
is idle.

A bound fires once per stay in its state, and that survives eviction and restarts. It is
worked out from the instance's own stream: a violation under `warn` is the whole of what there
was to say, and one under `reject` is owed its escalation until the stream shows that trigger
committing or being refused for good. An escalation that was turned away for a reason that
passes, including a runtime that was closing, is delivered by whichever runtime sweeps next,
under the same trigger id, and no second violation is recorded.

What it costs: one store scan per entity that declares a bound, per sweep. The built-in
stores answer a scan by reading every instance of the entity that is not resident, so on a
large store set `sweepMs` with that in mind. An instance that has been told everything its
bounds have to say is not loaded again until it commits or another bound comes due.

An instance the sweep has loaded stays resident until all its bounds have been read, whatever
the memory budget says, and cannot be deleted in that time: `forget` raises `KEY_BUSY`. A store
that answers a scan with part of the answer is reported through `onUnhandled`, because the
instances it left out were not swept.

Without a store there is nothing to scan, and a bound covers the resident instances, which
in a memory-only runtime is all of them.

```
npm run demo:stuck    # "stuck in deploying for more than five minutes", as query and as constraint
```

## The `warn` dial, and why it exists

```ts
transitions: { policy: "warn", allow: { /* your best guess */ } },
```

`warn` is the point of the dial. Turn a constraint on in `warn`, let real traffic run against
it, read the violations it produces, and switch to `reject` once you know what your graph
actually is. Violations land in the same per-key stream as transitions under either policy, so
"everything that would have been refused last week" is one query rather than a log-scraping
exercise.

Under `reject`, a refused result is classified, so `onError` can catch it and commit something
legal instead.

## Discovering the graph you actually have

`warn` mode ends with a diagram rather than a log read.

<!-- check-docs:
import type { AnyEntityDefinition, Ekman } from "ekman";
declare const ekman: Ekman;
declare const keys: string[];
declare const orders: AnyEntityDefinition;
-->
```ts check
import { allowFrom, observeEdges, toMermaid } from "ekman";

// Fold every key's stream into the edges the traffic actually walked.
let observed = observeEdges([]);
for (const key of keys) {
  observed = observeEdges((await ekman.history(key)).events, observed);
}

// Turn that into a map you paste straight into the constraint.
console.log(allowFrom(observed));
// { pending: ["deploying"], deploying: ["live", "failed"] }

// Draw declared and observed together. Moves you never declared are marked as observed.
console.log(toMermaid(orders, { observed: observed.taken }));
```

For an entity that declared `pending -> paid` and `paid -> shipped`, whose traffic also walked
`paid -> pending`, that prints:

```
stateDiagram-v2
  [*] --> pending
  pending --> paid
  paid --> shipped
  paid --> pending : observed
```

The marked edge is the edit you are being asked to make: either add it to `allow`, or fix the
handler that produced it, then switch the policy to `reject`.

`observeEdges` accumulates across streams, because history is per key and a graph is per entity.
`allowFrom` deliberately leaves out refused edges: enforcement already decided against them, and
a map that re-admitted them would declare the thing you rejected.

`toDot` produces Graphviz instead of Mermaid. `analyze(definition)` returns the declared graph
plus reachability, without needing any history.

```
npm run demo:no-going-backwards   # unconstrained, then warn, then reject, on one naive handler
```

## Next

- [Queries and history](./queries.md) for reading violations back.
- [Error codes](./errors.md) for `CONSTRAINT_VIOLATED`.
