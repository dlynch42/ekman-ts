import type { ErrorCode } from "./errors";
import type { Values } from "./types";

/** What caused an event: the trigger's type and its id. */
export interface EventCause {
  readonly type: string;
  readonly id: string;
}

/** A committed state or values change. */
export interface TransitionEvent<
  S extends string = string,
  V extends Values = Values,
> {
  readonly type: "transition";
  readonly key: string;
  /** Null exactly once per instance, on initialization. */
  readonly from: S | null;
  readonly to: S;
  readonly seq: number;
  readonly at: number;
  readonly cause: EventCause;
  readonly values: Readonly<V>;
}

/**
 * A trigger that was refused before it could reach a handler.
 *
 * Carries the sequence the instance was at when it was refused. A rejection is not a
 * commit, so it does not advance the sequence: across a key's stream `seq` is
 * non-decreasing rather than unique.
 */
export interface RejectedEvent {
  readonly type: "rejected";
  readonly key: string;
  readonly seq: number;
  readonly at: number;
  readonly cause: EventCause;
  readonly code: ErrorCode;
  readonly reason: string;
}

/** Which kind of constraint produced a violation. */
export type ConstraintKind = "transition" | "guard" | "invariant" | "temporal";

/**
 * A constraint that did not hold.
 *
 * Recorded under `reject` as well as under `warn`, distinguished by `policy`. The stream
 * an operator already reads is the right place for both: "every violation in the last
 * hour" should not have to union two sources, and a rejection nobody can find is not much
 * better than a silent one.
 *
 * A violation is not a commit, so it carries the sequence of the commit it followed
 * without advancing it.
 */
export interface ViolationEvent<S extends string = string> {
  readonly type: "violation";
  readonly key: string;
  readonly seq: number;
  readonly at: number;
  readonly cause: EventCause;
  readonly constraint: { readonly kind: ConstraintKind; readonly name: string };
  /** `warn` means the commit proceeded anyway. `reject` means it did not. */
  readonly policy: "reject" | "warn";
  readonly reason: string;
  /**
   * The change that was being attempted. Absent on a temporal violation, which is not
   * attached to a result.
   */
  readonly attempted?: { readonly from: S; readonly to: S };
}

/**
 * An instance was rebuilt from a store, after eviction or after a restart.
 *
 * Not a commit, so it carries the sequence it was restored *to* without advancing it. It
 * records that this runtime's view of the key began here, which is what makes a gap in a
 * stream explicable rather than mysterious.
 *
 * Deliberately not persisted. Writing a restore back to the store would turn every read
 * into a write, and would be worst exactly under a small memory budget, where reloads are
 * the whole point. Replay ignores it either way.
 */
export interface RestoredEvent {
  readonly type: "restored";
  readonly key: string;
  readonly seq: number;
  readonly at: number;
  readonly cause: EventCause;
  /** Whether a snapshot did the work or the stream was replayed from the beginning. */
  readonly from: "snapshot" | "replay";
  /** How many events were replayed on top of any snapshot. */
  readonly replayed: number;
}

export type EkmanEvent<S extends string = string, V extends Values = Values> =
  | TransitionEvent<S, V>
  | RejectedEvent
  | ViolationEvent<S>
  | RestoredEvent;

/** Only transition events reconstruct state. Everything else is a record of what happened. */
export function isTransitionEvent<S extends string, V extends Values>(
  event: EkmanEvent<S, V>
): event is TransitionEvent<S, V> {
  return event.type === "transition";
}

export function transitionEvent<S extends string, V extends Values>(
  event: Omit<TransitionEvent<S, V>, "type">
): TransitionEvent<S, V> {
  return Object.freeze({ type: "transition" as const, ...event });
}

export function rejectedEvent(
  event: Omit<RejectedEvent, "type">
): RejectedEvent {
  return Object.freeze({ type: "rejected" as const, ...event });
}

export function violationEvent<S extends string>(
  event: Omit<ViolationEvent<S>, "type">
): ViolationEvent<S> {
  return Object.freeze({ type: "violation" as const, ...event });
}

export function restoredEvent(
  event: Omit<RestoredEvent, "type">
): RestoredEvent {
  return Object.freeze({ type: "restored" as const, ...event });
}
