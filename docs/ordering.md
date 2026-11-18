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
with `Retry-After`. `TRIGGER_DROPPED` means that trigger is gone, on purpose. Sending the same
one again only repeats the shedding; whether a fresh one is worth sending is the producer's
call. [Error codes](./errors.md) has the retry answer for every code.

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

## Reentrancy: do not await a send to your own key

A handler that awaits `send()` to the key it is handling waits on itself. The inner trigger
queues behind the handler, and the handler is waiting for the inner trigger:

```ts
deploying: async (deployment, trigger, ctx) => {
  await ekman.send(ctx.key, { type: "progress" });   // never resolves
  return stay(deployment.values);
},
```

The runtime does not detect this. What happens next depends on the execution policy:

- **With no `timeoutMs`, which is the default, the key is stuck for good.** Nothing is logged
  and nothing is emitted. Later triggers for the key queue behind it until the inbox is full and
  they meet the overflow policy, and `close()` waits out its deadline.
- **With a `timeoutMs`, the attempt ends in `HANDLER_TIMEOUT`.** The inner trigger then runs, on
  whatever state the key is in by then.

It is easy to reach without writing that line. A handler that owns something with callbacks, such
as a consumer, a watcher or a subscription, and awaits it, has the same shape if a callback sends
to the same key.

Use `post()` for follow-up work on the same key. It queues the trigger and returns at once, so
the handler finishes and the follow-up is handled next, on the state the handler committed:

```ts
deploying: (deployment, trigger, ctx) => {
  ekman.post(ctx.key, { type: "progress" });
  return stay(deployment.values);
},
```

Give any handler that waits on a callback a `timeoutMs`, so a mistake here costs one timeout and
not the key. Sending to a different key from inside a handler is fine.

```
npm run demo:ordering    # five triggers at one slow key, read-modify-write, no lost updates
```
