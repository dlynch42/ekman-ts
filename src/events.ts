import type { ErrorCode } from "./errors"
import type { Values } from "./types"

/** What caused an event: the trigger's type and its id. */
export interface EventCause {
  readonly type: string
  readonly id: string
}

/** A committed state or values change. */
export interface TransitionEvent<S extends string = string, V extends Values = Values> {
  readonly type: "transition"
  readonly key: string
  /** Null exactly once per instance, on initialization. */
  readonly from: S | null
  readonly to: S
  readonly seq: number
  readonly at: number
  readonly cause: EventCause
  readonly values: Readonly<V>
}

/**
 * A trigger that was refused before it could reach a handler.
 *
 * Carries the sequence the instance was at when it was refused. A rejection is not a
 * commit, so it does not advance the sequence: across a key's stream `seq` is
 * non-decreasing rather than unique.
 */
export interface RejectedEvent {
  readonly type: "rejected"
  readonly key: string
  readonly seq: number
  readonly at: number
  readonly cause: EventCause
  readonly code: ErrorCode
  readonly reason: string
}

export type EkmanEvent<S extends string = string, V extends Values = Values> =
  | TransitionEvent<S, V>
  | RejectedEvent

/** Only transition events reconstruct state. Everything else is a record of what happened. */
export function isTransitionEvent<S extends string, V extends Values>(
  event: EkmanEvent<S, V>,
): event is TransitionEvent<S, V> {
  return event.type === "transition"
}

export function transitionEvent<S extends string, V extends Values>(
  event: Omit<TransitionEvent<S, V>, "type">,
): TransitionEvent<S, V> {
  return Object.freeze({ type: "transition" as const, ...event })
}

export function rejectedEvent(event: Omit<RejectedEvent, "type">): RejectedEvent {
  return Object.freeze({ type: "rejected" as const, ...event })
}
