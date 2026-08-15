import type { RuntimeDeps } from "./config";
import type { ErrorCode } from "./errors";
import { EkmanError } from "./errors";
import type { EkmanEvent, EventCause, TransitionEvent } from "./events";
import { rejectedEvent, transitionEvent } from "./events";
import { assertCommittable, CommitToken, fenceViolation } from "./fence";
import { Inbox } from "./inbox";
import type { InstanceSnapshot, Values } from "./types";

/**
 * One resident instance: its committed state, values, sequence, event stream, and the
 * tail of its serializer chain.
 *
 * Every mutation goes through `commit`, which applies state, values, sequence and event
 * in one synchronous block. There is no `await` inside it, so on a single isolate no
 * observer can see a half-applied commit.
 */
export class InstanceRecord<
  S extends string = string,
  V extends Values = Values,
> {
  readonly key: string;
  readonly entity: string;

  #state: S;
  #values: Readonly<V>;
  #seq: number;
  readonly #events: EkmanEvent<S, V>[] = [];

  /**
   * This key's bounded FIFO inbox: what keeps exactly one handler running per key and
   * every later trigger behind it.
   */
  readonly inbox: Inbox;

  constructor(args: {
    key: string;
    entity: string;
    initial: S;
    initialValues: Readonly<V>;
    at: number;
    cause: EventCause;
    deps: RuntimeDeps;
  }) {
    this.key = args.key;
    this.entity = args.entity;
    this.inbox = new Inbox({
      key: args.key,
      entity: args.entity,
      deps: args.deps,
      // An overflow refusal is recorded the same way any other refusal is, so a stream
      // that has `recordOverflow` on stays uniform.
      record: (refusal) => this.reject(refusal),
    });
    this.#state = args.initial;
    this.#values = args.initialValues;
    this.#seq = 0;

    // Initialization is itself a commit, at sequence 0, and it is the only event whose
    // `from` is null. Recording it is what makes the stream replayable on its own.
    this.#events.push(
      transitionEvent<S, V>({
        key: this.key,
        from: null,
        to: this.#state,
        seq: 0,
        at: args.at,
        cause: args.cause,
        values: this.#values,
      })
    );
  }

  get state(): S {
    return this.#state;
  }

  get values(): Readonly<V> {
    return this.#values;
  }

  get seq(): number {
    return this.#seq;
  }

  get events(): readonly EkmanEvent<S, V>[] {
    return this.#events;
  }

  /**
   * Whether this instance can be touched by eviction: no handler running and nothing
   * waiting behind it.
   */
  get idle(): boolean {
    return this.inbox.idle;
  }

  /** The immutable view a handler receives. */
  snapshot(): InstanceSnapshot<S, V> {
    return Object.freeze({
      key: this.key,
      entity: this.entity,
      state: this.#state,
      values: this.#values,
      seq: this.#seq,
    });
  }

  /**
   * Issue a commit token for an attempt, bound to this key and to the sequence the
   * attempt is about to observe.
   *
   * Every attempt gets its own. A token is the only thing that authorizes a commit, so
   * an attempt that has been timed out, superseded, or evicted holds a worthless one.
   */
  issueToken(attempt: number): CommitToken {
    return new CommitToken({ key: this.key, seq: this.#seq, attempt });
  }

  /** Whether this token still authorizes a commit against the instance as it stands. */
  committable(token: CommitToken): boolean {
    return (
      fenceViolation(token, { key: this.key, seq: this.#seq }) === undefined
    );
  }

  /**
   * Apply a handler result. Advances the sequence exactly once and appends exactly one
   * transition event.
   *
   * The fence is checked here, before anything is mutated, because this is the single
   * point every committed result in the runtime passes through. A check anywhere else is
   * one somebody can forget to make.
   */
  commit(
    next: {
      state: S;
      values: Readonly<V>;
      at: number;
      cause: EventCause;
    },
    token: CommitToken
  ): TransitionEvent<S, V> {
    assertCommittable(token, { key: this.key, seq: this.#seq });

    const event = transitionEvent<S, V>({
      key: this.key,
      from: this.#state,
      to: next.state,
      seq: this.#seq + 1,
      at: next.at,
      cause: next.cause,
      values: next.values,
    });

    // One synchronous block, no awaits: state, values, sequence and event land together.
    this.#state = next.state;
    this.#values = next.values;
    this.#seq = event.seq;
    this.#events.push(event);

    return event;
  }

  /**
   * Record a trigger that was refused before reaching a handler.
   *
   * A rejection is not a commit, so it does not advance the sequence. It carries the
   * sequence the instance was at, which makes `seq` non-decreasing across the stream
   * rather than unique.
   */
  reject(args: {
    code: ErrorCode;
    reason: string;
    at: number;
    cause: EventCause;
  }): void {
    this.#events.push(
      rejectedEvent({
        key: this.key,
        seq: this.#seq,
        at: args.at,
        cause: args.cause,
        code: args.code,
        reason: args.reason,
      })
    );
  }
}

/**
 * Deep-copy and freeze values at the commit boundary.
 *
 * Copying means a handler that keeps a reference to what it returned cannot mutate
 * committed state afterwards. `structuredClone` also enforces the documented contract
 * that values are serializable, and fails loudly here rather than at the first attempt
 * to persist them in a later phase.
 */
export function sealValues<V extends Values>(
  values: V,
  key: string
): Readonly<V> {
  try {
    return Object.freeze(structuredClone(values) as V);
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: EkmanError takes `cause` in its options bag and forwards it to the Error constructor
    throw new EkmanError(
      "HANDLER_FAILED",
      `values committed for ${key} are not serializable. Values must be a plain, ` +
        "serializable map: no functions, class instances, or symbols.",
      { key, cause }
    );
  }
}
