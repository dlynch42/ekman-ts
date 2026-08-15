import type { ConstraintKind } from "./events";

/**
 * Stable error codes. These strings are part of the public contract and are shared
 * verbatim with every other Ekman implementation, so the conformance suite can assert
 * on them without asserting on human-readable messages.
 *
 * Adding a code is additive. Renaming or removing one is a breaking change.
 */
export const ERROR_CODES = [
  /** The key is malformed. */
  "INVALID_KEY",
  /** The key's first segment names no registered entity. */
  "UNKNOWN_ENTITY",
  /** The current state has no handler and the unknown policy is `reject`. */
  "UNKNOWN_STATE",
  /** The trigger's type is not in the entity's declared trigger list. */
  "UNKNOWN_TRIGGER",
  /** The handler produced `fail`, or threw. */
  "HANDLER_FAILED",
  /** The inbox was full and the overflow policy is `reject`. */
  "INBOX_OVERFLOW",
  /** The inbox was full and an overflow policy dropped this trigger. */
  "TRIGGER_DROPPED",
  /** An attempt ran past its configured timeout. */
  "HANDLER_TIMEOUT",
  /** A commit was refused because its attempt had been superseded. */
  "COMMIT_FENCED",
  /** A result did not satisfy a constraint whose policy is `reject`. */
  "CONSTRAINT_VIOLATED",
  /** Two entities were registered under one name. */
  "DUPLICATE_ENTITY",
  /** Two handlers were declared for one state. */
  "DUPLICATE_STATE_HANDLER",
  /** The entity declared no initial state. */
  "MISSING_INITIAL_STATE",
  /** The declared initial state has no handler. */
  "INITIAL_STATE_NOT_IN_STATES",
  /** Configuration is recognized but not satisfiable, and is refused rather than adjusted. */
  "INVALID_CONFIG",
  /** Configuration is recognized but not implemented yet. Never silently ignored. */
  "NOT_IMPLEMENTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface EkmanErrorOptions {
  /** The instance key this error concerns, when it concerns one. */
  key?: string;
  /** The underlying error, when this one wraps another. */
  cause?: unknown;
}

/**
 * Every error Ekman raises. Always carries a stable `code`; callers should branch on
 * that rather than on the message.
 */
export class EkmanError extends Error {
  /**
   * Typed as `string` rather than as its own literal so a subclass can narrow the
   * classification. Error handlers are keyed on this by default, so a subclass that could
   * not change it would be indistinguishable from any other Ekman failure.
   */
  override readonly name: string = "EkmanError";
  readonly code: ErrorCode;
  /**
   * `declare` on purpose: under `useDefineForClassFields` a plain optional field is
   * defined as `undefined` on every instance, which would put a dead `key` on errors
   * that have none and dirty up spreads and JSON. Declaring it emits no field, so the
   * property exists only when the constructor actually assigns it.
   */
  declare readonly key?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: EkmanErrorOptions = {}
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.code = code;
    if (options.key !== undefined) {
      this.key = options.key;
    }
    // `name` is a class field, so it is assigned after super() and after Error's own
    // stack capture. Re-capture so the stack header reads "EkmanError", not "Error".
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, EkmanError);
    } else {
      this.stack = composeStack(this.name, message, this.stack);
    }
  }
}

/**
 * A result that a constraint refused.
 *
 * A distinct class purely so its `name` differs, because error classification is
 * `error.name` by default. That is what lets an entity register a recovery for exactly
 * this failure alongside its domain ones:
 *
 * ```ts
 * onError: { ConstraintViolation: (instance, error) => stay({ blocked: error.message }) }
 * ```
 */
export class ConstraintViolationError extends EkmanError {
  override readonly name = "ConstraintViolation";
  readonly kind: ConstraintKind;
  /** The constraint's declared or derived name, matching the recorded violation event. */
  readonly constraint: string;

  constructor(args: {
    kind: ConstraintKind;
    constraint: string;
    key: string;
    reason: string;
  }) {
    super("CONSTRAINT_VIOLATED", args.reason, { key: args.key });
    this.kind = args.kind;
    this.constraint = args.constraint;
  }
}

export function isConstraintViolation(
  value: unknown
): value is ConstraintViolationError {
  return value instanceof ConstraintViolationError;
}

/**
 * Build a stack string headed by the error's own name, for engines that lack V8's
 * `Error.captureStackTrace`.
 *
 * Pulled out of the constructor because the absent-stack case cannot be produced from
 * inside one: V8 always populates `stack`, so the branch would be permanently untested
 * sitting inline. As a pure function it is exercised directly.
 */
export function composeStack(
  name: string,
  message: string,
  existing: string | undefined
): string {
  const header = `${name}: ${message}`;
  return existing === undefined ? header : `${header}\n${existing}`;
}

/** Narrowing helper for callers that catch broadly. */
export function isEkmanError(value: unknown): value is EkmanError {
  return value instanceof EkmanError;
}
