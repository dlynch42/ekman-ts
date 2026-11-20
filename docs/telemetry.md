# Telemetry and audit

[Back to the docs index](./README.md)

```ts
const ekman = new Ekman({
  entities: [orders],
  telemetry: {
    "inbox.dropped":   (e) => metrics.inc("ekman.inbox.dropped", { entity: e.entity }),
    "handler.settled": (e) => metrics.observe("ekman.handler.ms", e.durationMs),
    "*":               (e) => log.debug(e.type, e.key),
  },
});
```

**Telemetry is a separate stream from history, by design.** Queue depth, handler duration, drops,
evictions and retries are Ekman's business. Your per-key transition history stays domain-only, so
it is still readable a year later.

## The sink

A map from event name to handler, each precisely typed, plus `"*"` for everything no named
handler claimed. Resolution is specific first, then the fallback, and an event is delivered to
exactly one handler. There is no event union to narrow.

Any function that accepts its event works, so a plain reference is fine and the arrow is only
needed when the event has to be reshaped:

```ts
telemetry: {
  "handler.settled": recordHandlerDuration,   // (e: HandlerSettledEvent) => void
  "*":               console.log,
},
```

Every event carries `key`, `entity` and `at`. `storage.swept`, `store.cacheSuspended` and
`runtime.closed` are the exceptions: they happen to a store and to the runtime rather than to
an instance.

A handler may be `async`. It is never awaited, so it cannot slow the runtime down, and if it
rejects the error goes to `onUnhandled` rather than becoming an unhandled rejection.

## The events

| Event | Fires when |
|---|---|
| `inbox.enqueued` | A trigger was accepted into the inbox. Fires for every accepted trigger, including one that goes straight to its handler. Carries `depth`. |
| `inbox.rejected` | The inbox was full and the policy is `reject`. The trigger did not land. |
| `inbox.dropped` | The inbox was full and a policy dropped a trigger on purpose. |
| `handler.started` | An attempt began. |
| `handler.settled` | A trigger finished being processed. Carries `durationMs`. |
| `handler.retried` | An attempt failed and another is being made. |
| `handler.timedOut` | An attempt ran past its timeout and was abandoned. |
| `commit.fenced` | A superseded attempt finished and tried to commit. Its result was discarded. |
| `commit.raced` | A commit reached the authority and a timeout arrived while it was in flight. The commit stands, because it is already durable. |
| `constraint.violated` | A constraint did not hold. |
| `constraint.escalated` | A time-in-state bound, a freshness bound or a rule fired and its trigger was sent. `kind` says which, `delivered` says whether the instance took it, and `elapsedMs` is there for a bound only: time in the state, or time since the last commit. |
| `instance.evicted` | An idle instance was released to stay inside the memory budget. |
| `instance.restored` | An instance was rebuilt from a store, after eviction or a restart. |
| `instance.forgotten` | An instance was deleted outright, from memory and every store layer. |
| `memory.accounted` | Resident accounting after a commit. |
| `memory.refused` | The budget is full and the policy refuses rather than evicting. |
| `store.cacheFailed` | A cache layer could not be read, written or cleared, or did not answer inside `cache.timeoutMs`. The commit was unaffected, and the layer is not read for that key until it is whole again. |
| `store.cacheSuspended` | A cache layer's reads, or its writes, went unanswered three times in a row, and the runtime will not use it again. Carries `store` and `timeouts`, and no key. |
| `audit.failed` | An audit sink could not be delivered to, after its retries. |
| `storage.swept` | A store's retention pass ran. |
| `runtime.closed` | `close()` finished waiting for in-flight work. Carries `drained` and `pending`. |

Three of these are worth understanding rather than just counting.

**`inbox.enqueued` is not a contention signal on its own; its `depth` is.** `depth` is how many
triggers are waiting once this one is in, counting this one and not counting the one being
handled. Above 1, this trigger is behind others that are still waiting. At 1 it is first in
line, which is either an idle key, where it runs at once, or a key with one handler in flight.
To tell those two apart, pair it with `handler.started`.

**`commit.fenced` is the fence doing its job.** Seeing it in a system with timeouts is normal,
not alarming. It means an abandoned handler finished and its result was correctly refused.

**`instance.evicted` and `instance.forgotten` are not the same thing** and the distinction
matters. Eviction releases memory and the instance comes back on the next trigger. Forgetting
destroys it.

The authoritative record of a constraint violation is the violation event in the key's own
stream. `constraint.violated` here is the operational copy, for counting.

## Audit sinks

```ts
const ekman = new Ekman({
  entities: [orders],
  audit: [auditLog, kafkaSink("state-transitions")],
});
```

An audit sink receives a copy of every committed event, out of band. That is the
initialization of an instance and every transition after it. A refused trigger or a constraint
violation is not a commit and is not delivered: those are in the instance's
[history](./queries.md) and in the telemetry events above.

**Audit sinks never gate a commit.** Delivery is asynchronous and at-least-once, and a sink has
no veto. A sink that throws, hangs forever, or is merely slow cannot delay or fail a commit, and
a sink that cannot be reached after its retries is reported as `audit.failed` and nothing else.
That is the whole of what a failed audit delivery does.

Delivery starts on a later turn of the event loop than the commit, never inside it, so even a
sink that does synchronous work costs the commit nothing. The corollary is that a sink has not
been called yet at the moment `send()` resolves. Events reach a sink in the order they were
committed; a sink that needs a stronger ordering guarantee across retries should order by `seq`.

A sink's `maxAttempts` must be at least 1, and a sink with no `name` or no `deliver` is refused
when the runtime is constructed.

```
npm run demo:audit   # one sink that throws, one that hangs, one that is slow. Every commit lands.
```

## Unhandled errors

```ts
onUnhandled: (error, { source, key }) => log.error({ source, key, error }, "ekman unhandled"),
```

A failure with no caller to reject goes here, so it is visible rather than an unhandled
rejection with no context. The second argument says where it came from:

| `source` | What failed | `key` |
|---|---|---|
| `post` | A fire-and-forget send was refused, or its handler failed. Includes a `post()` after `close()`. | yes |
| `telemetry` | A telemetry handler threw or rejected. | when the event has one |
| `escalation` | A time-in-state bound fired and its trigger was refused. | yes |
| `sweep` | An automatic time-in-state sweep failed, or a sweep could not scan the store or load an instance it found there. | when it was loading one |
| `storage-sweep` | An automatic storage sweep failed. | no |
| `snapshot` | The snapshot written when an instance is evicted failed. The events are already stored, so this costs replay time and no state. | yes |
| `persist` | A refusal or a violation could not be written to the store. | yes |
| `audit` | Delivery to an audit sink failed outside the sink's own retries. A sink that simply keeps failing is reported as `audit.failed` telemetry instead. | yes |
| `inbox` | A key's queue stopped draining. | yes |

Some of these are routine. A `post` that a constraint refuses lands here every time. An
escalation that is refused for a passing reason, such as a full inbox, is retried by the next
sweep and reported here each time it is refused. A failing cache layer does not come here at
all: it is reported as `store.cacheFailed`.

The default writes one line to stderr, naming the source and the key:

```
[ekman] unhandled failure (post for orders:a-1) EkmanError: ...
```

## Next

- [Error codes](./errors.md) for the codes carried by a rejected `send`.
- [Execution](./execution.md) for what produces `handler.retried`, `handler.timedOut` and `commit.fenced`.
