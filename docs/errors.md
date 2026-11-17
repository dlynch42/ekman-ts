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

### A trigger was refused

Nothing committed. Retrying cannot change the outcome, because the condition that refused it is
still true.

| Code | Means | HTTP |
|---|---|---|
| `INVALID_KEY` | The key is malformed, or is too long for the store to name a file after. | 400 |
| `UNKNOWN_ENTITY` | The key's first segment, or a query's `entity`, names no registered entity. | 404 |
| `UNKNOWN_STATE` | The current state has no handler and the unknown policy is `reject`. | 409 |
| `UNKNOWN_TRIGGER` | The trigger's type is not in the entity's declared trigger list. | 422 |
| `CONSTRAINT_VIOLATED` | A result did not satisfy a constraint whose policy is `reject`. | 409 |
| `COMMIT_FENCED` | A commit was refused because its attempt had been superseded. | 409 |

### The work failed or was abandoned

| Code | Means | HTTP |
|---|---|---|
| `HANDLER_FAILED` | The handler produced `fail`, or threw. | 500 |
| `HANDLER_TIMEOUT` | An attempt ran past its configured timeout. | 504 |

### The system is at a limit

Try again later. These are the codes that mean backpressure.

| Code | Means | HTTP |
|---|---|---|
| `INBOX_OVERFLOW` | The inbox was full and the overflow policy is `reject`. The trigger did not land. | 503 with `Retry-After` |
| `TRIGGER_DROPPED` | The inbox was full and an overflow policy dropped this trigger on purpose. | 503 |
| `MEMORY_EXHAUSTED` | The memory budget is full and the eviction policy refuses rather than evicting. | 503 |
| `STORE_FULL` | A store is at its retention budget and its policy refuses new instances. Instances it already holds keep committing. | 503 |
| `STORE_UNAVAILABLE` | The store could not do what was asked: the commit authority could not be reached, or the file store met a filesystem failure or a corrupt log. The commit did not happen. The message names the store and the key, never a path. | 503 |
| `STORE_CONFLICT` | A conditional append found the key at a different sequence. Nothing was written. | 409 |
| `KEY_BUSY` | An operation needed the key idle and it was not. Only `forget` raises this. | 409 |
| `RUNTIME_CLOSED` | The runtime has been closed, so the trigger was not accepted, or a retry that was waiting was abandoned. Not retried by the runtime; a replacement process is usually starting. | 503 |

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

The distinction a client actually needs is 409 versus 503: **409 means this will never work and
you should stop, 503 means try again shortly.** A constraint violation is deterministic, so it
will be violated again in exactly the same way. An inbox overflow is this instant only.

## Retries and refusals

The default `retryable` predicate retries anything except a refusal, because a refusal cannot
come out differently on a second attempt: the state still has no handler, the trigger type is
still unrecognized, the token is still fenced, the constraint still does not hold. See
[Execution](./execution.md).
