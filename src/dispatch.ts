import { resolveErrorHandler } from "./entity"
import { EkmanError } from "./errors"
import type { EventCause } from "./events"
import type { InstanceRecord} from "./instance";
import { sealValues } from "./instance"
import { isHandlerResult, toError } from "./results"
import type { HandlerResult, StayResult, TransitionToResult } from "./results"
import type {
  CommitResult,
  EntityDefinition,
  HandlerContext,
  Trigger,
  Values,
} from "./types"

/** Everything a dispatch needs that is owned by the runtime rather than the instance. */
export interface DispatchDeps {
  now(): number
  /** Never aborts in this phase. Timeouts wire into it later. */
  signal: AbortSignal
}

/**
 * Run one trigger against one instance, to completion.
 *
 * Assumes the caller has already taken this key's turn in the serializer chain, so no
 * other handler is running for this key.
 */
export async function dispatch<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  trigger: Trigger,
  deps: DispatchDeps,
): Promise<CommitResult<S, V>> {
  const cause: EventCause = { type: trigger.type, id: trigger.id as string }

  // The entity may declare which trigger types it recognizes. An unrecognized one never
  // reaches a handler, and is refused loudly rather than dropped.
  if (definition.triggers !== null && !definition.triggers.has(trigger.type)) {
    return refuse(instance, deps, cause, "UNKNOWN_TRIGGER", () =>
      `entity "${definition.name}" does not recognize trigger type "${trigger.type}". ` +
      `Recognized: ${[...definition.triggers!].join(", ")}`,
    )
  }

  // Resolved against the current committed state at the moment this trigger is
  // dequeued, never the state it was enqueued under.
  const handler = definition.states.get(instance.state)

  if (handler === undefined) {
    return refuse(instance, deps, cause, "UNKNOWN_STATE", () =>
      `entity "${definition.name}" has no handler for state "${instance.state}", ` +
      `so trigger "${trigger.type}" cannot be dispatched`,
    )
  }

  const snapshot = instance.snapshot()
  const ctx: HandlerContext = Object.freeze({
    key: instance.key,
    entity: instance.entity,
    attempt: 1,
    signal: deps.signal,
  })

  let result: HandlerResult<S, V>
  try {
    result = await handler(snapshot, trigger, ctx)
  } catch (thrown) {
    result = { kind: "fail", error: toError(thrown) }
  }

  if (!isHandlerResult(result)) {
    result = {
      kind: "fail",
      error: new Error(
        `handler for "${definition.name}" state "${snapshot.state}" returned ${describe(result)} ` +
          `instead of transitionTo(), stay() or fail()`,
      ),
    }
  }

  if (result.kind === "fail") {
    return handleFailure(instance, definition, result.error, ctx, deps, cause)
  }

  return commit(instance, result, deps, cause)
}

/**
 * A failed attempt leaves the instance exactly where it was, then gives a matching error
 * handler the chance to produce a committed transition.
 */
async function handleFailure<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  error: Error,
  ctx: HandlerContext,
  deps: DispatchDeps,
  cause: EventCause,
): Promise<CommitResult<S, V>> {
  const errorHandler = resolveErrorHandler(definition, error)

  if (errorHandler !== undefined) {
    let recovery: HandlerResult<S, V>
    try {
      recovery = await errorHandler(instance.snapshot(), error, ctx)
    } catch (thrown) {
      // An error handler that itself fails does not get another error handler. That
      // would be an unbounded chain, and the original failure is the one worth reporting.
      throw failed(instance.key, error, toError(thrown))
    }

    if (isHandlerResult(recovery) && recovery.kind !== "fail") {
      return commit(instance, recovery, deps, cause)
    }

    if (isHandlerResult(recovery) && recovery.kind === "fail") {
      throw failed(instance.key, error, recovery.error)
    }
  }

  throw failed(instance.key, error)
}

function failed(key: string, error: Error, from?: Error): EkmanError {
  const suffix = from === undefined ? "" : ` (error handler also failed: ${from.message})`
  return new EkmanError("HANDLER_FAILED", `${error.message}${suffix}`, { key, cause: error })
}

/** Apply a transitionTo or stay result. */
function commit<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  result: TransitionToResult<S, V> | StayResult<V>,
  deps: DispatchDeps,
  cause: EventCause,
): CommitResult<S, V> {
  const state = result.kind === "transitionTo" ? result.state : instance.state
  // Omitted values carry the current ones forward rather than clearing them.
  const values =
    result.values === undefined ? instance.values : sealValues(result.values, instance.key)

  const event = instance.commit({ state, values, at: deps.now(), cause })

  return Object.freeze({
    key: instance.key,
    state: event.to,
    values: event.values,
    seq: event.seq,
    event,
  })
}

/** Record a refusal in the key's stream and reject the sender. */
function refuse<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  deps: DispatchDeps,
  cause: EventCause,
  code: "UNKNOWN_STATE" | "UNKNOWN_TRIGGER",
  reason: () => string,
): never {
  const message = reason()
  instance.reject({ code, reason: message, at: deps.now(), cause })
  throw new EkmanError(code, message, { key: instance.key })
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}
