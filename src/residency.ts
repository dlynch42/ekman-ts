import { statesOf } from "./compiled";
import type { CommittedRecord, RuntimeDeps } from "./config";
import { EkmanError } from "./errors";
import type { EventCause } from "./events";
import { InstanceRecord } from "./instance";
import { MemoryLedger } from "./memory";
import { telemetryNow } from "./telemetry";
import { TemporalIndex } from "./temporal";
import type { EntityDefinition } from "./types";

// biome-ignore-start lint/suspicious/noExplicitAny: the runtime holds instances and
// definitions of many entity shapes at once. `unknown` is not assignable across the
// contravariant handler positions these feed, so `any` is the only escape that keeps
// the heterogeneous registry typable. Every public surface re-narrows.
export type AnyInstance = InstanceRecord<any, any>;
export type AnyDefinition = EntityDefinition<string, any, any, any>;
// biome-ignore-end lint/suspicious/noExplicitAny: see above

/**
 * What is in memory: the resident instances, what they cost, and where each one sits.
 *
 * Three structures hold that, and they have to agree: the table of records by key, the
 * ledger of bytes in least-recently-used order, and the index of keys by entity and state
 * that the sweep and the queries read. Every operation that touches one of them is here,
 * so nothing outside this class can leave a key in one and not in another.
 *
 * It decides nothing about the truth. Whether an instance is preserved before it is
 * released, or destroyed after, belongs to whoever asked: eviction snapshots first, and
 * forgetting deletes afterwards.
 */
export class Residency {
  readonly #deps: RuntimeDeps;
  readonly #instances = new Map<string, AnyInstance>();
  /** What is resident and what it costs, in least-recently-used order. */
  readonly #ledger = new MemoryLedger();
  /** Where every resident instance sits. Read by temporal constraints and by queries. */
  readonly #index = new TemporalIndex();
  /** Eviction snapshots still on their way to the store, by key. Empty when none are. */
  readonly #snapshotting = new Map<string, Promise<unknown>>();

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
  }

  /** The record held for a key, loaded or not. */
  get(key: string): AnyInstance | undefined {
    return this.#instances.get(key);
  }

  /** Whether this exact record is the one held for its key, and has something loaded. */
  holds(instance: AnyInstance): boolean {
    return !instance.unloaded && this.#instances.get(instance.key) === instance;
  }

  /** Keys of every resident instance. */
  keys(): IterableIterator<string> {
    return this.#instances.keys();
  }

  /** Every record held. */
  instances(): IterableIterator<AnyInstance> {
    return this.#instances.values();
  }

  /** The resident keys of an entity that sit in a state. */
  keysIn(entity: string, state: string): readonly string[] {
    return this.#index.keys(entity, state);
  }

  /** The states of an entity that some resident instance sits in. */
  statesIn(entity: string): readonly string[] {
    return this.#index.states(entity);
  }

  /** Resident bytes on the documented accounting basis, and what the budget allows. */
  get usage(): {
    readonly bytes: number;
    readonly instances: number;
    readonly maxBytes: number | null;
  } {
    const { memory } = this.#deps;
    return Object.freeze({
      bytes: this.#ledger.total,
      instances: this.#ledger.size,
      maxBytes: memory.bounded ? memory.maxBytes : null,
    });
  }

  /** Resident bytes, without the rest of `usage`. */
  get bytes(): number {
    return this.#ledger.total;
  }

  /** An eviction snapshot for this key still on its way to the store, if one is. */
  snapshotting(key: string): Promise<unknown> | undefined {
    return this.#snapshotting.get(key);
  }

  /**
   * How long a resident key has been in a state, or undefined if it is not there.
   *
   * The single place time-in-state is measured. A temporal constraint asks with a bound
   * per constraint; a query asks with one bound for everything. Two implementations of the
   * same question is how the two answers start disagreeing, so there is one.
   *
   * The state guard costs nothing and means a future indexing bug degrades into a missed
   * escalation rather than one aimed at the wrong state.
   */
  ageOf(
    key: string,
    state: string,
    at: number
  ): { instance: AnyInstance; elapsedMs: number } | undefined {
    const instance = this.#instances.get(key);
    if (
      instance === undefined ||
      instance.state !== state ||
      instance.needsHydration
    ) {
      return;
    }
    return { instance, elapsedMs: at - instance.enteredAt };
  }

  /**
   * Load or lazily initialize the instance. Initialization is a commit at sequence 0.
   *
   * `loadOnly` is for a reader that must not create what it is looking for: the record
   * loads the key if the store holds it and is left unloaded if the store does not.
   */
  materialize(
    key: string,
    definition: AnyDefinition,
    cause: EventCause,
    loadOnly = false
  ): AnyInstance {
    const existing = this.#instances.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const { memory } = this.#deps;
    // Under `reject` the budget bounds how much a producer can materialize, which is what
    // stops a stream of unknown keys from becoming unbounded resident state. Existing
    // instances are untouched: shedding new work beats disturbing work in progress.
    if (memory.policy === "reject" && this.#ledger.total >= memory.maxBytes) {
      this.#deps.emit({
        type: "memory.refused",
        key,
        entity: definition.name,
        residentBytes: this.#ledger.total,
        maxBytes: memory.maxBytes,
        at: telemetryNow(),
      });

      throw new EkmanError(
        "MEMORY_EXHAUSTED",
        `the resident memory budget of ${memory.maxBytes} bytes is full ` +
          `(${this.#ledger.total} bytes across ${this.#ledger.size} instances), and the ` +
          'eviction policy is "reject", so no further instance can be materialized.',
        { key }
      );
    }

    const instance = new InstanceRecord({
      key,
      entity: definition.name,
      initial: definition.initial,
      initialValues: definition.initialValues,
      states: statesOf(definition),
      at: this.#deps.now(),
      cause,
      deps: this.#deps,
      onIdle: () => this.offer(instance),
      loadOnly,
    });

    this.#instances.set(key, instance);
    this.#ledger.record(key, instance.bytes);

    if (!instance.needsHydration) {
      this.#index.enter(key, definition.name, definition.initial);
    }
    return instance;
  }

  /**
   * Keep the ledger and the index in step with a commit a record has just applied.
   *
   * Only a move re-indexes: a commit that changed values alone leaves the instance where it
   * was, and its time in state keeps running.
   */
  committed(record: CommittedRecord, moved: boolean): void {
    if (moved) {
      this.#index.enter(record.key, record.entity, record.state);
    }
    this.#ledger.record(record.key, record.bytes);
  }

  /** Account for and index a record that has just been loaded from the store. */
  loaded(instance: AnyInstance): void {
    this.#ledger.record(instance.key, instance.bytes);
    this.#index.enter(instance.key, instance.entity, instance.state);
  }

  /**
   * Report what an instance costs against the budget, once its trigger has settled.
   *
   * The ledger itself was updated when the commit was applied, in `committed`. This is
   * the telemetry for it, emitted after the dispatch so it follows `handler.settled`.
   */
  account(instance: AnyInstance): void {
    const { memory } = this.#deps;
    const overBudget = this.#ledger.total > memory.maxBytes;

    this.#deps.emit({
      type: "memory.accounted",
      key: instance.key,
      entity: instance.entity,
      bytes: instance.bytes,
      residentBytes: this.#ledger.total,
      residentCount: this.#ledger.size,
      maxBytes: memory.bounded ? memory.maxBytes : null,
      overBudget,
      at: telemetryNow(),
    });
  }

  /**
   * A key just went idle, which is the first moment eviction is allowed to consider it.
   *
   * Deliberately not at commit. A commit happens inside the key's turn, when the key is by
   * definition busy, so an instance could never evict itself however cold and however far
   * over budget the runtime was. `maxBytes: 0` would have quietly meant "keep everything".
   */
  offer(instance: AnyInstance): void {
    if (instance.unloaded && this.#instances.get(instance.key) === instance) {
      this.release(instance);
    }

    const { memory } = this.#deps;
    if (memory.policy === "lru" && this.#ledger.total > memory.maxBytes) {
      this.#evictToFit();
    }
  }

  /**
   * Release an idle instance to make room, snapshotting it first when a store exists.
   *
   * A record another writer has overtaken is released without a snapshot: its view is
   * known to be behind the store, and the store is where the next load reads from.
   */
  evict(instance: AnyInstance): void {
    const { authority } = this.#deps.stack;
    // Gated on a store existing, not on it being durable. Snapshotting into an ephemeral
    // store is worth doing: it is exactly what the next in-process reload reads.
    const snapshotted =
      this.#deps.memory.snapshotOnEvict &&
      authority !== undefined &&
      !instance.needsHydration;

    if (snapshotted) {
      const { key } = instance;
      // Not awaited: the snapshot is an optimization for the next load, and the events it
      // summarizes are already in the store. A failed snapshot costs replay time, never
      // state.
      this.#snapshotted(
        key,
        authority
          .snapshot(key, instance.storeSnapshot(this.#deps.now()))
          .catch((error: unknown) =>
            this.#deps.onUnhandled(error, { source: "snapshot", key })
          )
      );
    }

    const bytes = this.release(instance);

    this.#deps.emit({
      type: "instance.evicted",
      key: instance.key,
      entity: instance.entity,
      state: instance.state,
      seq: instance.seq,
      bytes,
      snapshotted,
      residentBytes: this.#ledger.total,
      at: telemetryNow(),
    });
  }

  /**
   * Stop holding an instance in memory, and report what that freed.
   *
   * Only the memory side. Whether the truth is preserved first, or destroyed after, is the
   * caller's business: eviction snapshots, forgetting deletes, and the three structures
   * that have to stay in step are the same either way.
   */
  release(instance: AnyInstance): number {
    const bytes = this.#ledger.release(instance.key);
    this.#instances.delete(instance.key);
    this.#index.remove(instance.key);
    return bytes;
  }

  /**
   * Release least-recently-used idle instances until the budget is satisfied.
   *
   * Idle only, always. An instance with a handler running or a trigger waiting is holding
   * work that would be lost, so it is skipped no matter how cold it is, and the budget goes
   * over rather than a commit going missing.
   */
  #evictToFit(): void {
    for (const key of this.#ledger.lruKeys()) {
      if (this.#ledger.total <= this.#deps.memory.maxBytes) {
        return;
      }

      const instance = this.#instances.get(key);
      if (instance === undefined || !instance.idle) {
        continue;
      }

      this.evict(instance);
    }
  }

  /**
   * Remember an eviction snapshot until the store has it.
   *
   * Nobody waits for it but `forget`. A store holds a key that is only a snapshot, so one
   * that landed after the key was deleted would bring the key back.
   */
  #snapshotted(key: string, written: Promise<unknown>): void {
    const pending = Promise.all([this.#snapshotting.get(key), written]);
    this.#snapshotting.set(key, pending);
    pending.then(() => {
      if (this.#snapshotting.get(key) === pending) {
        this.#snapshotting.delete(key);
      }
    });
  }
}
