import type { RuntimeDeps } from "./config";
import type { Violation } from "./constraints";
import type { ErrorCode } from "./errors";
import { EkmanError, isEkmanError } from "./errors";
import type { EkmanEvent, EventCause, TransitionEvent } from "./events";
import {
  rejectedEvent,
  restoredEvent,
  transitionEvent,
  violationEvent,
} from "./events";
import { assertCommittable, CommitToken, fenceViolation } from "./fence";
import { Inbox } from "./inbox";
import { accountBytes } from "./memory";
import type { ReplayedState, Store, StoreSnapshot } from "./store";
import { EMPTY_SEQ, replay } from "./store";
import type { InstanceSnapshot, Values } from "./types";

/**
 * One resident instance: its committed state, values, sequence, event stream, and inbox.
 *
 * Every mutation goes through `commit`, which is the single gate for the fence, for
 * persistence, and for memory accounting. A check anywhere else is one somebody can forget
 * to make at a call site that lands later.
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
  #enteredAt: number;
  #bytes: number;
  readonly #events: EkmanEvent<S, V>[] = [];
  readonly #deps: RuntimeDeps;

  /**
   * Temporal constraints that have already fired for the current state.
   *
   * Cleared on every state change, so a constraint fires once per entry rather than on
   * every sweep for as long as the instance sits there. Without this an interval sweep
   * over one stuck instance produces an unbounded stream of identical escalations.
   */
  readonly #firedTemporal = new Set<string>();

  /**
   * Whether this record still has to be reconciled with the store.
   *
   * The record is created synchronously inside `send()`, because FIFO order is call order
   * only if nothing is awaited between a caller entering `send()` and the inbox push.
   * Loading, which is I/O, therefore cannot happen there. It happens in the first inbox
   * turn instead, which is inside the serializer and so cannot reorder anything.
   */
  #pending: PendingInit<S, V> | undefined;
  /**
   * Whether another writer has moved this key underneath us.
   *
   * Set when a conditional append is refused, cleared by the reload that answers it. This
   * is the only thing in the record that can be false while the resident view is wrong,
   * which is why it is read before dispatch rather than trusted.
   *
   * Declared here and assigned in the constructor rather than initialized inline, for the
   * same reason `Inbox.#running` is: an inline `= false` narrows the field to the literal
   * `false`, after which the guard that reads it looks statically dead.
   */
  #stale: boolean;
  #hydration: Promise<void> | undefined;

  /**
   * What this entity starts as, kept so a record can go back to it.
   *
   * Needed only by the reload that finds a key gone: the record has to become what a
   * brand-new one would be, and by then its own state and values are whatever it last
   * committed rather than what it began with.
   */
  readonly #initial: S;
  readonly #initialValues: Readonly<V>;

  /**
   * Tail of this key's store-write chain.
   *
   * Events reach the authority in stream order even though only commits are awaited: a
   * violation recorded during dispatch must land before the commit that follows it, or its
   * conditional append would race the sequence forward. The chain never rejects, for the
   * same reason the Phase 1 serializer never did, so one failed write cannot poison every
   * write behind it.
   */
  #writes: Promise<void> = Promise.resolve();

  readonly inbox: Inbox;

  constructor(args: {
    key: string;
    entity: string;
    initial: S;
    initialValues: Readonly<V>;
    at: number;
    cause: EventCause;
    deps: RuntimeDeps;
    /** Called when this key goes idle, which is when eviction may consider it. */
    onIdle?: () => void;
  }) {
    this.key = args.key;
    this.entity = args.entity;
    this.#deps = args.deps;
    this.inbox = new Inbox({
      key: args.key,
      entity: args.entity,
      deps: args.deps,
      // An overflow refusal is recorded the same way any other refusal is, so a stream
      // that has `recordOverflow` on stays uniform.
      record: (refusal) => this.reject(refusal),
      onIdle: args.onIdle ?? noop,
    });

    this.#initial = args.initial;
    this.#initialValues = args.initialValues;
    this.#state = args.initial;
    this.#values = args.initialValues;
    this.#seq = 0;
    this.#enteredAt = args.at;
    this.#bytes = this.#measure();
    this.#stale = false;

    if (args.deps.stack.authority === undefined) {
      // No store, so there is nothing to reconcile with and initialization is settled now.
      const event = this.#initEvent(args.at, args.cause);
      this.#events.push(event);
      // Initialization is a commit, so it fans out like one. Skipping it here would give
      // an audit trail that starts at the second event, and leave a cache layer without
      // the only event that establishes the key exists.
      args.deps.audit(event);
      return;
    }

    this.#pending = {
      initial: args.initial,
      initialValues: args.initialValues,
      at: args.at,
      cause: args.cause,
    };
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

  /** What this instance is accounted at, on the documented basis. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * When this instance entered its current state, on the runtime's clock.
   *
   * Initialization counts as entering the initial state. A commit that only changes values
   * leaves this alone, because the instance has not gone anywhere. This is what temporal
   * constraints and time-in-state queries both measure against.
   */
  get enteredAt(): number {
    return this.#enteredAt;
  }

  /** Whether a temporal constraint has already fired since this state was entered. */
  hasFired(constraint: string): boolean {
    return this.#firedTemporal.has(constraint);
  }

  markFired(constraint: string): void {
    this.#firedTemporal.add(constraint);
  }

  /**
   * Whether this instance can be touched by eviction: no handler running and nothing
   * waiting behind it.
   */
  get idle(): boolean {
    return this.inbox.idle;
  }

  /**
   * Reconcile with the store, if that has not happened yet.
   *
   * Idempotent and safe to await from anywhere: the first caller starts the work and
   * everyone else waits on the same promise. Called from inside the inbox turn, before
   * dispatch, so application code cannot tell a reloaded instance from a resident one.
   */
  ready(): Promise<void> {
    const pending = this.#pending;
    const { authority } = this.#deps.stack;

    if (authority === undefined) {
      return Promise.resolve();
    }

    // A key another writer moved has to be re-read before anything dispatches against it,
    // or the next handler decides on values that are already history. Checked before the
    // pending branch because a record can only be one of the two, and staleness is the
    // one that recurs.
    if (this.#stale) {
      return this.#reload(authority);
    }

    // Answered here rather than inside the work, so `#hydrate` has no branch that only
    // exists to satisfy the compiler and can never run.
    if (pending === undefined) {
      return Promise.resolve();
    }

    this.#hydration ??= this.#hydrate(pending, authority);
    return this.#hydration;
  }

  /**
   * Whether this instance still has to be reconciled with the store.
   *
   * Read before dispatch so a runtime with no store never awaits anything on the way in.
   * That is not a micro-optimization: an extra turn of the event loop before the handler
   * starts changes how telemetry interleaves with `send()` calls, and a memory-only
   * runtime has to behave exactly as it did before stores existed.
   *
   * Two reasons to reconcile, not one: never loaded, and loaded but overtaken. They are the
   * same answer to the caller, which is why this is one question rather than two.
   */
  get needsHydration(): boolean {
    return this.#pending !== undefined || this.#stale;
  }

  /**
   * Resolves once every write this instance has queued has reached the store.
   *
   * Rejections and violations are written without being awaited, so a read of the store
   * taken immediately after one could miss it. Anything reading the durable stream waits
   * on this first, which is cheaper than making every refusal await its own write.
   *
   * Never rejects: the chain it returns is the non-rejecting one, and a failed write has
   * already been reported through `onUnhandled`.
   */
  flushed(): Promise<void> {
    return this.#writes;
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

  /** The picture a store persists so a reload does not replay from the beginning. */
  storeSnapshot(at: number): StoreSnapshot<S, V> {
    return Object.freeze({
      key: this.key,
      entity: this.entity,
      state: this.#state,
      values: this.#values,
      seq: this.#seq,
      enteredAt: this.#enteredAt,
      at,
    });
  }

  /**
   * Issue a commit token for an attempt, bound to this key and to the sequence the
   * attempt is about to observe.
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
   * Apply a handler result: persist it, then advance the sequence and append exactly one
   * transition event.
   *
   * Persist-then-apply, in that order. An event that reached the commit authority is
   * durable, and the in-memory state has to agree with it; applying first and persisting
   * second would leave a window where a crash loses a change the runtime already reported
   * as committed.
   *
   * The apply itself is one synchronous block with no await inside it, which is what makes
   * a commit atomic to any observer reading through the runtime.
   */
  async commit(
    next: {
      state: S;
      values: Readonly<V>;
      at: number;
      cause: EventCause;
    },
    token: CommitToken
  ): Promise<TransitionEvent<S, V>> {
    assertCommittable(token, { key: this.key, seq: this.#seq });
    // From here the attempt owns the outcome: a timeout arriving mid-write must not leave
    // the store holding an event the runtime refused to apply.
    token.seal();

    const event = transitionEvent<S, V>({
      key: this.key,
      from: this.#state,
      to: next.state,
      seq: this.#seq + 1,
      at: next.at,
      cause: next.cause,
      values: next.values,
    });

    try {
      await this.#persist(event, this.#seq);
    } catch (error) {
      // A conflict means somebody else advanced this key, so everything resident about it
      // is now a guess. Marked stale rather than reloaded here: the reload has to happen
      // before the next dispatch, which is where every other reconciliation happens, and
      // doing it inside a failing commit would reload on behalf of an attempt that is
      // already over. Nothing was written, so there is nothing to undo.
      if (isEkmanError(error) && error.code === "STORE_CONFLICT") {
        this.#stale = true;
      }
      throw error;
    }

    // One synchronous block: state, values, sequence and event land together.
    const moved = next.state !== this.#state;
    this.#state = next.state;
    this.#values = next.values;
    this.#seq = event.seq;
    this.#events.push(event);

    if (moved) {
      this.#enteredAt = next.at;
      this.#firedTemporal.clear();
    }

    this.#bytes = this.#measure();
    this.#deps.audit(event);
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
    this.#record(
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

  /**
   * Record a constraint that did not hold.
   *
   * Written under `reject` and under `warn` alike, and like a rejection it carries the
   * current sequence without advancing it. A `warn` violation lands immediately before the
   * commit it did not stop, which is what makes the pair readable in order.
   */
  violation(args: {
    violation: Violation;
    at: number;
    cause: EventCause;
    attempted?: { from: S; to: S };
  }): void {
    this.#record(
      violationEvent<S>({
        key: this.key,
        seq: this.#seq,
        at: args.at,
        cause: args.cause,
        constraint: { kind: args.violation.kind, name: args.violation.name },
        policy: args.violation.policy,
        reason: args.violation.reason,
        ...(args.attempted === undefined ? {} : { attempted: args.attempted }),
      })
    );
  }

  /** Append a non-commit event: into the stream now, towards the store behind it. */
  #record(event: EkmanEvent<S, V>): void {
    this.#events.push(event);
    this.#deps.audit(event);

    // Not awaited. Nothing downstream depends on it, and a caller being refused should not
    // wait on a disk write to be told so. Ordering against the next commit is preserved by
    // the write chain rather than by the caller.
    this.#persist(event, this.#seq).catch(this.#deps.onUnhandled);
  }

  /**
   * Re-read a key another writer moved, and adopt what the store now holds.
   *
   * The half of multi-runtime conflict handling that does not need a store capable of
   * multi-writer appends: a conflict is already surfaced to the caller, and this is what
   * stops the *next* trigger inheriting the stale sequence and conflicting forever.
   *
   * Deliberately not a merge. There is nothing to merge: the refused commit was never
   * written, and the values it was built from are superseded by whatever the other writer
   * committed. The handler for the next trigger gets the winner's state, which is the same
   * thing that would have happened had the two arrived in the other order.
   *
   * A key another writer deleted comes back as gone rather than as its old self, so it
   * re-initializes on the next trigger like any other key nothing holds.
   */
  async #reload(authority: Store): Promise<void> {
    const loaded = await authority.load(this.key);
    const current =
      loaded === undefined
        ? undefined
        : (replay(loaded) as ReplayedState<S, V> | undefined);

    this.#stale = false;

    if (loaded === undefined || current === undefined) {
      // Gone from under us, so this record has to become what a brand-new one would be
      // rather than keeping a state the store has no record of. Initialization is what the
      // next trigger is owed, and it has to land before that trigger dispatches, which is
      // why the hydration runs here rather than being left for a later turn that the
      // caller has already passed.
      this.#state = this.#initial;
      this.#values = this.#initialValues;
      this.#seq = 0;
      this.#bytes = this.#measure();

      const pending: PendingInit<S, V> = {
        initial: this.#initial,
        initialValues: this.#initialValues,
        at: this.#enteredAt,
        cause: RELOAD_CAUSE,
      };
      this.#pending = pending;
      this.#hydration = this.#hydrate(pending, authority);
      await this.#hydration;
      return;
    }

    this.#state = current.state;
    this.#values = current.values;
    this.#seq = current.seq;
    this.#enteredAt = current.enteredAt;
    this.#bytes = this.#measure();

    // Recorded as a restore, because that is what it is: this runtime's view of the key
    // now begins somewhere other than where it thought. Without it, a stream would show a
    // handler deciding against values no earlier event in it accounts for.
    this.#events.push(
      restoredEvent({
        key: this.key,
        seq: current.seq,
        at: current.enteredAt,
        cause: RELOAD_CAUSE,
        from: loaded.snapshot === undefined ? "replay" : "snapshot",
        replayed: loaded.events.length,
      })
    );
  }

  async #hydrate(pending: PendingInit<S, V>, authority: Store): Promise<void> {
    const loaded = await authority.load(this.key);
    // The store contract is untyped in the state and values, because a store holds many
    // entities. The definition this record was built from is what knows their real types.
    const current =
      loaded === undefined
        ? undefined
        : (replay(loaded) as ReplayedState<S, V> | undefined);

    if (loaded === undefined || current === undefined) {
      // Genuinely new. Initialization is a commit at sequence 0, and it has to be durable
      // before anything is dispatched against it.
      const event = this.#initEvent(pending.at, pending.cause);
      await this.#persist(event, EMPTY_SEQ);
      this.#events.push(event);
      this.#deps.audit(event);
      this.#pending = undefined;
      return;
    }

    this.#state = current.state;
    this.#values = current.values;
    this.#seq = current.seq;
    this.#enteredAt = current.enteredAt;
    this.#bytes = this.#measure();

    this.#events.push(
      restoredEvent({
        key: this.key,
        seq: current.seq,
        at: pending.at,
        cause: pending.cause,
        from: loaded.snapshot === undefined ? "replay" : "snapshot",
        replayed: loaded.events.length,
      })
    );

    this.#pending = undefined;
  }

  #initEvent(at: number, cause: EventCause): TransitionEvent<S, V> {
    // The only event whose `from` is null. Recording it is what makes the stream
    // replayable on its own.
    return transitionEvent<S, V>({
      key: this.key,
      from: null,
      to: this.#state,
      seq: 0,
      at,
      cause,
      values: this.#values,
    });
  }

  /**
   * Send one event to the commit authority, in stream order.
   *
   * The returned promise carries this write's real outcome; the chain itself is kept
   * non-rejecting so one failure cannot poison every write queued behind it.
   */
  #persist(event: EkmanEvent<S, V>, expectedSeq: number): Promise<void> {
    const { authority } = this.#deps.stack;
    if (authority === undefined) {
      return Promise.resolve();
    }

    const written = this.#writes.then(() =>
      authority.append(this.key, event as EkmanEvent, expectedSeq)
    );
    this.#writes = written.then(ignore, ignore);
    return written;
  }

  #measure(): number {
    return accountBytes(
      this.key,
      this.#state,
      this.#values,
      this.#deps.memory.sizeOf
    );
  }
}

interface PendingInit<S extends string, V extends Values> {
  readonly initial: S;
  readonly initialValues: Readonly<V>;
  readonly at: number;
  readonly cause: EventCause;
}

/**
 * What a reload is attributed to.
 *
 * A restore has a cause like any other event, and the honest one here is the runtime
 * noticing it was behind, not whichever trigger happened to be next in the inbox.
 */
const RELOAD_CAUSE: EventCause = Object.freeze({
  type: "reload",
  id: "store-conflict",
});

function ignore(): void {
  // Deliberately empty: this exists to keep the write chain from rejecting.
}

function noop(): void {
  // Deliberately empty: the default for a record nobody is watching for idleness.
}

/**
 * Deep-copy and freeze values at the commit boundary.
 *
 * Copying means a handler that keeps a reference to what it returned cannot mutate
 * committed state afterwards. `structuredClone` also enforces the documented contract
 * that values are serializable, and fails loudly here rather than at the first attempt
 * to persist them.
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
