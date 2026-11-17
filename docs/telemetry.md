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

Every event carries `key`, `entity` and `at`. `storage.swept` and `runtime.closed` are the
exceptions: they happen to a store and to the runtime rather than to an instance.

A handler may be `async`. It is never awaited, so it cannot slow the runtime down, and if it
rejects the error goes to `onUnhandled` rather than becoming an unhandled rejection.

## The events

| Event | Fires when |
|---|---|
| `inbox.enqueued` | A trigger was queued behind work already in flight. |
| `inbox.rejected` | The inbox was full and the policy is `reject`. The trigger did not land. |
| `inbox.dropped` | The inbox was full and a policy dropped a trigger on purpose. |
| `handler.started` | An attempt began. |
| `handler.settled` | A trigger finished being processed. Carries `durationMs`. |
| `handler.retried` | An attempt failed and another is being made. |
| `handler.timedOut` | An attempt ran past its timeout and was abandoned. |
| `commit.fenced` | A superseded attempt finished and tried to commit. Its result was discarded. |
| `commit.raced` | A commit reached the authority and a timeout arrived while it was in flight. The commit stands, because it is already durable. |
| `constraint.violated` | A constraint did not hold. |
| `constraint.escalated` | A time-in-state bound fired and its escalation trigger was delivered. |
| `instance.evicted` | An idle instance was released to stay inside the memory budget. |
| `instance.restored` | An instance was rebuilt from a store, after eviction or a restart. |
| `instance.forgotten` | An instance was deleted outright, from memory and every store layer. |
| `memory.accounted` | Resident accounting after a commit. |
| `memory.refused` | The budget is full and the policy refuses rather than evicting. |
| `store.cacheFailed` | A cache layer could not be read, written or cleared. The commit was unaffected, and the layer is not read for that key until it is whole again. |
| `audit.failed` | An audit sink could not be delivered to, after its retries. |
| `storage.swept` | A store's retention pass ran. |
| `runtime.closed` | `close()` finished waiting for in-flight work. Carries `drained` and `pending`. |

Two of these are worth understanding rather than just counting.

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

An audit sink receives a copy of every committed event, out of band.

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
onUnhandled: (error) => console.error("[ekman] unhandled", error),
```

Nothing should reach this. It exists so that if something does, it is visible rather than
becoming an unhandled rejection with no context. `post()` routes its failures here, since a
fire-and-forget send has no caller to reject.

## Next

- [Error codes](./errors.md) for the codes carried by a rejected `send`.
- [Execution](./execution.md) for what produces `handler.retried`, `handler.timedOut` and `commit.fenced`.
