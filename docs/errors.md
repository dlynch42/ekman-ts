# Error codes

[Back to the docs index](./README.md)

```ts
import { isEkmanError } from "ekman";

try {
  await ekman.entities.orders.send("a-1", { type: "ship" });
} catch (error) {
  if (isEkmanError(error)) {
    console.log(error.code, error.key, error.message);
  }
}
```

Every failure carries a **stable `code`**. Branch on that, never on the message: messages are
written to be read by a person and will change.

`ConstraintViolationError` is a subclass carrying which constraint failed and what was attempted;
`isConstraintViolation(error)` narrows to it.

## The codes

There are 22, and they fall into four groups.

The **Retry?** column is the contract: whether sending the same trigger again can come out
differently. The **HTTP** column is a suggested mapping, and it does not carry that answer on its
own, because two codes that share a status can differ on it.

### A trigger was refused

Nothing committed, and the condition that refused it is still true.

| Code | Means | Retry? | HTTP |
|---|---|---|---|
| `INVALID_KEY` | The key is malformed, or is too long for the store to name a file after. | no | 400 |
| `UNKNOWN_ENTITY` | The key's first segment, or a query's `entity`, names no registered entity. | no | 404 |
| `UNKNOWN_STATE` | The current state has no handler and the unknown policy is `reject`. | no | 409 |
| `UNKNOWN_TRIGGER` | The trigger's type is not in the entity's declared trigger list. | no | 422 |
| `CONSTRAINT_VIOLATED` | A result did not satisfy a constraint whose policy is `reject`. | no, unless the instance has since moved | 409 |
| `COMMIT_FENCED` | A commit was refused because its attempt had been superseded. | only if the handler's work is safe to repeat | 409 |

### The work failed or was abandoned

The runtime has already made every attempt the [execution policy](./execution.md) allows by the
time a sender sees one of these.

| Code | Means | Retry? | HTTP |
|---|---|---|---|
| `HANDLER_FAILED` | The handler produced `fail`, or threw. The thrown error is the `cause`. | depends on why the handler failed | 500 |
| `HANDLER_TIMEOUT` | An attempt ran past its configured timeout. The abandoned handler may still finish its side effects. | only if the handler's work is safe to repeat | 504 |

### The system is at a limit

| Code | Means | Retry? | HTTP |
|---|---|---|---|
| `INBOX_OVERFLOW` | The inbox was full and the overflow policy is `reject`. The trigger did not land. | yes, shortly | 503 with `Retry-After` |
| `TRIGGER_DROPPED` | The inbox was full and an overflow policy dropped this trigger on purpose. | no: that trigger is gone, and whether to send a new one is the producer's call | 503 |
| `MEMORY_EXHAUSTED` | The memory budget is full and the eviction policy refuses rather than evicting. | yes, once something is released | 503 |
| `STORE_FULL` | A store is at its retention budget and its policy refuses new instances. Instances it already holds keep committing. | not until space is reclaimed | 503 |
| `STORE_UNAVAILABLE` | The store could not do what was asked: the commit authority could not be reached, or the file store met a filesystem failure or a corrupt log. The commit did not happen. The message names the store and the key, never a path. | yes, once the store is back | 503 |
| `STORE_CONFLICT` | A conditional append found the key at a different sequence. Nothing was written. | yes: the key is reloaded, so the next send is handled on its current state | 409 |
| `KEY_BUSY` | An operation needed the key idle and it was not: a handler was in flight, or a sweep was evaluating it. Only `forget` raises this. | yes, once the key is idle | 409 |
| `RUNTIME_CLOSED` | The runtime has been closed, so the trigger was not accepted, or a retry that was waiting was abandoned. | not against this runtime; a replacement process is usually starting | 503 |

### Configuration was wrong

These are raised at definition or startup, not per request. A process that starts is a process
whose configuration was accepted.

| Code | Means |
|---|---|
| `DUPLICATE_ENTITY` | Two entities were registered under one name. |
| `DUPLICATE_STATE_HANDLER` | Two handlers were declared for one state. |
| `MISSING_INITIAL_STATE` | The entity declared no initial state. |
| `INITIAL_STATE_NOT_IN_STATES` | The declared initial state has no handler. |
| `INVALID_CONFIG` | Configuration is recognized but not satisfiable, and is refused rather than adjusted. |
| `NOT_IMPLEMENTED` | Configuration is recognized but not implemented. Never silently ignored. |

## Mapping to HTTP

The `HTTP` column above is the mapping [`examples/deploy-service`](../examples/deploy-service)
uses, and it is a lookup table rather than string matching precisely because the codes are
stable:

```ts
const STATUS: Record<string, number> = {
  INVALID_KEY: 400,
  UNKNOWN_ENTITY: 404,
  UNKNOWN_STATE: 409,
  UNKNOWN_TRIGGER: 422,
  CONSTRAINT_VIOLATED: 409,
  INBOX_OVERFLOW: 503,
  TRIGGER_DROPPED: 503,
  MEMORY_EXHAUSTED: 503,
  HANDLER_TIMEOUT: 504,
  STORE_FULL: 503,
  STORE_UNAVAILABLE: 503,
  STORE_CONFLICT: 409,
  KEY_BUSY: 409,
  COMMIT_FENCED: 409,
  RUNTIME_CLOSED: 503,
  HANDLER_FAILED: 500,
};
```

A 500 answers with a fixed message and logs the real one, because a handler's own error can
hold details that should not leave the service.

The example sends `Retry-After` on every 503, not only on `INBOX_OVERFLOW`.

Do not read the retry answer off the status. `STORE_CONFLICT` and `KEY_BUSY` are 409 and worth
sending again; `TRIGGER_DROPPED` and `STORE_FULL` are 503 and are not. A client that needs to
decide should be given the `code`, which the example puts in the response body, and should use
the Retry? column above.

## Retries and refusals

The default `retryable` predicate retries anything except a refusal, because a refusal cannot
come out differently on a second attempt: the state still has no handler, the trigger type is
still unrecognized, the token is still fenced, the constraint still does not hold. See
[Execution](./execution.md).
