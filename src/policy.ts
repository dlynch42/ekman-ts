import { assertKnownKeys } from "./config";
import { EkmanError, isEkmanError } from "./errors";

/**
 * Execution policy: how many times an attempt is made, how long each one may take, and
 * how long to wait between them.
 *
 * Applied by the runtime, outside handler code. A handler never writes a retry loop, a
 * timeout, or a backoff, because those are properties of running the handler rather than
 * of the domain logic inside it.
 */

/** How long to wait before the next attempt. */
export type Backoff =
  | { readonly kind: "fixed"; readonly delayMs: number }
  | {
      readonly kind: "exponential";
      readonly baseMs: number;
      /** Multiplier per attempt. Defaults to 2. */
      readonly factor?: number;
      /** Ceiling on the computed delay. Defaults to 30 seconds. */
      readonly maxDelayMs?: number;
    };

export interface ExecutionPolicy {
  /**
   * Total attempts, including the first. Defaults to 1, meaning no retries.
   *
   * The default is deliberately conservative: retrying a handler that is not idempotent
   * is a correctness decision, so it is opted into rather than inherited.
   */
  readonly maxAttempts?: number;
  /**
   * How long one attempt may take before it is abandoned. Defaults to no timeout.
   *
   * A timed-out attempt is fenced, so its eventual result cannot commit even though the
   * handler itself keeps running.
   */
  readonly timeoutMs?: number;
  /** Wait between attempts. Only consulted when `maxAttempts` is above 1. */
  readonly backoff?: Backoff;
  /**
   * Whether a given failure is worth another attempt. Defaults to retrying anything
   * except a refusal, which would only be refused again.
   *
   * Receives the error the handler threw or failed with, never the `HANDLER_FAILED` error
   * the sender is given. For a failure the runtime raised itself (a timeout, a store
   * conflict, a constraint refusal) it receives that `EkmanError`.
   */
  readonly retryable?: (error: Error) => boolean;
}

export interface ResolvedPolicy {
  readonly maxAttempts: number;
  readonly timeoutMs: number | undefined;
  readonly backoff: Backoff;
  readonly retryable: (error: Error) => boolean;
}

/**
 * The longest delay a timer can hold, in milliseconds: 2^31 - 1, a little under 25 days.
 *
 * A larger delay is not waited for. The platform's timers store it as a signed 32-bit
 * integer and fall back to 1ms when it does not fit, so `timeoutMs: Infinity` would time
 * out every attempt at once. Every setting that becomes a timer is held under this.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** The options an execution policy may carry. A state's policy adds `handler` to these. */
export const POLICY_KEYS = [
  "maxAttempts",
  "timeoutMs",
  "backoff",
  "retryable",
] as const;

const BACKOFF_KEYS = {
  fixed: ["kind", "delayMs"],
  exponential: ["kind", "baseMs", "factor", "maxDelayMs"],
} as const;

const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 30_000;

export const DEFAULT_BACKOFF: Backoff = {
  kind: "exponential",
  baseMs: 50,
  factor: DEFAULT_FACTOR,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
};

/**
 * Codes that describe a trigger the runtime refused rather than work that failed.
 *
 * Retrying one of these cannot change the outcome: the state still has no handler, the
 * trigger type is still unrecognized, the token is still fenced, the constraint still does
 * not hold.
 */
const NOT_RETRYABLE = new Set([
  "INVALID_KEY",
  "UNKNOWN_ENTITY",
  "UNKNOWN_STATE",
  "UNKNOWN_TRIGGER",
  "UNHANDLED_TRIGGER",
  "INBOX_OVERFLOW",
  "TRIGGER_DROPPED",
  "COMMIT_FENCED",
  "CONSTRAINT_VIOLATED",
  "INVALID_CONFIG",
  "NOT_IMPLEMENTED",
  "RUNTIME_CLOSED",
]);

export function defaultRetryable(error: Error): boolean {
  return !(isEkmanError(error) && NOT_RETRYABLE.has(error.code));
}

export const DEFAULT_POLICY: ResolvedPolicy = Object.freeze({
  maxAttempts: 1,
  timeoutMs: undefined,
  backoff: DEFAULT_BACKOFF,
  retryable: defaultRetryable,
});

/**
 * Layer a per-state policy over the runtime's default.
 *
 * Field by field, so a state that sets only `timeoutMs` keeps the runtime's
 * `maxAttempts` rather than silently reverting it to the built-in default.
 */
export function resolvePolicy(
  global: ExecutionPolicy | undefined,
  override: ExecutionPolicy | undefined,
  label: string
): ResolvedPolicy {
  const merged: ExecutionPolicy = { ...global, ...override };

  const maxAttempts = merged.maxAttempts ?? DEFAULT_POLICY.maxAttempts;
  if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label}: maxAttempts must be an integer of at least 1, received ${JSON.stringify(maxAttempts)}. ` +
        "1 means the attempt is made once, with no retries."
    );
  }

  const { timeoutMs } = merged;
  if (
    timeoutMs !== undefined &&
    !(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)
  ) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label}: timeoutMs must be greater than 0 and at most ${MAX_TIMER_MS}, ` +
        `received ${describe(timeoutMs)}. Omit it for no timeout.`
    );
  }

  const backoff = merged.backoff ?? DEFAULT_POLICY.backoff;
  assertBackoff(backoff, label);

  return Object.freeze({
    maxAttempts,
    timeoutMs,
    backoff,
    retryable: merged.retryable ?? DEFAULT_POLICY.retryable,
  });
}

/**
 * Refuse a backoff whose delays a timer could not hold or that is not one of the two kinds.
 *
 * Every field that becomes a wait is checked, the ceiling and the multiplier included. A
 * multiplier of zero or `NaN` would turn every wait after the first into no wait at all.
 */
function assertBackoff(backoff: Backoff, label: string): void {
  if (!(backoff.kind in BACKOFF_KEYS)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label}: backoff kind ${describe((backoff as { kind: unknown }).kind)} is not recognized. ` +
        `Expected one of: ${Object.keys(BACKOFF_KEYS).join(", ")}`
    );
  }

  const base = backoff.kind === "fixed" ? backoff.delayMs : backoff.baseMs;
  assertDelay(base, "backoff delay", label);

  if (backoff.kind === "fixed") {
    return;
  }

  if (backoff.maxDelayMs !== undefined) {
    assertDelay(backoff.maxDelayMs, "backoff maxDelayMs", label);
  }

  const { factor } = backoff;
  if (factor !== undefined && !(Number.isFinite(factor) && factor > 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label}: backoff factor must be a finite number greater than 0, received ${describe(factor)}`
    );
  }
}

function assertDelay(value: unknown, what: string, label: string): void {
  if (
    !(
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= MAX_TIMER_MS
    )
  ) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label}: ${what} must be a number of milliseconds from 0 to ${MAX_TIMER_MS}, ` +
        `received ${describe(value)}`
    );
  }
}

/** `JSON.stringify` renders `Infinity` and `NaN` as `null`, which would misreport both. */
function describe(value: unknown): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

/**
 * Refuse an execution policy carrying an option it does not have.
 *
 * Separate from `resolvePolicy`, which runs on every dispatch and should not pay for a
 * check whose answer cannot change after definition.
 *
 * @param policy the policy as declared, on the runtime, an entity or a state
 * @param label what it was declared on, for the error
 */
export function assertPolicyKeys(
  policy: ExecutionPolicy | undefined,
  label: string
): void {
  assertKnownKeys(label, policy, POLICY_KEYS);

  // Typed as it can arrive from a caller the compiler never saw. A null here would read
  // as "use the default" further on, which is not what anyone who wrote it was told.
  const backoff = policy?.backoff as Backoff | null | undefined;
  if (backoff === null) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label}: backoff is null. Give it a kind, or leave it out.`
    );
  }
  if (backoff !== undefined && backoff.kind in BACKOFF_KEYS) {
    assertKnownKeys(`${label} backoff`, backoff, BACKOFF_KEYS[backoff.kind]);
  }
}

/**
 * How long to wait before `attempt`, which is 1-based and always at least 2 here: there
 * is no wait before the first attempt.
 */
export function backoffDelay(backoff: Backoff, attempt: number): number {
  if (backoff.kind === "fixed") {
    return backoff.delayMs;
  }

  const factor = backoff.factor ?? DEFAULT_FACTOR;
  const ceiling = backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  // No jitter. Scenarios must be reproducible across implementations, and a shared
  // suite cannot assert on a randomized delay. Jitter belongs behind an explicit
  // opt-in if it is ever added.
  return Math.min(backoff.baseMs * factor ** (attempt - 2), ceiling);
}
