# Ordering and the bounded inbox

[Back to the docs index](./README.md)

```ts
const ekman = new Ekman({
  entities: [orders],
  inbox: { capacity: 128, overflow: "reject" },
});
```

Every key has its own FIFO inbox. One handler runs per key at a time, and the rest wait in order.

## Capacity is triggers, not bytes

`capacity` is how many triggers may wait behind the one being handled. It is unrelated to
`memory`, which is a byte budget for resident instances. A `capacity` of 0 means one at a time
with no backlog at all.

Unbounded queues turn overload into silent latency and memory growth, which is why there is no
setting for one.

With `capacity: 1`, four triggers arriving at once for the same key means one is handled, one
waits, and two meet the overflow policy:

```
reject        ok, ok, INBOX_OVERFLOW, INBOX_OVERFLOW    final values built from triggers 1 and 2
drop-newest   ok, ok, TRIGGER_DROPPED, TRIGGER_DROPPED  final values built from triggers 1 and 2
drop-oldest   ok, TRIGGER_DROPPED, TRIGGER_DROPPED, ok  final values built from triggers 1 and 4
```

## Overflow policies

When the inbox is full, the overflow policy decides, and the sender always finds out.

| Policy | What happens | The sender sees | This is |
|---|---|---|---|
| `reject` (default) | The trigger does not land. | `send()` rejects with `INBOX_OVERFLOW`. | Backpressure. The caller can retry or shed. |
| `drop-newest` | The arriving trigger is discarded. | `send()` rejects with `TRIGGER_DROPPED`. | Shedding. The trigger is gone on purpose. |
| `drop-oldest` | The longest-waiting queued trigger is discarded. | The dropped trigger's `send()` rejects with `TRIGGER_DROPPED`. | Shedding, biased toward freshness. |

The distinction matters operationally. `INBOX_OVERFLOW` means try again; over HTTP it is a 503
with `Retry-After`. `TRIGGER_DROPPED` means do not try again, because this was deliberate.

## Overflow is visible, and it is not history

Every drop and rejection is reported through [telemetry](./telemetry.md) as `inbox.rejected` or
`inbox.dropped`. None of it enters the instance's transition history unless you ask for it with
`recordOverflow`, because queue pressure is the runtime's business and history is domain-only.

```ts
inbox: { capacity: 128, overflow: "drop-oldest", recordOverflow: true },
```

## Dispatch reads the state at dequeue time

A trigger that waited behind three others is handled by whatever state those three left behind,
never the state that was current when it was enqueued. This is what makes a queue of triggers
behave like a queue of intentions rather than a queue of stale decisions.

## Retries keep the key occupied

A queued trigger cannot slip past an attempt that is still in flight, including while that
attempt is being retried. See [Execution](./execution.md).

```
npm run demo:ordering    # five triggers at one slow key, read-modify-write, no lost updates
```
