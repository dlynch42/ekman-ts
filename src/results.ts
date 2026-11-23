import type { Values } from "./types";

/** Request a state change, optionally replacing values. */
export interface TransitionToResult<
  S extends string = string,
  V extends Values = Values,
> {
  readonly kind: "transitionTo";
  readonly state: S;
  /** Absent means carry the current committed values forward unchanged. */
  readonly values?: V;
}

/** Request a values update without leaving the current state. */
export interface StayResult<V extends Values = Values> {
  readonly kind: "stay";
  /** Absent means carry the current committed values forward unchanged. */
  readonly values?: V;
}

/**
 * Request a merge into the current values, staying in the current state.
 *
 * `values` names only what changes. Everything else the instance knows is carried
 * forward.
 */
export interface PatchResult<V extends Values = Values> {
  readonly kind: "patch";
  readonly values: Partial<V>;
}

/** Decline to change anything and route through the failure path. */
export interface FailResult {
  readonly kind: "fail";
  readonly error: Error;
}

export type HandlerResult<
  S extends string = string,
  V extends Values = Values,
> = TransitionToResult<S, V> | StayResult<V> | PatchResult<V> | FailResult;

/**
 * Request a transition to `state`.
 *
 * Passing `values` replaces the instance's values. Omitting it carries the current
 * committed values forward, so `transitionTo("live")` is a pure state change.
 *
 * The no-argument overload returns `never` for the values type on purpose: a result that
 * carries no values is compatible with every entity's values type, so a shared helper
 * like `() => stay()` can be reused across entities that disagree about `V`.
 */
export function transitionTo<S extends string>(
  state: S
): TransitionToResult<S, never>;
export function transitionTo<S extends string, V extends Values>(
  state: S,
  values: V
): TransitionToResult<S, V>;
export function transitionTo<S extends string, V extends Values = Values>(
  state: S,
  values?: V
): TransitionToResult<S, V> {
  return Object.freeze(
    values === undefined
      ? { kind: "transitionTo" as const, state }
      : { kind: "transitionTo" as const, state, values }
  );
}

/**
 * Stay in the current state.
 *
 * Passing `values` replaces the instance's values. Omitting it is a no-op commit that
 * still advances the sequence and records an event.
 */
export function stay(): StayResult<never>;
export function stay<V extends Values>(values: V): StayResult<V>;
export function stay<V extends Values = Values>(values?: V): StayResult<V> {
  return Object.freeze(
    values === undefined
      ? { kind: "stay" as const }
      : { kind: "stay" as const, values }
  );
}

/**
 * Stay in the current state and merge `values` into what the instance already holds.
 *
 * The update for an instance that is memory about something: record the one thing that
 * was just learned without restating the rest, so a field nobody mentioned cannot be
 * dropped by accident.
 *
 * The merge is shallow. A field named here replaces the one held, whole, including when
 * it is an object or an array. The committed event carries the full merged values, as
 * every commit does, so a replay never has to know a merge happened.
 */
export function patch<P extends Values>(values: P): PatchResult<P> {
  return Object.freeze({ kind: "patch" as const, values });
}

/**
 * Fail the attempt. The instance keeps its previous committed state and values.
 *
 * Accepts anything throwable. Non-Error values are wrapped so the failure path always
 * has a real Error to classify and report, with the original preserved as `cause`.
 */
export function fail(error: unknown): FailResult {
  return Object.freeze({ kind: "fail" as const, error: toError(error) });
}

export function isTransitionTo<S extends string, V extends Values>(
  result: HandlerResult<S, V>
): result is TransitionToResult<S, V> {
  return result.kind === "transitionTo";
}

export function isStay<S extends string, V extends Values>(
  result: HandlerResult<S, V>
): result is StayResult<V> {
  return result.kind === "stay";
}

export function isPatch<S extends string, V extends Values>(
  result: HandlerResult<S, V>
): result is PatchResult<V> {
  return result.kind === "patch";
}

export function isFail<S extends string, V extends Values>(
  result: HandlerResult<S, V>
): result is FailResult {
  return result.kind === "fail";
}

/**
 * Whether a handler's return value is a well-formed result.
 *
 * A handler that returns something else has not resolved to one of the four results,
 * which the runtime treats the same way it treats a throw.
 */
export function isHandlerResult(value: unknown): value is HandlerResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { kind } = value as { kind?: unknown };
  return (
    kind === "transitionTo" ||
    kind === "stay" ||
    kind === "patch" ||
    kind === "fail"
  );
}

/** Coerce anything throwable into an Error without discarding the original. */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  return new Error(
    `handler failed with a non-error value: ${describe(value)}`,
    { cause: value }
  );
}

function describe(value: unknown): string {
  try {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: typed as a string, but `JSON.stringify` returns undefined for undefined, a function or a symbol, and a handler can throw any of them
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
