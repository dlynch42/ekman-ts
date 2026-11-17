import type { AuditSink } from "./audit";
import { assertAuditSink, deliverTo } from "./audit";
import { Caches } from "./caches";
import type { CommittedRecord, RuntimeDeps } from "./config";
import { assertKnownKeys, resolveInboxConfig } from "./config";
import type { CompiledTemporal } from "./constraints";
import type { DispatchDeps } from "./dispatch";
import { dispatch } from "./dispatch";
import { EkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import { InstanceRecord } from "./instance";
import { parseKey } from "./key";
import type { ResolvedMemoryConfig } from "./memory";
import { MemoryLedger, resolveMemoryConfig } from "./memory";
import { assertPolicyKeys, MAX_TIMER_MS, resolvePolicy } from "./policy";
import type {
  HistoryResult,
  Partiality,
  QueryCriteria,
  QueryMatch,
  QueryResult,
} from "./query";
import { mergeRestores, parseDuration } from "./query";
import type { ResolvedStack } from "./stack";
import { assertCoordination, resolveStack } from "./stack";
import type { StorageSweep, Store } from "./store";
import { EMPTY_SEQ } from "./store";
import type { TelemetryEvent } from "./telemetry";
import {
  emit,
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_FALLBACK,
  telemetryNow,
} from "./telemetry";
import type { EscalationOutcome } from "./temporal";
import { refusalOutcome, TemporalIndex } from "./temporal";
import type {
  AnyEntityDefinition,
  CommitResult,
  EkmanConfig,
  EntityDefinition,
  EntityHandle,
  EntityHandles,
  InstanceSnapshot,
  Trigger,
  TriggerLike,
  Values,
} from "./types";

// biome-ignore-start lint/suspicious/noExplicitAny: the runtime holds instances and
// definitions of many entity shapes at once. `unknown` is not assignable across the
// contravariant handler positions these feed, so `any` is the only escape that keeps
// the heterogeneous registry typable. Every public surface re-narrows.
type AnyInstance = InstanceRecord<any, any>;
type AnyDefinition = EntityDefinition<string, any, any, any>;
// biome-ignore-end lint/suspicious/noExplicitAny: see above

/**
 * An embedded Ekman runtime.
 *
 * Holds the registered entities, the resident instances, and the per-key serializer that
 * keeps at most one handler running per key.
 *
 * ```ts
 * const ekman = new Ekman({ entities: [deployments] })
 * await ekman.entities.deployments.send("abc123", { type: "start" })
 * ```
 */
export class Ekman<D extends readonly AnyEntityDefinition[] = []> {
  /**
   * Runtime-bound handles, keyed by entity name and typed from the constructor's
   * `entities`. Entities added later with `define()` are returned from that call rather
   * than appearing here, because a type cannot grow at runtime.
   */
  readonly entities: EntityHandles<D>;

  readonly #definitions = new Map<string, AnyDefinition>();
  readonly #instances = new Map<string, AnyInstance>();
  readonly #now: () => number;
  readonly #onUnhandled: (error: unknown) => void;
  readonly #runtime: RuntimeDeps;
  readonly #deps: DispatchDeps;
  /** Where every resident instance sits. Read by temporal constraints and by queries. */
  readonly #temporal = new TemporalIndex();
  readonly #stack: ResolvedStack;
  readonly #caches: Caches;
  readonly #memory: ResolvedMemoryConfig;
  readonly #audit: readonly AuditSink[];
  /** What is resident and what it costs, in least-recently-used order. */
  readonly #ledger = new MemoryLedger();
  /** Deletions still in progress, by key. A new record for the key waits on its entry before loading. */
  readonly #forgetting = new Map<string, Promise<void>>();
  /** Eviction snapshots still on their way to the store, by key. Empty when none are. */
  readonly #snapshotting = new Map<string, Promise<unknown>>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #storageSweepTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Declared here and assigned in the constructor rather than initialized inline. An
   * inline `= false` narrows the field to the literal `false`, after which the re-entry
   * guard that reads it looks statically dead. The inbox's `#running` carries the same
   * note for the same reason.
   */
  #sweeping: boolean;
  /** Same reasoning as `#sweeping`, for the storage pass. */
  #sweepingStorage: boolean;
  /** Aborted when `close()` begins. From then on no trigger is accepted and no retry starts. */
  readonly #closing = new AbortController();
  /** The one shutdown every `close()` call shares. */
  #closed: Promise<void> | undefined;
  /** A storage sweep in progress, settled either way, for a shutdown to wait on. */
  #storageSweep: Promise<void> | undefined;
  #triggerSeq = 0;

  constructor(config: EkmanConfig<D> = {}) {
    assertRuntimeConfig(config);
    this.#now = config.now ?? Date.now;
    this.#onUnhandled = config.onUnhandled ?? defaultOnUnhandled;
    this.#sweeping = false;
    this.#sweepingStorage = false;

    // Everything is resolved here, at construction, so a configuration the stores cannot
    // satisfy fails at startup rather than being discovered under load. A runtime that
    // cannot keep its promises should refuse to start rather than quietly keep fewer.
    this.#stack = resolveStack(config.store);
    assertCoordination(this.#stack, config.coordination);
    this.#memory = resolveMemoryConfig(config.memory, {
      hasStore: this.#stack.authority !== undefined,
    });
    this.#audit = config.audit ?? [];
    for (const sink of this.#audit) {
      assertAuditSink(sink);
    }

    this.#caches = new Caches(this.#stack.caches, {
      now: () => this.#now(),
      failed: (failure) =>
        this.#emit({
          type: "store.cacheFailed",
          key: failure.key,
          entity: parseKey(failure.key).entity,
          store: failure.store,
          error: failure.error,
          seq: failure.seq,
          at: telemetryNow(),
        }),
    });

    this.#runtime = {
      now: () => this.#now(),
      telemetry: config.telemetry,
      onUnhandled: (error) => this.#onUnhandled(error),
      inbox: resolveInboxConfig(config.inbox),
      stack: this.#stack,
      caches: this.#caches,
      memory: this.#memory,
      audit: (event) => this.#fanOut(event),
      committed: (record, moved) => this.#committed(record, moved),
    };

    this.#deps = {
      now: () => this.#now(),
      policy: config.execution,
      emit: (event) => this.#emit(event),
      reconcile: (instance) => this.#hydrate(instance as AnyInstance),
      closing: this.#closing.signal,
    };

    const handles: Record<string, EntityHandle> = {};
    for (const definition of config.entities ?? []) {
      handles[definition.name] = this.#register(definition);
    }
    this.entities = Object.freeze(handles) as EntityHandles<D>;

    this.#startSweeping(config.temporal?.sweepMs);
    this.#startStorageSweeping(config.storage?.sweepMs);
  }

  /**
   * Register an entity after construction and get its handle.
   *
   * Safe while the runtime is dispatching: it only adds to the registry, so no in-flight
   * handler is affected.
   */
  define<
    N extends string,
    S extends string,
    V extends Values,
    T extends TriggerLike,
  >(definition: EntityDefinition<N, S, V, T>): EntityHandle<S, V, T> {
    // The registry is heterogeneous, so the handle comes back erased. The definition's
    // own type parameters are the truth here.
    return this.#register(definition) as unknown as EntityHandle<S, V, T>;
  }

  /** Every registered entity name, in registration order. */
  get entityNames(): readonly string[] {
    return [...this.#definitions.keys()];
  }

  /**
   * The definition registered under an entity name, or an `UNKNOWN_ENTITY` refusal.
   *
   * Everything that takes a key or an entity name from a caller goes through this before
   * it reaches a store, so a name nobody registered is never looked up, listed or deleted
   * on disk.
   *
   * @param entity the name to resolve
   * @param key the key that named it, when one did, for the error
   */
  #definitionFor(entity: string, key?: string): AnyDefinition {
    const definition = this.#definitions.get(entity);
    if (definition === undefined) {
      const subject =
        key === undefined ? "the query" : `key ${JSON.stringify(key)}`;
      throw new EkmanError(
        "UNKNOWN_ENTITY",
        `${subject} names entity ${JSON.stringify(entity)}, which is not registered. ` +
          `Registered: ${this.entityNames.join(", ") || "(none)"}`,
        key === undefined ? {} : { key }
      );
    }
    return definition;
  }

  /**
   * Deliver a trigger to the instance at `key`.
   *
   * Resolves at commit with the committed state, values and sequence. Rejects with an
   * `EkmanError` if the key is malformed, the entity is unregistered, the trigger is
   * refused, the handler fails, or the runtime has been closed.
   */
  async send<S extends string = string, V extends Values = Values>(
    key: string,
    trigger: Trigger
  ): Promise<CommitResult<S, V>> {
    if (this.#closing.signal.aborted) {
      throw new EkmanError(
        "RUNTIME_CLOSED",
        `the runtime is closed, so ${JSON.stringify(key)} cannot accept a trigger`,
        { key }
      );
    }

    const definition = this.#definitionFor(parseKey(key).entity, key);

    const normalized = this.#normalizeTrigger(trigger, key);
    const instance = this.#resolveInstance(key, definition, normalized);

    return (await this.#enqueue(
      instance,
      definition,
      normalized
    )) as CommitResult<S, V>;
  }

  /**
   * Fire and forget. Wraps `send`.
   *
   * A failure here has no caller to reject, so it goes to `onUnhandled` rather than
   * disappearing. Silence is the one thing this runtime should never do.
   */
  post(key: string, trigger: Trigger): void {
    this.send(key, trigger).catch(this.#onUnhandled);
  }

  /** Current committed state, or undefined if nothing has addressed this key yet. */
  inspect<S extends string = string, V extends Values = Values>(
    key: string
  ): InstanceSnapshot<S, V> | undefined {
    const instance = this.#instances.get(parseKey(key).key);
    if (instance === undefined || instance.needsHydration) {
      return;
    }
    return instance.snapshot() as InstanceSnapshot<S, V>;
  }

  /**
   * The per-key ordered event stream: transitions, refusals, violations and restores.
   *
   * Reads through the commit authority when one is configured, so it covers the instance's
   * whole life and not only what this process happened to see. With no store it answers
   * from what is resident, and says so: `complete` is false and `reasons` explains why.
   */
  /**
   * Delete an instance outright: its resident state and its stream in every layer.
   *
   * This destroys committed state, which is the one thing the rest of the runtime works to
   * avoid, so it happens only when asked for by key and never as a side effect of anything
   * else. Retention is built out of this plus `query`, and the policy of when to call it
   * stays with the application.
   *
   * Refused with `KEY_BUSY` while a handler is in flight. A commit landing into a key that
   * had just been deleted would resurrect it at a sequence nothing accounts for, and the
   * fence cannot help: an attempt already writing has sealed its token. Refusing is the
   * honest answer, and a caller that wants to wait can retry. Idle is enough to know: the
   * inbox starts draining synchronously when it accepts, so an idle instance has nothing
   * queued and nothing in flight.
   *
   * Forgetting a key that was never here is not an error, so a sweep that dies halfway
   * behaves the same way when it is run again.
   *
   * The record leaves the table before the delete is awaited, and a record created for the
   * same key meanwhile waits for the delete before it loads. Otherwise it would restore the
   * stream being removed and commit on top of it, and that commit would then be deleted.
   * What that record waits on never rejects, since a failed delete is this caller's to hear.
   *
   * The delete itself waits for the record's queued writes, because a refusal written
   * without being awaited would otherwise land afterwards and recreate the stream. It then
   * clears every layer, not only the authority: a cache still holding the stream would
   * serve it back on the next load. A cache that cannot be cleared fails the call, and is
   * not read or written for the key again until a later forget of it succeeds.
   */
  async forget(key: string): Promise<void> {
    if (this.#closing.signal.aborted) {
      throw new EkmanError(
        "RUNTIME_CLOSED",
        `the runtime is closed, so ${JSON.stringify(key)} cannot be forgotten`,
        { key }
      );
    }

    const { key: parsed, entity } = parseKey(key);
    this.#definitionFor(entity, key);
    const instance = this.#instances.get(parsed);

    // Checked before anything is deleted, so a store that cannot delete leaves the runtime
    // exactly as it was rather than half-forgotten.
    for (const layer of this.#stack.layers) {
      if (!(layer.capabilities.forget && layer.forget)) {
        throw new EkmanError(
          "NOT_IMPLEMENTED",
          `store layer "${layer.name}" cannot delete a key, so ${JSON.stringify(parsed)} ` +
            "cannot be forgotten. Removing it from the other layers would leave this one " +
            "holding a stream that would come back on the next load."
        );
      }
    }

    if (instance !== undefined && !instance.idle) {
      throw new EkmanError(
        "KEY_BUSY",
        `${JSON.stringify(parsed)} has a handler in flight, so it was not forgotten. ` +
          "Deleting it now would leave that attempt committing into a key that no " +
          "longer exists. Retry once it is idle.",
        { key: parsed }
      );
    }

    const bytes = instance === undefined ? 0 : this.#release(instance);

    const deleting = (this.#forgetting.get(parsed) ?? Promise.resolve()).then(
      async () => {
        await instance?.flushed();
        await this.#snapshotting.get(parsed);

        await allSettledOrThrow([
          this.#caches.forget(parsed),
          this.#stack.authority?.forget?.(parsed),
        ]);
      }
    );

    const settled = deleting.then(noop, noop);
    this.#forgetting.set(parsed, settled);
    try {
      await deleting;
    } finally {
      if (this.#forgetting.get(parsed) === settled) {
        this.#forgetting.delete(parsed);
      }
    }

    this.#emit({
      type: "instance.forgotten",
      key: parsed,
      entity: parseKey(parsed).entity,
      state: instance?.state ?? "",
      seq: instance?.seq ?? EMPTY_SEQ,
      bytes,
      resident: instance !== undefined,
      residentBytes: this.#ledger.total,
      at: telemetryNow(),
    });
  }

  async history<S extends string = string, V extends Values = Values>(
    key: string
  ): Promise<HistoryResult<S, V>> {
    const { key: parsed, entity } = parseKey(key);
    this.#definitionFor(entity, key);
    const instance = this.#instances.get(parsed);
    const { authority } = this.#stack;

    if (authority === undefined) {
      return Object.freeze({
        key: parsed,
        events: (instance?.events ?? []) as readonly EkmanEvent<S, V>[],
        complete: false,
        reasons:
          instance?.historyTrimmed === true
            ? CAPPED_IN_MEMORY
            : NO_DURABLE_STORE,
        sources: RESIDENT_ONLY,
      });
    }

    // Refusals and violations are written without being awaited, so without this a read
    // taken immediately after one could miss it and report a stream with a hole in it.
    await instance?.flushed();

    const stored = (await authority.read(parsed)) as readonly EkmanEvent<
      S,
      V
    >[];

    const compacted = await this.#wasCompacted(parsed, stored, authority);

    return Object.freeze({
      key: parsed,
      // Restores are never persisted, so they are woven back in here. Without that, a
      // stream read after a reload would give no sign that anything was reloaded.
      events: mergeRestores(
        stored,
        (instance?.events ?? []) as readonly EkmanEvent<S, V>[]
      ),
      complete: this.#stack.durable && !compacted,
      reasons: partiality(this.#stack.durable, compacted),
      sources: Object.freeze([authority.name, "resident"]),
    });
  }

  /**
   * Find instances by state and by how long they have been in it.
   *
   * "Everything stuck in `deploying` for more than five minutes" is the question this
   * exists for. Resident instances and stored ones are unioned, with the resident view
   * winning on any key that appears in both, because it is the more current of the two.
   *
   * The answer always says whether it is complete. A memory-only runtime can only report
   * what it retains, and reporting that as if it were everything is the one thing a query
   * must never do.
   */
  async query(criteria: QueryCriteria): Promise<QueryResult> {
    this.#definitionFor(criteria.entity);
    const { limit } = criteria;
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `a query's limit must be a non-negative integer, received ${JSON.stringify(limit)}. ` +
          "Omit it to ask for every match."
      );
    }
    const at = this.#now();
    const olderThanMs =
      criteria.olderThan === undefined
        ? undefined
        : parseDuration(criteria.olderThan);

    const reasons = new Set<Partiality>();
    const sources = ["resident"];
    const matches = new Map<string, QueryMatch>();

    for (const match of this.#residentMatches(criteria, olderThanMs, at)) {
      matches.set(match.key, match);
    }

    const { authority } = this.#stack;
    if (authority === undefined) {
      reasons.add("no-durable-store");
    } else {
      sources.push(authority.name);
      await this.#scanInto(
        matches,
        authority,
        criteria,
        olderThanMs,
        at,
        reasons
      );
      if (!this.#stack.durable) {
        reasons.add("no-durable-store");
      }
    }

    // Applied after the union, so a limit cannot silently prefer resident instances over
    // stored ones or the other way round.
    const truncated = limit !== undefined && limit < matches.size;
    const instances = truncated
      ? oldest(matches.values(), limit)
      : [...matches.values()].sort(byAgeThenKey);

    if (truncated) {
      reasons.add("limit-reached");
    }

    return Object.freeze({
      instances: Object.freeze(instances),
      complete: reasons.size === 0,
      reasons: Object.freeze([...reasons]),
      sources: Object.freeze(sources),
    });
  }

  /** Keys of every resident instance. */
  get residentKeys(): readonly string[] {
    return [...this.#instances.keys()];
  }

  /**
   * Evaluate every temporal constraint once and deliver whatever escalations are due.
   *
   * Returns how many constraints fired. Resolves once each escalation has been processed,
   * so a caller that awaits it can then read the resulting state, which is what makes a
   * temporal constraint testable without waiting on wall time.
   *
   * The clock is read once per pass. Every violation a pass records is true at that one
   * instant, rather than at whichever moment the walk happened to reach it.
   *
   * Overlapping passes are not useful, so a call made while one is running returns 0
   * immediately rather than queueing behind it.
   */
  async sweep(): Promise<number> {
    if (this.#sweeping || this.#closing.signal.aborted) {
      return 0;
    }

    this.#sweeping = true;
    try {
      return await this.#sweepOnce();
    } finally {
      this.#sweeping = false;
    }
  }

  /**
   * Reclaim stored bytes once, across every layer that can.
   *
   * The counterpart to `sweep()` for disk rather than for time, and deliberately the same
   * shape: a method that runs one pass, plus an optional interval that calls it. What a
   * pass does is the store's business and is configured there; a layer with no budget, or
   * one told only to measure, reports nothing reclaimed rather than refusing.
   *
   * This is not on the commit path and must not be: choosing what to fold means walking
   * every key, and a caller waiting on an append should never pay for that.
   *
   * Compaction costs history and never state, so a pass is safe against instances that are
   * mid-flight: the sequence, values and current state all survive it, and an attempt
   * already holding a token still commits.
   *
   * Overlapping passes are not useful, so a call made while one is running returns an empty
   * result immediately rather than queueing behind it, exactly as `sweep()` does.
   */
  async sweepStorage(): Promise<StorageSweep> {
    if (this.#sweepingStorage || this.#closing.signal.aborted) {
      return EMPTY_SWEEP;
    }

    this.#sweepingStorage = true;
    const sweeping = this.#sweepStorageOnce();
    this.#storageSweep = sweeping.then(noop, noop);
    try {
      return await sweeping;
    } finally {
      this.#sweepingStorage = false;
      this.#storageSweep = undefined;
    }
  }

  /**
   * Shut the runtime down, letting work it has already accepted finish first.
   *
   * From the moment this is called no new trigger is accepted (`send()` rejects with
   * `RUNTIME_CLOSED`), no sweep runs, and a retry waiting out its backoff is abandoned
   * rather than started. A handler already running is left to finish and commit, and
   * refusals and violations still on their way to the store are allowed to land. So are a
   * `forget()` and a storage sweep that had already begun. Only then are the store layers
   * closed, so none of that work meets a closed connection.
   *
   * Two kinds of store write are not waited for, by design: the snapshot an eviction
   * leaves behind and an append to a cache layer. Both are optimizations whose loss costs
   * replay time or a cache miss, never committed state. A cache write still queued when
   * the layers are closed is dropped, and never run against a layer that has been closed.
   *
   * The wait is bounded. A handler that never settles would otherwise hold shutdown open
   * forever, so after `timeoutMs` the layers are closed regardless and `runtime.closed`
   * telemetry reports `drained: false` with how many keys were still busy.
   *
   * Safe to call more than once, and from several places at once: every call shares the
   * same shutdown and the first call's deadline.
   *
   * @param options `timeoutMs` is how long to wait for in-flight work. Defaults to 30 seconds.
   */
  close(options: { readonly timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
      return Promise.reject(
        new EkmanError(
          "INVALID_CONFIG",
          `close timeoutMs must be a positive number of milliseconds, at most ${MAX_TIMER_MS}, received ${String(timeoutMs)}`
        )
      );
    }

    this.#closed ??= this.#shutDown(timeoutMs);
    return this.#closed;
  }

  async #shutDown(timeoutMs: number): Promise<void> {
    this.#closing.abort();
    clearInterval(this.#sweepTimer);
    clearInterval(this.#storageSweepTimer);

    const instances = [...this.#instances.values()];
    const drained = await settledWithin(
      Promise.all([
        ...instances.map((instance) =>
          instance.inbox.whenIdle().then(() => instance.flushed())
        ),
        ...this.#forgetting.values(),
        this.#storageSweep,
      ]),
      timeoutMs
    );

    this.#emit({
      type: "runtime.closed",
      drained,
      pending:
        instances.filter((instance) => !instance.idle).length +
        this.#forgetting.size,
      at: telemetryNow(),
    });

    this.#caches.close();
    await Promise.all(this.#stack.layers.map((layer) => layer.close?.()));
  }

  /** Resident bytes on the documented accounting basis, and what the budget allows. */
  get memoryUsage(): {
    readonly bytes: number;
    readonly instances: number;
    readonly maxBytes: number | null;
  } {
    return Object.freeze({
      bytes: this.#ledger.total,
      instances: this.#ledger.size,
      maxBytes: this.#memory.bounded ? this.#memory.maxBytes : null,
    });
  }

  /**
   * What the durable layers are holding on disk, and what they are allowed to hold.
   *
   * The counterpart to `memoryUsage`, and deliberately separate from it: one is resident
   * bytes and the other is stored bytes, and collapsing them would hide whichever is
   * actually the constraint. Layers that do not account for themselves contribute nothing
   * rather than guessing.
   */
  get storageUsage(): {
    readonly bytes: number;
    readonly logs: number;
    readonly maxBytes: number | null;
  } {
    let bytes = 0;
    let logs = 0;
    let maxBytes: number | null = null;

    for (const layer of this.#stack.layers) {
      const { usage } = layer;
      if (usage === undefined) {
        continue;
      }
      bytes += usage.bytes;
      logs += usage.logs;
      if (usage.maxBytes !== null) {
        maxBytes = (maxBytes ?? 0) + usage.maxBytes;
      }
    }

    return Object.freeze({ bytes, logs, maxBytes });
  }

  /**
   * Add a definition to the registry.
   *
   * Every state's execution policy is resolved against the runtime's default here, and the
   * result discarded, so a policy no attempt could satisfy fails at construction or at
   * `define()` rather than on the first trigger. Dispatch resolves again from the same
   * inputs.
   */
  #register(definition: AnyDefinition): EntityHandle {
    const existing = this.#definitions.get(definition.name);

    if (existing !== undefined) {
      throw new EkmanError(
        "DUPLICATE_ENTITY",
        `entity "${definition.name}" is already registered with this runtime`
      );
    }

    for (const [state, entry] of definition.handlers) {
      resolvePolicy(
        this.#deps.policy,
        entry.policy,
        `entity "${definition.name}" state "${state}"`
      );
    }

    this.#definitions.set(definition.name, definition);
    return this.#makeHandle(definition);
  }

  #makeHandle(definition: AnyDefinition): EntityHandle {
    return Object.freeze({
      name: definition.name,
      key: (id: string) => definition.key(id),
      send: (id: string, trigger: Trigger) =>
        this.send(definition.key(id), trigger),
      post: (id: string, trigger: Trigger) =>
        this.post(definition.key(id), trigger),
      inspect: (id: string) => this.inspect(definition.key(id)),
      history: (id: string) => this.history(definition.key(id)),
      query: (criteria: Omit<QueryCriteria, "entity"> = {}) =>
        this.query({ ...criteria, entity: definition.name }),
      forget: (id: string) => this.forget(definition.key(id)),
    }) as EntityHandle;
  }

  /**
   * A trigger needs a type to be classified and an id to be traceable. The id is
   * assigned from a per-runtime counter when the caller does not supply one, which keeps
   * event causes deterministic.
   */
  #normalizeTrigger(trigger: Trigger, key: string): Trigger {
    // Types cannot reach callers in plain JavaScript, so the shape is checked at the
    // boundary rather than assumed. Viewing it as unknown keeps the check honest.
    const candidate: unknown = trigger;
    if (typeof candidate !== "object" || candidate === null) {
      throw new EkmanError(
        "UNKNOWN_TRIGGER",
        `trigger for ${key} must be an object with a "type", received ${typeof candidate}`,
        { key }
      );
    }

    if (typeof trigger.type !== "string" || trigger.type.length === 0) {
      throw new EkmanError(
        "UNKNOWN_TRIGGER",
        `trigger for ${key} must have a non-empty string "type"`,
        { key }
      );
    }

    const id = this.#nextTriggerId();
    return (trigger.id === undefined ? { ...trigger, id } : trigger) as Trigger;
  }

  /**
   * The next id from the per-runtime counter.
   *
   * Formatted `t1`, `t2`, and so on rather than as a UUID, so a conformance scenario can
   * assert on an event's cause without a matcher. The counter advances whenever a trigger
   * is accepted, including one the runtime raises itself, which is what keeps the
   * numbering the same for every implementation that follows the same rule.
   */
  #nextTriggerId(): string {
    this.#triggerSeq += 1;
    return `t${this.#triggerSeq}`;
  }

  /** Load or lazily initialize the instance. Initialization is a commit at sequence 0. */
  #resolveInstance(
    key: string,
    definition: AnyDefinition,
    trigger: Trigger
  ): AnyInstance {
    const existing = this.#instances.get(key);
    if (existing !== undefined) {
      return existing;
    }

    // Under `reject` the budget bounds how much a producer can materialize, which is what
    // stops a stream of unknown keys from becoming unbounded resident state. Existing
    // instances are untouched: shedding new work beats disturbing work in progress.
    if (
      this.#memory.policy === "reject" &&
      this.#ledger.total >= this.#memory.maxBytes
    ) {
      this.#emit({
        type: "memory.refused",
        key,
        entity: definition.name,
        residentBytes: this.#ledger.total,
        maxBytes: this.#memory.maxBytes,
        at: telemetryNow(),
      });

      throw new EkmanError(
        "MEMORY_EXHAUSTED",
        `the resident memory budget of ${this.#memory.maxBytes} bytes is full ` +
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
      states: definition.states,
      at: this.#now(),
      cause: { type: "init", id: trigger.id as string },
      deps: this.#runtime,
      onIdle: () => this.#onIdle(instance),
    });

    this.#instances.set(key, instance);
    this.#ledger.record(key, instance.bytes);

    if (!instance.needsHydration) {
      this.#temporal.enter(key, definition.name, definition.initial);
    }
    return instance;
  }

  /**
   * Hand the trigger to this key's inbox, along with the closure that will run it.
   *
   * The inbox owns ordering and capacity; it knows nothing about entities. This closure
   * is the only place the two meet.
   */
  #enqueue(
    instance: AnyInstance,
    definition: AnyDefinition,
    trigger: Trigger
  ): Promise<CommitResult> {
    return instance.inbox.enqueue(trigger, (dequeued, depth) =>
      this.#run(instance, definition, dequeued, depth)
    );
  }

  /**
   * Run one dequeued trigger.
   *
   * Thin on purpose. The attempt lifecycle telemetry is emitted by `dispatch`, which is
   * the layer that owns the attempt loop and therefore the only one that knows which
   * attempt started, retried, or settled the trigger.
   */
  /**
   * Run one dequeued trigger.
   *
   * Reconciling with the store happens here rather than in `send()`, because `send()` must
   * not await anything before the inbox push or FIFO order stops being call order. This is
   * inside the turn, so a reload cannot reorder anything and application code cannot tell
   * a reloaded instance from a resident one.
   */
  #run(
    instance: AnyInstance,
    definition: AnyDefinition,
    trigger: Trigger,
    depth: number
  ): Promise<CommitResult> {
    // Nothing to reconcile means nothing to await, so a memory-only runtime reaches its
    // handler in the same turn it always did. Awaiting unconditionally would delay
    // `handler.started` by a microtask and change how telemetry interleaves with the
    // `send()` calls around it, which scenarios written before stores existed can see.
    if (!instance.needsHydration) {
      return this.#dispatch(instance, definition, trigger, depth);
    }

    const forgetting = this.#forgetting.get(instance.key);
    const hydrated =
      forgetting === undefined
        ? this.#hydrate(instance)
        : forgetting.then(() => this.#hydrate(instance));

    return hydrated.then(() =>
      this.#dispatch(instance, definition, trigger, depth)
    );
  }

  async #dispatch(
    instance: AnyInstance,
    definition: AnyDefinition,
    trigger: Trigger,
    depth: number
  ): Promise<CommitResult> {
    const result = await dispatch(
      instance,
      definition,
      trigger,
      this.#deps,
      depth
    );

    this.#account(instance);
    return result;
  }

  /**
   * Keep the indexes in step with a commit a record has just applied.
   *
   * Only a move re-indexes: a commit that changed values alone leaves the instance where it
   * was, and its time in state keeps running. The record is always the one in the table:
   * a commit is applied inside its key's turn, a busy key is never evicted or forgotten,
   * and an attempt that outlived its turn is fenced before it can apply anything.
   */
  #committed(record: CommittedRecord, moved: boolean): void {
    if (moved) {
      this.#temporal.enter(record.key, record.entity, record.state);
    }
    this.#ledger.record(record.key, record.bytes);
  }

  /** Reconcile an instance with the store, reporting a reload when one happened. */
  async #hydrate(instance: AnyInstance): Promise<void> {
    const before = instance.lastRestored;
    await instance.ready();

    this.#ledger.record(instance.key, instance.bytes);
    this.#temporal.enter(instance.key, instance.entity, instance.state);

    const restored = instance.lastRestored;
    if (restored !== undefined && restored !== before) {
      this.#emit({
        type: "instance.restored",
        key: instance.key,
        entity: instance.entity,
        state: instance.state,
        seq: instance.seq,
        from: restored.from,
        replayed: restored.replayed,
        at: telemetryNow(),
      });
    }
  }

  /**
   * Report what an instance costs against the budget, once its trigger has settled.
   *
   * The ledger itself was updated when the commit was applied, in `#committed`. This is
   * the telemetry for it, emitted after the dispatch so it follows `handler.settled`.
   */
  #account(instance: AnyInstance): void {
    const overBudget = this.#ledger.total > this.#memory.maxBytes;

    this.#emit({
      type: "memory.accounted",
      key: instance.key,
      entity: instance.entity,
      bytes: instance.bytes,
      residentBytes: this.#ledger.total,
      residentCount: this.#ledger.size,
      maxBytes: this.#memory.bounded ? this.#memory.maxBytes : null,
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
  #onIdle(instance: AnyInstance): void {
    if (instance.unloaded && this.#instances.get(instance.key) === instance) {
      this.#release(instance);
    }

    if (
      this.#memory.policy === "lru" &&
      this.#ledger.total > this.#memory.maxBytes
    ) {
      this.#evictToFit();
    }
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
      if (this.#ledger.total <= this.#memory.maxBytes) {
        return;
      }

      const instance = this.#instances.get(key);
      if (instance === undefined || !instance.idle) {
        continue;
      }

      this.#evict(instance);
    }
  }

  /**
   * Stop holding an instance in memory, and report what that freed.
   *
   * Only the memory side. Whether the truth is preserved first, or destroyed after, is the
   * caller's business: eviction snapshots, forgetting deletes, and the three structures
   * that have to stay in step are the same either way.
   */
  #release(instance: AnyInstance): number {
    const bytes = this.#ledger.release(instance.key);
    this.#instances.delete(instance.key);
    this.#temporal.remove(instance.key);
    return bytes;
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

  /**
   * Release an idle instance to make room, snapshotting it first when a store exists.
   *
   * A record another writer has overtaken is released without a snapshot: its view is
   * known to be behind the store, and the store is where the next load reads from.
   */
  #evict(instance: AnyInstance): void {
    const { authority } = this.#stack;
    // Gated on a store existing, not on it being durable. Snapshotting into an ephemeral
    // store is worth doing: it is exactly what the next in-process reload reads.
    const snapshotted =
      this.#memory.snapshotOnEvict &&
      authority !== undefined &&
      !instance.needsHydration;

    if (snapshotted) {
      // Not awaited: the snapshot is an optimization for the next load, and the events it
      // summarizes are already in the store. A failed snapshot costs replay time, never
      // state.
      this.#snapshotted(
        instance.key,
        authority
          .snapshot(instance.key, instance.storeSnapshot(this.#now()))
          .catch(this.#onUnhandled)
      );
    }

    const bytes = this.#release(instance);

    this.#emit({
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
   * Hand a committed event to every audit sink.
   *
   * Never awaited and never able to fail anything: an audit outage must not become a write
   * outage. A sink that exhausts its attempts is reported and the commit stands.
   *
   * Each delivery starts on a later turn of the event loop, never inside the commit. A
   * sink's `deliver` runs synchronously up to its first await, so started here it would
   * make every commit wait for however long that takes.
   */
  #fanOut(event: EkmanEvent): void {
    for (const sink of this.#audit) {
      setImmediate(() => this.#deliver(sink, event));
    }
  }

  #deliver(sink: AuditSink, event: EkmanEvent): void {
    deliverTo(sink, event)
      .then((failure) => {
        if (failure !== undefined) {
          this.#emit({
            type: "audit.failed",
            key: event.key,
            entity: parseKey(event.key).entity,
            sink: sink.name,
            error: failure.message,
            seq: event.seq,
            at: telemetryNow(),
          });
        }
      })
      .catch(this.#onUnhandled);
  }

  #startSweeping(sweepMs: number | undefined): void {
    if (sweepMs === undefined) {
      return;
    }

    if (!(sweepMs > 0 && sweepMs <= MAX_TIMER_MS)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `temporal sweepMs must be a positive number of milliseconds, at most ${MAX_TIMER_MS}, received ${JSON.stringify(sweepMs)}. ` +
          "Omit it to sweep only when sweep() is called."
      );
    }

    this.#sweepTimer = setInterval(() => {
      this.sweep().catch(this.#onUnhandled);
    }, sweepMs);

    // Sweeping is background work. A runtime that is otherwise finished should be allowed
    // to exit rather than being held open by its own housekeeping.
    this.#sweepTimer.unref?.();
  }

  #startStorageSweeping(sweepMs: number | undefined): void {
    if (sweepMs === undefined) {
      return;
    }

    if (!(sweepMs > 0 && sweepMs <= MAX_TIMER_MS)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `storage sweepMs must be a positive number of milliseconds, at most ${MAX_TIMER_MS}, received ${JSON.stringify(sweepMs)}. ` +
          "Omit it to reclaim only when sweepStorage() is called."
      );
    }

    // An interval over layers that cannot compact would wake up forever and reclaim
    // nothing, which is a setting that looks configured and does nothing. Refused at
    // startup instead, on the same rule as every other unsatisfiable configuration here.
    if (!this.#stack.layers.some((layer) => layer.capabilities.compact)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        "storage sweepMs is set, but no configured store layer can compact, so a sweep " +
          "could never reclaim anything. Configure a layer that compacts, or remove the " +
          "setting and read storageUsage to measure instead."
      );
    }

    this.#storageSweepTimer = setInterval(() => {
      this.sweepStorage().catch(this.#onUnhandled);
    }, sweepMs);

    // Housekeeping, exactly as the temporal sweep is: a runtime that is otherwise finished
    // should be free to exit rather than being held open by its own reclaiming.
    this.#storageSweepTimer.unref?.();
  }

  /**
   * Whether a snapshot has absorbed events this stream can no longer show.
   *
   * Asked of the events rather than of the store, so every adapter answers it the same way
   * with no capability for it: a whole stream holds the transition that initialized the
   * instance, and one without it is missing its beginning. The earliest event's sequence
   * cannot answer this, because refusals and violations survive compaction and one recorded
   * at sequence zero would make a folded stream read as whole.
   *
   * A stream with no initialization in it is the case events alone cannot settle. A key
   * that was never initialized and a key whose beginning is inside its snapshot look
   * identical from here, and only the snapshot tells them apart.
   */
  async #wasCompacted(
    key: string,
    stored: readonly EkmanEvent[],
    authority: Store
  ): Promise<boolean> {
    if (
      stored.some((event) => event.type === "transition" && event.from === null)
    ) {
      return false;
    }
    return (await authority.load(key))?.snapshot !== undefined;
  }

  async #sweepStorageOnce(): Promise<StorageSweep> {
    let logs = 0;
    let reclaimed = 0;
    const overBudget: string[] = [];

    for (const layer of this.#stack.layers) {
      if (!(layer.capabilities.compact && layer.compact)) {
        continue;
      }

      // biome-ignore lint/performance/noAwaitInLoops: layers are swept in stack order so the telemetry reads in that order, and so two layers never rewrite their logs at the same moment
      const swept = await layer.compact();
      logs += swept.logs;
      reclaimed += swept.reclaimed;
      if (!swept.withinBudget) {
        overBudget.push(layer.name);
      }

      this.#emit({
        type: "storage.swept",
        at: telemetryNow(),
        store: layer.name,
        logs: swept.logs,
        reclaimed: swept.reclaimed,
        // Read after the pass, so this is what the layer holds now rather than what it
        // held when the pass started.
        bytes: layer.usage?.bytes ?? 0,
        maxBytes: layer.usage?.maxBytes ?? null,
        withinBudget: swept.withinBudget,
      });
    }

    return Object.freeze({
      logs,
      reclaimed,
      overBudget: Object.freeze(overBudget),
    });
  }

  async #sweepOnce(): Promise<number> {
    const at = this.#now();
    let fired = 0;

    for (const definition of this.#definitions.values()) {
      const byState = definition.constraints?.temporalByState;
      if (byState === undefined) {
        continue;
      }

      for (const [state, constraints] of byState) {
        for (const key of this.#temporal.keys(definition.name, state)) {
          // biome-ignore lint/performance/noAwaitInLoops: an escalation dispatches like any other trigger, and a pass that fired several should report every one of them as processed
          fired += await this.#sweepInstance(key, state, constraints, at);
        }
      }
    }

    return fired;
  }

  /**
   * Evaluate one instance against the constraints watching the state it is in.
   *
   * Constraints run in declaration order. One is marked fired only once its escalation has
   * been delivered or refused for good, so an escalation turned away by a full inbox is
   * raised again by the next sweep. The pass ends as soon as the instance has left the
   * state: the remaining constraints watch somewhere it no longer is. An outcome is only
   * recorded against the entry into the state that the escalation was raised for.
   *
   * @returns how many escalations were raised, delivered or not
   */
  async #sweepInstance(
    key: string,
    state: string,
    constraints: readonly CompiledTemporal[],
    at: number
  ): Promise<number> {
    let fired = 0;

    for (const constraint of constraints) {
      const aged = this.#ageOf(key, state, at);
      if (aged === undefined) {
        return fired;
      }

      const { instance, elapsedMs } = aged;
      if (elapsedMs < constraint.within || instance.hasFired(constraint.name)) {
        continue;
      }

      fired += 1;
      const entry = instance.stateEntry;
      // biome-ignore lint/performance/noAwaitInLoops: two constraints on one state fire in declaration order, and the second runs only if the first left the instance where it was
      const outcome = await this.#escalate(instance, constraint, elapsedMs, at);
      if (outcome !== "refused-transiently") {
        instance.markFired(constraint.name, entry);
      }
    }

    return fired;
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
  #ageOf(
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

  /** Resident instances matching the criteria, read through the same index the sweep uses. */
  *#residentMatches(
    criteria: QueryCriteria,
    olderThanMs: number | undefined,
    at: number
  ): Generator<QueryMatch> {
    const states =
      criteria.state === undefined
        ? this.#temporal.states(criteria.entity)
        : [criteria.state];

    for (const state of states) {
      for (const key of this.#temporal.keys(criteria.entity, state)) {
        const aged = this.#ageOf(key, state, at);
        if (aged === undefined || (olderThanMs ?? 0) > aged.elapsedMs) {
          continue;
        }

        yield {
          key,
          entity: criteria.entity,
          state,
          seq: aged.instance.seq,
          enteredAt: aged.instance.enteredAt,
          ageMs: aged.elapsedMs,
          resident: true,
        };
      }
    }
  }

  /**
   * Add the store's matches, leaving any key the resident view already answered.
   *
   * Resident wins because it is the more current of the two: the store lags by whatever is
   * queued behind the last commit, and an instance in memory is by definition up to date.
   * The store is told which keys those are, so it does not load what would be discarded.
   * Only keys that matched are named. A resident instance that did not match is still
   * asked about, because its stored row is the answer when another writer has moved it.
   *
   * The caller's limit is not passed down. A store truncates in key order and the answer
   * is ordered by age, so a store that stopped early could drop a row older than every one
   * it returned.
   */
  async #scanInto(
    matches: Map<string, QueryMatch>,
    authority: Store,
    criteria: QueryCriteria,
    olderThanMs: number | undefined,
    at: number,
    reasons: Set<Partiality>
  ): Promise<void> {
    const result = await authority.scan({
      entity: criteria.entity,
      now: at,
      ...(criteria.state === undefined ? {} : { state: criteria.state }),
      ...(olderThanMs === undefined ? {} : { olderThanMs }),
      skip: new Set(matches.keys()),
    });

    if (!result.complete) {
      reasons.add("limit-reached");
    }

    // A store that could not apply a filter says so, and the runtime applies it here
    // rather than returning rows the caller did not ask for.
    const unsupported = new Set(result.unsupported);
    if (unsupported.size > 0) {
      reasons.add("unsupported-criteria");
    }

    for (const match of result.matches) {
      if (matches.has(match.key)) {
        continue;
      }

      const ageMs = at - match.enteredAt;
      const wrongState =
        unsupported.has("state") &&
        criteria.state !== undefined &&
        match.state !== criteria.state;

      if (
        wrongState ||
        (unsupported.has("olderThan") && (olderThanMs ?? 0) > ageMs)
      ) {
        continue;
      }

      matches.set(match.key, { ...match, ageMs, resident: false });
    }
  }

  /**
   * Record a temporal violation and, unless it is only a warning, deliver its escalation.
   *
   * The escalation goes through `send()`, so it queues behind whatever the instance is
   * already doing and dispatches against the state it is in when its turn comes. The
   * runtime never writes state on its own: `escalateTo` rides on the trigger, and the
   * handler decides.
   *
   * A trigger id is allocated even for a warning, so the recorded violation always has a
   * traceable cause and the counter advances identically under either policy. When an
   * earlier sweep raised this escalation and it was turned away, the violation is already
   * in the stream, so only the trigger is sent again, under the id that violation named.
   *
   * A send that rejects is reported through `onUnhandled` rather than thrown: the usual
   * cause is that the state an instance is stuck in cannot handle the trigger, which is
   * exactly the situation the constraint was watching for.
   */
  async #escalate(
    instance: AnyInstance,
    constraint: CompiledTemporal,
    elapsedMs: number,
    at: number
  ): Promise<EscalationOutcome> {
    const entry = instance.stateEntry;
    const owed = instance.undelivered(constraint.name);
    const id = owed ?? this.#nextTriggerId();
    const cause = { type: constraint.trigger, id };
    const trigger = {
      ...cause,
      constraint: constraint.name,
      state: constraint.in,
      sinceMs: elapsedMs,
      ...(constraint.escalateTo === undefined
        ? {}
        : { escalateTo: constraint.escalateTo }),
    } as Trigger;

    if (owed === undefined) {
      this.#recordTemporalViolation(instance, constraint, elapsedMs, at, cause);
    }

    if (constraint.policy === "warn") {
      return "warned";
    }

    let outcome: EscalationOutcome = "delivered";
    try {
      await this.send(instance.key, trigger);
    } catch (error) {
      outcome = refusalOutcome(error);
      this.#onUnhandled(error);
    }

    if (outcome === "refused-transiently") {
      instance.markUndelivered(constraint.name, id, entry);
    }

    this.#emit({
      type: "constraint.escalated",
      key: instance.key,
      entity: instance.entity,
      constraint: constraint.name,
      state: constraint.in,
      elapsedMs,
      escalateTo: constraint.escalateTo,
      trigger: cause,
      delivered: outcome === "delivered",
      at: telemetryNow(),
    });

    return outcome;
  }

  /** Write a temporal violation to the instance's stream and mirror it in telemetry. */
  #recordTemporalViolation(
    instance: AnyInstance,
    constraint: CompiledTemporal,
    elapsedMs: number,
    at: number,
    cause: { type: string; id: string }
  ): void {
    const reason =
      `has been in "${constraint.in}" for ${elapsedMs}ms, over its bound of ` +
      `${constraint.within}ms`;

    instance.violation({
      violation: {
        kind: "temporal",
        name: constraint.name,
        policy: constraint.policy,
        reason,
      },
      at,
      cause,
    });

    this.#emit({
      type: "constraint.violated",
      key: instance.key,
      entity: instance.entity,
      state: constraint.in,
      kind: "temporal",
      constraint: constraint.name,
      policy: constraint.policy,
      reason,
      trigger: cause,
      at: telemetryNow(),
    });
  }

  #emit(event: TelemetryEvent): void {
    emit(this.#runtime.telemetry, event, this.#onUnhandled);
  }
}

/** What an overlapping storage sweep returns: a pass that did not run reclaimed nothing. */
const EMPTY_SWEEP: StorageSweep = Object.freeze({
  logs: 0,
  reclaimed: 0,
  overBudget: Object.freeze([]),
});

const NONE: readonly Partiality[] = Object.freeze([]);
const NO_DURABLE_STORE: readonly Partiality[] = Object.freeze([
  "no-durable-store" as const,
]);
const CAPPED_IN_MEMORY: readonly Partiality[] = Object.freeze([
  "no-durable-store" as const,
  "history-capped" as const,
]);
const RESIDENT_ONLY: readonly string[] = Object.freeze(["resident"]);
const COMPACTED: readonly Partiality[] = Object.freeze(["compacted"]);

/** Why a history is not the whole story, if it is not. */
function partiality(
  durable: boolean,
  compacted: boolean
): readonly Partiality[] {
  if (!durable) {
    return NO_DURABLE_STORE;
  }
  return compacted ? COMPACTED : NONE;
}

/**
 * Oldest first, which is the order the question is asked in: "what has been stuck longest".
 * Ties break on the key so a limited answer is the same answer twice.
 *
 * Keys are compared as plain strings and not by locale, so the order is the same on every
 * machine. Two matches never share a key, so there is no equal case.
 */
function byAgeThenKey(a: QueryMatch, b: QueryMatch): number {
  if (a.ageMs !== b.ageMs) {
    return b.ageMs - a.ageMs;
  }
  return a.key < b.key ? -1 : 1;
}

/** The longest list `oldest` keeps in order by insertion. */
const BOUNDED_INSERTION_LIMIT = 64;

/**
 * The first `limit` matches in `byAgeThenKey` order, without sorting the rest.
 *
 * A short sorted list is kept and each match is placed into it by binary search, or passed
 * over when it would land past the end. A dashboard asking for ten of a hundred thousand
 * pays for the ten.
 *
 * Only while the list is short. Placing a match moves everything after it, so matches
 * that arrive newest first cost the length of the list each, and a limit just under the
 * number of matches would make that the square of it. Past `BOUNDED_INSERTION_LIMIT` the
 * matches are sorted and cut, which is what an untruncated answer costs anyway.
 */
function oldest(matches: Iterable<QueryMatch>, limit: number): QueryMatch[] {
  if (limit > BOUNDED_INSERTION_LIMIT) {
    return [...matches].sort(byAgeThenKey).slice(0, limit);
  }

  const kept: QueryMatch[] = [];

  for (const match of matches) {
    const last = kept[limit - 1];
    if (last !== undefined && byAgeThenKey(match, last) > 0) {
      continue;
    }

    let low = 0;
    let high = kept.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (byAgeThenKey(kept[middle] as QueryMatch, match) < 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    kept.splice(low, 0, match);
    if (kept.length > limit) {
      kept.pop();
    }
  }

  return kept;
}

/**
 * Wait for every one of these to finish, then fail with the first failure if there was one.
 *
 * `Promise.all` rejects as soon as one does, while the others are still running. For a
 * delete across store layers that is too early: whatever waits on the deletion would be
 * let through while a layer was still deleting, and could have a commit erased under it.
 */
async function allSettledOrThrow(
  work: readonly (Promise<unknown> | undefined)[]
): Promise<void> {
  const failed = (await Promise.allSettled(work)).find(
    (outcome) => outcome.status === "rejected"
  );
  if (failed !== undefined) {
    throw failed.reason;
  }
}

/** How long `close()` waits for in-flight work unless told otherwise. */
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

/**
 * Whether `work` settled before `ms` passed.
 *
 * The timer keeps the process alive until one or the other happens. An awaited `close()`
 * has code after it, and a process that exited while waiting on a handler that never
 * settles would skip closing the store layers along with everything else.
 */
function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    work.finally(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const RUNTIME_KEYS = [
  "entities",
  "inbox",
  "temporal",
  "storage",
  "coordination",
  "store",
  "memory",
  "audit",
  "execution",
  "telemetry",
  "now",
  "onUnhandled",
] as const;

const SWEEP_KEYS = ["sweepMs"] as const;

/**
 * Refuse a runtime config the runtime could not honour, before anything is built from it.
 *
 * Unrecognized options first, at every level that takes named ones, so a misspelling is
 * an error rather than a default nobody asked for. Then the runtime-wide execution policy,
 * which would otherwise only be found unsatisfiable by the first trigger to arrive. Inbox
 * and memory options are checked where they are resolved.
 */
function assertRuntimeConfig(config: EkmanConfig): void {
  assertKnownKeys("the runtime config", config, RUNTIME_KEYS);
  assertKnownKeys("temporal", config.temporal, SWEEP_KEYS);
  assertKnownKeys("storage", config.storage, SWEEP_KEYS);
  assertKnownKeys("telemetry", config.telemetry, [
    ...TELEMETRY_EVENT_TYPES,
    TELEMETRY_FALLBACK,
  ]);

  assertPolicyKeys(config.execution, "runtime execution policy");
  resolvePolicy(config.execution, undefined, "runtime execution policy");
}

function noop(): void {
  // Deliberately empty: settles a promise whose outcome is somebody else's to report.
}

function defaultOnUnhandled(error: unknown): void {
  console.error("[ekman] unhandled failure from post()", error);
}
