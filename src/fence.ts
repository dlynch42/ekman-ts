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
  #racedBy: FenceReason | undefined;
  #sealed: boolean;

  constructor(args: { key: string; seq: number; attempt: number }) {
    this.key = args.key;
    this.seq = args.seq;
    this.attempt = args.attempt;
    this.#invalidatedBy = undefined;
    this.#racedBy = undefined;
    this.#sealed = false;
  }

  get valid(): boolean {
    return this.#invalidatedBy === undefined;
  }

  /** Why this token was invalidated, or undefined if it still holds. */
  get invalidatedBy(): FenceReason | undefined {
    return this.#invalidatedBy;
  }

  /**
   * What tried to invalidate this token after it was already sealed.
   *
   * Purely observational: the commit went ahead. Recorded rather than dropped because the
   * sender was told the attempt failed while the work actually landed, and an operator
   * seeing a rate of this needs to know their timeouts are set close to how long their
   * store takes.
   */
  get racedBy(): FenceReason | undefined {
    return this.#racedBy;
  }

  /** Whether this attempt has taken ownership of the commit and can no longer be fenced. */
  get sealed(): boolean {
    return this.#sealed;
  }

  /**
   * Invalidate the token. Idempotent, and the first reason wins: a token invalidated by a
   * timeout and then superseded by the retry that replaced it is still, in the only sense
   * that matters to an operator reading telemetry, a timeout.
   *
   * Against a sealed token this does not fence anything. It records what arrived too late,
   * so the race is visible rather than silent. See `seal`.
   */
  invalidate(reason: FenceReason): void {
    if (this.#sealed) {
      this.#racedBy ??= reason;
      return;
    }
    this.#invalidatedBy ??= reason;
  }

  /**
   * Take ownership of the commit. Returns false if the token was already invalid.
   *
   * This exists because writing to a store takes time, and a timeout can fire in the
   * middle of it. Once an event has reached the commit authority it is durable, and the
   * in-memory state has to agree with it: refusing to apply an event the store already
   * holds would make replay reconstruct a state the live runtime never had, which is a far
   * worse failure than a timed-out sender learning the work landed anyway.
   *
   * So the fence is checked exactly once, at the moment the commit enters the authority,
   * and from then on the attempt owns the outcome. The narrow window where a timeout
   * arrives after the seal is reported as `commit.raced` rather than being papered over.
   */
  seal(): boolean {
    if (this.#invalidatedBy !== undefined) {
      return false;
    }
    this.#sealed = true;
    return true;
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
}

/**
 * Why a refused commit was refused, in the vocabulary telemetry reports.
 *
 * A token that was explicitly invalidated names its own reason. One still nominally
 * valid but whose sequence has moved was overtaken by another commit, which is
 * supersession arriving by a different route.
 *
 * A standalone function because the second case cannot be produced through the public
 * API on a serialized key: nothing else can commit while an attempt holds the key. It is
 * reachable through a store or another runtime in later phases, so the branch is real
 * and is tested here directly rather than left to rot inside a call site.
 */
export function fenceReason(token: CommitToken): FenceReason {
  return token.invalidatedBy ?? "superseded";
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
