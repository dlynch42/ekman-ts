# Execution policy

[Back to the docs index](./README.md)

```ts
const ekman = new Ekman({
  entities: [deployments],
  execution: {
    maxAttempts: 3,
    timeoutMs: 10_000,
    backoff: { kind: "exponential", baseMs: 50 },
  },
});
```

Retries, timeouts and backoff are properties of *running* a handler, not of the domain logic
inside it. They are configured once and applied by the runtime, so handlers do the work and
nothing else. No retry loop, no `Promise.race` against a timer, no sleep.

## The options

| Field | Default | What it does |
|---|---|---|
| `maxAttempts` | `1` | Total attempts including the first. The default means no retries. |
| `timeoutMs` | none | How long one attempt may take before it is abandoned. |
| `backoff` | `{ kind: "exponential", baseMs: 50, factor: 2, maxDelayMs: 30_000 }` | Wait between attempts. Only consulted when `maxAttempts` is above 1. |
| `retryable` | retry anything except a refusal | Whether a given failure is worth another attempt. |

`maxAttempts` defaults to 1 deliberately. Retrying a handler that is not idempotent is a
correctness decision, so it is opted into rather than inherited.

`retryable` defaults to retrying anything except a refusal, because a refusal cannot come out
differently on a second try: the state still has no handler, the trigger type is still
unrecognized, the token is still fenced, the constraint still does not hold.

### Backoff

```ts
backoff: { kind: "fixed", delayMs: 250 }
backoff: { kind: "exponential", baseMs: 50, factor: 2, maxDelayMs: 30_000 }
```

## Layering

Settings layer runtime, then entity, then state, **field by field**. A state that sets only
`timeoutMs` keeps the runtime's `maxAttempts` rather than silently reverting it to the built-in
default.

```ts
// runtime
execution: { maxAttempts: 3, timeoutMs: 10_000, backoff: { kind: "exponential", baseMs: 50 } },

// entity
policy: { maxAttempts: 2 },

// state
states: {
  deploying: { handler: handleDeploying, maxAttempts: 5, timeoutMs: 30_000 },
},
```

`deploying` ends up with `maxAttempts: 5`, `timeoutMs: 30_000`, and the runtime's exponential
backoff, which nothing below it overrode.

```
npm run demo:execution-policy    # the three layers, field by field
```

## Retries keep the key occupied

An attempt being retried still holds its key. A queued trigger waits for the whole retry
sequence, not just the first attempt. This is what stops a retry from becoming a hole in the
ordering guarantee.

## Timeouts, and why they are not cancellation

A running JavaScript function cannot be stopped. Nothing in the language lets a runtime reach
into a handler that is midway through an `await` and end it. So a timeout does two things:

1. **It aborts `ctx.signal`.** Handlers that watch it can return early and clean up.
2. **It invalidates the attempt's commit token.**

```ts
deploying: async (deployment, trigger, ctx) => {
  const res = await fetch(url, { signal: ctx.signal });   // cooperative
  return transitionTo("live", { ...deployment.values });
},
```

The second one is the guarantee. `ctx.signal` is a courtesy for handlers that can use it; the
fence covers every handler including the ones that cannot.

## Fencing

Every attempt carries a commit token bound to `(key, sequence-at-dispatch)`. A commit is
accepted only if its token is still valid and the key is still at the sequence the attempt was
dispatched on.

Three things invalidate a token: the attempt timing out, a retry superseding it, and the
instance being evicted.

So an abandoned handler keeps running, eventually finishes, tries to commit, and is refused
with `COMMIT_FENCED`. That is what makes a zombie handler *harmless* rather than merely
unlikely. The commit is refused, the refusal is recorded, and nothing the zombie computed
reaches committed state.

The honest counterpart matters too: a commit that already reached the store before the timeout
fired stands. It is reported as `commit.raced` in [telemetry](./telemetry.md) rather than being
quietly undone, because undoing a durable write to make a timer look right would be a worse lie
than the race.

```
npm run demo:fencing    # a handler that ignores its timeout, runs to completion, and is refused
```

## Failure handling

A handler that exhausts its attempts produces `HANDLER_FAILED`. If the entity declares
`onError`, that runs and can commit something legal instead. See [Entities](./entities.md).

## Next

- [Telemetry](./telemetry.md) for `handler.started`, `handler.retried`, `handler.timedOut`, `handler.settled`, `commit.fenced` and `commit.raced`.
- [Error codes](./errors.md) for what each failure means to a caller.
