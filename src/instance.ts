import type { Loaded } from "./caches";
import type { RuntimeDeps } from "./config";
import type { Violation } from "./constraints";
import type { ErrorCode } from "./errors";
import { EkmanError, isEkmanError } from "./errors";
import type {
  EkmanEvent,
  EventCause,
  RestoredEvent,
  TransitionEvent,
} from "./events";
import {
  rejectedEvent,
  restoredEvent,
  transitionEvent,
  violationEvent,
} from "./events";
import { assertCommittable, CommitToken, fenceViolation } from "./fence";
import { Inbox } from "./inbox";
import { accountValueBytes, byteLength } from "./memory";
import type { NodeId, States } from "./states";
import type { LoadResult, ReplayedState, Store, StoreSnapshot } from "./store";
import { EMPTY_SEQ, replay } from "./store";
import type { TemporalLatch } from "./temporal";
import type { InstanceSnapshot, Values } from "./types";
import { freezeValues } from "./values";

/**
 * How many of its own events a record keeps in memory.
 *
 * Only reached when nothing else holds the stream. Without a bound, a key that commits for
 * the life of a process grows without limit in a place the memory budget cannot see, since
 * the budget counts values and not history.
 */
export const RESIDENT_HISTORY_LIMIT = 1000;

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

  /** Definite assignment: both are written by `#setState` in the constructor, which is the only writer either of them has, and keeping it that way is the point. */
  #state!: S;
  /**
   * The interned id of `#state`, so an edge check does not derive it on every commit.
   *
   * A second representation of one fact, which is exactly the shape that drifts. It cannot
   * here: `#setState` is the only writer of either, and nothing else assigns `#state`.
   */
  #stateId!: NodeId;
  #values: Readonly<V>;
  #seq: number;
  #enteredAt: number;
  #bytes: number;
  /** UTF-8 length of the key, measured once: it is part of every accounting and never changes. */
  readonly #keyBytes: number;
  /** UTF-8 length of the current state name, re-measured only when the state changes. */
  #stateBytes!: number;
  /**
   * The events this record keeps.
   *
   * With no store this is the only copy of the stream, so everything is kept, up to
   * `RESIDENT_HISTORY_LIMIT`. With a store the stream is read from there, and the only
   * events kept are restores, which are never persisted and have to be woven back into a
   * history read. The array is trimmed in batches, so it may briefly hold up to twice the
   * limit; `events` never returns more than the limit.
   */
  #events: EkmanEvent<S, V>[] = [];
  /** Whether the oldest events have been dropped. Assigned in the constructor, like `#stale`. */
  #historyTrimmed: boolean;
  #lastRestored: RestoredEvent | undefined;
  /** Whether this record is the only holder of its stream, which is so when there is no store. */
  readonly #retainsStream: boolean;
  readonly #deps: RuntimeDeps;
  readonly #states: States;

  /**
   * Temporal constraints that have already fired for the current state.
   *
   * Cleared on every state change, so a constraint fires once per entry rather than on
   * every sweep for as long as the instance sits there. Without this an interval sweep
   * over one stuck instance produces an unbounded stream of identical escalations.
   */
  readonly #firedTemporal = new Set<string>();

  /**
   * Temporal constraints whose escalation was raised and turned away for a reason that
   * passes, by name, with the id of the trigger that was raised.
   *
   * The violation is already in the stream by then, so the retry on a later sweep reuses
   * the id rather than recording a second one, and the commit that finally answers it
   * carries the cause the violation named. Cleared with `#firedTemporal`.
   */
  readonly #undeliveredTemporal = new Map<string, EventCause>();
  #stateEntry = 0;

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
    /** The entity's states, for interning whatever state this record is in. */
    states: States;
    at: number;
    cause: EventCause;
    deps: RuntimeDeps;
    /** Called when this key goes idle, which is when eviction may consider it. */
    onIdle?: () => void;
    /**
     * Load the key if the store holds it, and do not create it if the store does not.
     * For a reader such as a sweep, which must never bring an instance into being.
     */
    loadOnly?: boolean;
  }) {
    this.key = args.key;
    this.entity = args.entity;
    this.#deps = args.deps;
    this.#keyBytes = byteLength(args.key);
    this.#retainsStream = args.deps.stack.authority === undefined;
    this.#historyTrimmed = false;
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
    this.#states = args.states;
    this.#setState(args.initial);
    this.#values = args.initialValues;
    this.#seq = 0;
    this.#enteredAt = args.at;
    this.#bytes = this.#measure();
    this.#stale = false;

    if (args.deps.stack.authority === undefined) {
      // No store, so there is nothing to reconcile with and initialization is settled now.
      const event = this.#initEvent(args.at, args.cause);
      this.#keep(event);
      // Initialization is a commit, so it fans out like one. Skipping it here would give
      // an audit trail that starts at the second event.
      args.deps.audit(event);
      return;
    }

    this.#pending = {
      initial: args.initial,
      initialValues: args.initialValues,
      at: args.at,
      cause: args.cause,
      loadOnly: args.loadOnly === true,
    };
  }

  get state(): S {
    return this.#state;
  }

  /**
   * The interned id of the current state, for a check that would otherwise look it up.
   *
   * `UNKNOWN_NODE` when a store hands back a state the entity no longer declares, which
   * reads as "no edges" wherever it is used, the same answer the name would have produced.
   */
  get stateId(): NodeId {
    return this.#stateId;
  }

  /**
   * The one place the committed state changes.
   *
   * Two fields hold one fact here, and two fields holding one fact drift the moment there
   * are two places that write them. There is one.
   */
  #setState(state: S): void {
    this.#state = state;
    this.#stateId = this.#states.idOf(state);
    this.#stateBytes = byteLength(state);
  }

  get values(): Readonly<V> {
    return this.#values;
  }

  get seq(): number {
    return this.#seq;
  }

  /**
   * The events this record retains, oldest first: the most recent
   * `RESIDENT_HISTORY_LIMIT` of the stream with no store, and restores only with one.
   */
  get events(): readonly EkmanEvent<S, V>[] {
    return this.#events.length > RESIDENT_HISTORY_LIMIT
      ? this.#events.slice(-RESIDENT_HISTORY_LIMIT)
      : this.#events;
  }

  /** Whether events older than the ones retained have been dropped. */
  get historyTrimmed(): boolean {
    return this.#historyTrimmed || this.#events.length > RESIDENT_HISTORY_LIMIT;
  }

  /** The most recent reload of this record from the store, if there has been one. */
  get lastRestored(): RestoredEvent | undefined {
    return this.#lastRestored;
  }

  /**
   * Retain an event, dropping the oldest once there are too many.
   *
   * Dropped a limit's worth at a time rather than one per event, so a key at the limit
   * does not shift a thousand entries on every commit.
   */
  #keep(event: EkmanEvent<S, V>): void {
    this.#events.push(event);
    if (this.#events.length >= RESIDENT_HISTORY_LIMIT * 2) {
      this.#events = this.#events.slice(-RESIDENT_HISTORY_LIMIT);
      this.#historyTrimmed = true;
    }
  }

  #restored(event: RestoredEvent): void {
    this.#lastRestored = event;
    this.#keep(event as EkmanEvent<S, V>);
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

  /**
   * Which entry into its state this record is on. Advances every time the state changes.
   *
   * An escalation is raised for one entry and answered some time later, behind whatever
   * was already queued. If the instance left the state and came back in between, the
   * answer belongs to an entry that is over, and recording it against the current one
   * would silence that entry's own bound. Callers read this before raising an escalation
   * and hand it back when recording the outcome.
   */
  get stateEntry(): number {
    return this.#stateEntry;
  }

  /** Record that a constraint fired, unless the entry it fired for is no longer current. */
  markFired(constraint: string, entry: number): void {
    if (entry !== this.#stateEntry) {
      return;
    }
    this.#firedTemporal.add(constraint);
    this.#undeliveredTemporal.delete(constraint);
  }

  /** The trigger id of an escalation still owed to this constraint, if one was turned away. */
  undelivered(constraint: string): string | undefined {
    return this.#undeliveredTemporal.get(constraint)?.id;
  }

  /** Record an escalation as owed, unless the entry it was raised for is no longer current. */
  markUndelivered(constraint: string, cause: EventCause, entry: number): void {
    if (entry === this.#stateEntry) {
      this.#undeliveredTemporal.set(constraint, cause);
    }
  }

  /**
   * Take up what a store recorded about this stay in a state.
   *
   * Replaces whatever the record held, because the store's stream is the one account of
   * the key that outlives an eviction or a restart.
   */
  #adoptLatch(latch: TemporalLatch | undefined): void {
    this.#firedTemporal.clear();
    this.#undeliveredTemporal.clear();
    for (const name of latch?.fired ?? []) {
      this.#firedTemporal.add(name);
    }
    for (const [name, cause] of Object.entries(latch?.owed ?? {})) {
      this.#undeliveredTemporal.set(name, cause);
    }
  }

  /** What this record's bounds have said about the current stay, or undefined if nothing. */
  #latch(): TemporalLatch | undefined {
    if (
      this.#firedTemporal.size === 0 &&
      this.#undeliveredTemporal.size === 0
    ) {
      return;
    }
    return {
      fired: [...this.#firedTemporal],
      owed: Object.fromEntries(this.#undeliveredTemporal),
    };
  }

  #rearmTemporal(): void {
    this.#stateEntry += 1;
    this.#firedTemporal.clear();
    this.#undeliveredTemporal.clear();
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

    this.#hydration ??= this.#hydrating(pending, authority);
    return this.#hydration;
  }

  /**
   * Start a hydration whose failure is forgotten rather than cached.
   *
   * A failed load is a failed attempt, not a verdict on the key. Kept, the rejection would
   * be handed to every later trigger for the life of the record.
   */
  #hydrating(pending: PendingInit<S, V>, authority: Store): Promise<void> {
    return this.#hydrate(pending, authority).catch((error: unknown) => {
      this.#hydration = undefined;
      throw error;
    });
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
   * Whether this record has never been reconciled with the store at all.
   *
   * Narrower than `needsHydration`: a record another writer overtook is a real instance
   * that is behind, while one that never loaded holds only the entity's initial state.
   */
  get unloaded(): boolean {
    return this.#pending !== undefined;
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
    const temporal = this.#latch();
    return Object.freeze({
      key: this.key,
      entity: this.entity,
      state: this.#state,
      values: this.#values,
      seq: this.#seq,
      enteredAt: this.#enteredAt,
      at,
      ...(temporal === undefined ? {} : { temporal }),
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
   *
   * The new values are measured before anything is written, so values that cannot be
   * serialized refuse the commit. Measured afterwards, they would be applied in memory and
   * then throw on the way out, leaving a commit no sender, audit sink or ledger heard about.
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
    const bytes = this.#measure(
      next.values,
      next.state === this.#state ? this.#stateBytes : byteLength(next.state)
    );
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
        this.#overtaken();
      }
      throw error;
    }

    // One synchronous block: state, values, sequence and event land together.
    const moved = next.state !== this.#state;
    this.#setState(next.state);
    this.#values = next.values;
    this.#seq = event.seq;
    if (this.#retainsStream) {
      this.#keep(event);
    }

    if (moved) {
      this.#enteredAt = next.at;
      this.#rearmTemporal();
    }

    this.#bytes = bytes;
    this.#deps.committed(this, moved);
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
    if (this.#retainsStream) {
      this.#keep(event);
    }
    this.#deps.audit(event);

    // Not awaited. Nothing downstream depends on it, and a caller being refused should not
    // wait on a disk write to be told so. Ordering against the next commit is preserved by
    // the write chain rather than by the caller.
    this.#persist(event, this.#seq).catch((error: unknown) => {
      // Refused as conflicting, so another writer has moved this key, and whatever was
      // just turned away was turned away on a state that is no longer the key's. Nothing
      // else would ever say so: a record that only refuses never tries a commit.
      if (isEkmanError(error) && error.code === "STORE_CONFLICT") {
        this.#overtaken();
      }
      this.#deps.onUnhandled(error, { source: "persist", key: this.key });
    });
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
   * If the other writer moved the instance, what the store holds is a different entry into
   * a state than the one this record was tracking, even when the state name is the same
   * because it left and came back. Temporal constraints are re-armed then, so nothing that
   * fired or was owed for the old entry carries over. A change to values alone keeps the
   * entry, and keeps them.
   *
   * A key another writer deleted comes back as gone rather than as its old self, so it
   * re-initializes on the next trigger like any other key nothing holds. That is a new
   * life: it enters the initial state now, and no temporal constraint that fired in the
   * deleted one counts as fired.
   */
  async #reload(authority: Store): Promise<void> {
    const loaded = await authority.load(this.key);
    const current =
      loaded === undefined
        ? undefined
        : (replay(loaded) as ReplayedState<S, V> | undefined);
    if (current !== undefined && this.#deps.caches.any) {
      this.#deps.caches.refill(this.key, current);
    }

    this.#stale = false;

    if (loaded === undefined || current === undefined) {
      // Gone from under us, so this record has to become what a brand-new one would be
      // rather than keeping a state the store has no record of. Initialization is what the
      // next trigger is owed, and it has to land before that trigger dispatches, which is
      // why the hydration runs here rather than being left for a later turn that the
      // caller has already passed.
      this.#setState(this.#initial);
      this.#values = this.#initialValues;
      this.#seq = 0;
      this.#bytes = this.#measure();

      this.#enteredAt = this.#deps.now();
      this.#rearmTemporal();

      const pending: PendingInit<S, V> = {
        initial: this.#initial,
        initialValues: this.#initialValues,
        at: this.#enteredAt,
        cause: RELOAD_CAUSE,
        loadOnly: false,
      };
      this.#pending = pending;
      this.#hydration = this.#hydrating(pending, authority);
      await this.#hydration;
      return;
    }

    if (
      current.state !== this.#state ||
      current.enteredAt !== this.#enteredAt
    ) {
      this.#rearmTemporal();
      this.#adoptLatch(current.temporal);
    }

    this.#setState(current.state);
    this.#values = freezeValues(current.values);
    this.#seq = current.seq;
    this.#enteredAt = current.enteredAt;
    this.#bytes = this.#measure();

    // Recorded as a restore, because that is what it is: this runtime's view of the key
    // now begins somewhere other than where it thought. Without it, a stream would show a
    // handler deciding against values no earlier event in it accounts for.
    this.#restored(
      restoredEvent({
        key: this.key,
        seq: current.seq,
        at: current.enteredAt,
        cause: RELOAD_CAUSE,
        from: loaded.snapshot === undefined ? "replay" : "snapshot",
        replayed: replayedCount(loaded),
      })
    );
  }

  async #hydrate(pending: PendingInit<S, V>, authority: Store): Promise<void> {
    const found = await this.#load(pending, authority);
    const { loaded } = found;
    // The store contract is untyped in the state and values, because a store holds many
    // entities. The definition this record was built from is what knows their real types.
    const current = found.current as ReplayedState<S, V> | undefined;

    if (loaded === undefined || current === undefined) {
      if (pending.loadOnly && this.inbox.idle) {
        // Nothing stored and nobody waiting to send, so there is no instance to make. The
        // record stays unloaded for its creator to release. Should a trigger arrive
        // first, it starts over and initializes the key as it would any other.
        this.#pending = { ...pending, loadOnly: false };
        this.#hydration = undefined;
        return;
      }

      // Genuinely new. Initialization is a commit at sequence 0, and it has to be durable
      // before anything is dispatched against it.
      const event = this.#initEvent(pending.at, pending.cause);
      try {
        await this.#persist(event, EMPTY_SEQ);
      } catch (error) {
        if (isEkmanError(error) && error.code === "STORE_CONFLICT") {
          this.#overtaken();
          this.#pending = undefined;
        }
        throw error;
      }
      this.#deps.audit(event);
      this.#pending = undefined;
      return;
    }

    this.#setState(current.state);
    this.#values = freezeValues(current.values);
    this.#seq = current.seq;
    this.#enteredAt = current.enteredAt;
    this.#bytes = this.#measure();
    this.#adoptLatch(current.temporal);

    this.#restored(
      restoredEvent({
        key: this.key,
        seq: current.seq,
        at: pending.at,
        cause: pending.cause,
        from: loaded.snapshot === undefined ? "replay" : "snapshot",
        replayed: replayedCount(loaded),
      })
    );

    this.#pending = undefined;
  }

  /**
   * Read this key for a record that has never been reconciled.
   *
   * A first load may be answered by a cache layer. A load that follows a conflict may
   * not: it happens because another writer moved the key, and a cache is exactly what
   * would not know. With no cache layers the authority is asked directly, so a runtime
   * without them takes no extra turn on the way in.
   */
  async #load(pending: PendingInit<S, V>, authority: Store): Promise<Loaded> {
    const { caches } = this.#deps;
    if (caches.any && pending.cause !== RELOAD_CAUSE) {
      return caches.read(this.key, () => authority.load(this.key));
    }

    const loaded = await authority.load(this.key);
    return {
      loaded,
      current: loaded === undefined ? undefined : replay(loaded),
    };
  }

  /**
   * Note that another writer has moved this key.
   *
   * Whatever a cache layer holds for it is suspect from here, and may be what misled this
   * record in the first place, so the key is cleared from them.
   */
  #overtaken(): void {
    this.#stale = true;
    if (this.#deps.caches.any) {
      this.#deps.caches.drop(this.key, this.#seq);
    }
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
   * Send one event to the commit authority, in stream order, and on to the cache layers
   * once the authority has it.
   *
   * The returned promise carries this write's real outcome; the chain itself is kept
   * non-rejecting so one failure cannot poison every write queued behind it. The caches
   * are handed the event from the same chain, so they see events in stream order, and on
   * a chain of their own, so nothing here waits for them.
   */
  #persist(event: EkmanEvent<S, V>, expectedSeq: number): Promise<void> {
    const { authority } = this.#deps.stack;
    if (authority === undefined) {
      return Promise.resolve();
    }

    const written = this.#writes.then(() =>
      authority.append(this.key, event as EkmanEvent, expectedSeq)
    );
    const { caches } = this.#deps;
    if (caches.any) {
      written.then(() => caches.mirror(event as EkmanEvent), ignore);
    }
    this.#writes = written.then(ignore, ignore);
    return written;
  }

  /**
   * What this instance is accounted at, for the values and state given or the ones it has.
   *
   * Values it cannot serialize are refused with a code. A `BigInt` passes structured clone
   * and fails here, and left bare that failure would reach the sender as a `TypeError`
   * naming nothing.
   */
  #measure(
    values: Values = this.#values,
    stateBytes: number = this.#stateBytes
  ): number {
    try {
      return (
        this.#keyBytes +
        stateBytes +
        accountValueBytes(values, this.#deps.memory.sizeOf)
      );
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: EkmanError takes `cause` in its options bag and forwards it to the Error constructor
      throw new EkmanError(
        "HANDLER_FAILED",
        `values committed for ${this.key} cannot be serialized to JSON: ` +
          `${(cause as Error).message}. Values must be plain JSON data.`,
        { key: this.key, cause }
      );
    }
  }
}

interface PendingInit<S extends string, V extends Values> {
  readonly initial: S;
  readonly initialValues: Readonly<V>;
  readonly at: number;
  readonly cause: EventCause;
  /** Whether a key the store does not hold is left alone rather than initialized. */
  readonly loadOnly: boolean;
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

/**
 * How many events a load replayed on top of its snapshot.
 *
 * A refusal or a violation at the snapshot's own sequence comes back with the load and
 * is not counted: nothing is rebuilt from it.
 */
function replayedCount(loaded: LoadResult): number {
  const { snapshot, events } = loaded;
  if (snapshot === undefined) {
    return events.length;
  }
  return events.filter((event) => event.seq > snapshot.seq).length;
}

function ignore(): void {
  // Deliberately empty: this exists to keep the write chain from rejecting.
}

function noop(): void {
  // Deliberately empty: the default for a record nobody is watching for idleness.
}
