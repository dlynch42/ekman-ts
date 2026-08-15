import { EkmanError } from "./errors";

/**
 * Commit fencing.
 *
 * A running JavaScript function cannot be stopped. When an attempt times out, or is
 * superseded by a retry, or its instance is evicted, the handler keeps executing and will
 * eventually produce a result. Fencing is what makes that result harmless: every attempt
 * carries a token bound to the key and to the sequence observed when it was dispatched,
 * and a commit is rejected unless its token is still valid and the sequence still matches.
 *
 * `ctx.signal` asks a cooperative handler to stop early. The fence does not ask. Both
 * halves are needed: the signal for good citizens, the fence for everyone.
 */

export type FenceReason = "timeout" | "superseded" | "evicted";

export class CommitToken {
  readonly key: string;
  /** The instance's committed sequence at the moment this attempt was dispatched. */
  readonly seq: number;
  readonly attempt: number;

  #invalidatedBy: FenceReason | undefined;

  constructor(args: { key: string; seq: number; attempt: number }) {
    this.key = args.key;
    this.seq = args.seq;
    this.attempt = args.attempt;
    this.#invalidatedBy = undefined;
  }

  get valid(): boolean {
    return this.#invalidatedBy === undefined;
  }

  /** Why this token was invalidated, or undefined if it still holds. */
  get invalidatedBy(): FenceReason | undefined {
    return this.#invalidatedBy;
  }

  /**
   * Invalidate the token. Idempotent, and the first reason wins: a token invalidated by a
   * timeout and then superseded by the retry that replaced it is still, in the only sense
   * that matters to an operator reading telemetry, a timeout.
   */
  invalidate(reason: FenceReason): void {
    this.#invalidatedBy ??= reason;
  }
}

/**
 * Why a commit was refused, or undefined if it may proceed.
 *
 * Separated from the throwing path so the check itself is a pure function: the fence is
 * the one gate every commit passes through, and it should be testable without building a
 * runtime around it.
 */
export function fenceViolation(
  token: CommitToken,
  current: { key: string; seq: number }
): string | undefined {
  if (token.key !== current.key) {
    return `commit token was issued for ${token.key}, not ${current.key}`;
  }

  if (!token.valid) {
    return `commit token for ${token.key} was invalidated by ${token.invalidatedBy} on attempt ${token.attempt}`;
  }

  if (token.seq !== current.seq) {
    return `commit token for ${token.key} observed sequence ${token.seq}, but the instance is now at ${current.seq}`;
  }

  return;
}

export function assertCommittable(
  token: CommitToken,
  current: { key: string; seq: number }
): void {
  const violation = fenceViolation(token, current);

  if (violation !== undefined) {
    throw new EkmanError(
      "COMMIT_FENCED",
      `${violation}. The result of a superseded attempt is discarded rather than applied.`,
      { key: current.key }
    );
  }
}
