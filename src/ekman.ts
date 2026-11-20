import type { AuditSink } from "./audit";
import { assertAuditSink, deliverTo } from "./audit";
import { Caches, DEFAULT_CACHE_TIMEOUT_MS } from "./caches";
import { assertBuilt, constraintsOf, statesOf } from "./compiled";
import type { CommittedRecord, RuntimeDeps } from "./config";
import { assertKnownKeys, resolveInboxConfig } from "./config";
import type {
  CompiledBound,
  CompiledRule,
  RuleTrigger,
  StaleTrigger,
  TemporalTrigger,
} from "./constraints";
import { limitOf, thrownMessage } from "./constraints";
import type { DispatchDeps } from "./dispatch";
import { dispatch } from "./dispatch";
import { EkmanError } from "./errors";
import type { EkmanEvent, EventCause, TransitionEvent } from "./events";
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
  StateMap,
  StateMapEntry,
  StateMapOptions,
} from "./query";
import { mergeRestores, parseDuration } from "./query";
import type { ResolvedStack } from "./stack";
import { assertCoordination, resolveStack } from "./stack";
import type {
  ScanCriteria,
  ScanFilter,
  ScanMatch,
  StorageSweep,
  Store,
} from "./store";
import { EMPTY_SEQ, lastCommitOf, replay } from "./store";
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
  CacheConfig,
  CloseOptions,
  CommitResult,
  EkmanConfig,
  EntityDefinition,
  EntityHandle,
  EntityHandles,
  InstanceSnapshot,
  OnUnhandled,
  Trigger,
  TriggerLike,
  UnhandledContext,
  Values,
} from "./types";

// biome-ignore-start lint/suspicious/noExplicitAny: the runtime holds instances and
// definitions of many entity shapes at once. `unknown` is not assignable across the
// contravariant handler positions these feed, so `any` is the only escape that keeps
// the heterogeneous registry typable. Every public surface re-narrows.
type AnyInstance = InstanceRecord<any, any>;
type AnyDefinition = EntityDefinition<string, any, any, any>;

/** What a sweep learned about a stored instance it loaded, kept so it need not load it again. */
interface SettledNote {
  /** The sequence the instance was at. Any commit since makes the note out of date. */
  readonly seq: number;
  /** When it entered its state, which a different instance under the same key would not share. */
  readonly enteredAt: number;
  /** The earliest moment one of its bounds could have something new to say. */
  readonly dueAt: number;
}
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
  /**
   * The rules of each entity that declares any, by watched state. Kept apart from the
   * definitions so a commit of an entity with no rules pays one lookup to learn that.
   */
  readonly #rules = new Map<
    string,
    ReadonlyMap<string, readonly CompiledRule[]>
  >();
  readonly #instances = new Map<string, AnyInstance>();
  readonly #now: () => number;
  readonly #onUnhandled: OnUnhandled;
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
  /**
   * Stored instances the last sweep loaded and found nothing to raise for, by key.
   *
   * Without it every pass would load each instance that has sat past its bound and
   * already been told so. A pass drops every note it did not see the key for, so this
   * never holds more than the stored instances currently past a bound, and deleting an
   * instance drops its note, so a key created again is not mistaken for the one before.
   */
  readonly #settled = new Map<string, SettledNote>();
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
  /**
   * The time-in-state pass under way, if one is. Waited for at shutdown, because a pass
   * loads instances and records violations, and neither should meet a closed store.
   */
  #temporalSweep: Promise<void> | undefined;
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
      timeoutMs: resolveCacheTimeout(config.cache),
      suspended: (suspension) =>
        this.#emit({
          type: "store.cacheSuspended",
          store: suspension.store,
          timeouts: suspension.timeouts,
          at: telemetryNow(),
        }),
    });

    this.#runtime = {
      now: () => this.#now(),
      telemetry: config.telemetry,
      onUnhandled: (error, context) => this.#onUnhandled(error, context),
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
    const instance = this.#resolveInstance(key, definition, {
      type: "init",
      id: normalized.id as string,
    });

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
    this.send(key, trigger).catch(this.#unhandled("post", key));
  }

  /**
   * Current committed state, read from memory without touching the store.
   *
   * Undefined when the instance is not resident: nothing has addressed the key yet, it was
   * evicted, or it is still being loaded.
   */
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
        `${JSON.stringify(parsed)} has a handler in flight or is being evaluated by a ` +
          "sweep, so it was not forgotten. Deleting it now would leave that work " +
          "committing into a key that no longer exists. Retry once it is idle.",
        { key: parsed }
      );
    }

    const bytes = instance === undefined ? 0 : this.#release(instance);
    this.#settled.delete(parsed);

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

  /**
   * The per-key ordered event stream: transitions, refusals, violations and restores.
   *
   * Reads through the commit authority when one is configured, so it covers the instance's
   * whole life and not only what this process happened to see. With no store it answers
   * from what is resident, and says so: `complete` is false and `reasons` explains why.
   */
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
  async query<S extends string = string, V extends Values = Values>(
    criteria: QueryCriteria<S, V>
  ): Promise<QueryResult<S, V>> {
    this.#definitionFor(criteria.entity);
    const { limit } = criteria;
    assertLimit(limit, "a query's limit", "every match");
    const at = this.#now();
    const olderThanMs =
      criteria.olderThan === undefined
        ? undefined
        : parseDuration(criteria.olderThan);
    const staleForMs =
      criteria.staleFor === undefined
        ? undefined
        : parseDuration(criteria.staleFor, "staleFor");
    const where = criteria.where as
      | ((values: Readonly<Values>) => boolean)
      | undefined;
    const showing = criteria.includeValues === true;
    const reading = showing || where !== undefined;

    const reasons = new Set<Partiality>();
    const sources = ["resident"];
    const matches = new Map<string, QueryMatch>();

    for (const match of this.#residentMatches(
      criteria.entity,
      criteria.state,
      olderThanMs,
      at,
      reading
    )) {
      // Only when the query asked. A clock that steps backwards can put the last commit
      // ahead of now, and a filter nobody set must not drop the instance over that.
      if (staleForMs === undefined || staleForMs <= (match.staleMs as number)) {
        matches.set(match.key, match);
      }
    }

    const { authority } = this.#stack;
    if (authority === undefined) {
      reasons.add("no-durable-store");
    } else {
      sources.push(authority.name);
      await this.#scanInto(
        matches,
        authority,
        criteria.entity,
        criteria.state,
        olderThanMs,
        staleForMs,
        at,
        reading,
        reasons
      );
      if (!this.#stack.durable) {
        reasons.add("no-durable-store");
      }
    }

    // Applied after the union, to resident and stored matches alike, so the filter is
    // exact wherever an instance happened to be.
    const found =
      where === undefined
        ? [...matches.values()]
        : [...matches.values()].filter((match) =>
            where(match.values as Readonly<Values>)
          );

    // Applied last, so a limit cannot silently prefer resident instances over stored ones
    // or the other way round.
    const truncated = limit !== undefined && limit < found.length;
    const ordered = truncated ? oldest(found, limit) : found.sort(byAgeThenKey);
    // Values read only to evaluate `where` are not part of an answer that did not ask.
    const instances =
      reading && !showing ? ordered.map(withoutValues) : ordered;

    if (truncated) {
      reasons.add("limit-reached");
    }

    return Object.freeze({
      instances: Object.freeze(instances),
      complete: reasons.size === 0,
      reasons: Object.freeze([...reasons]),
      sources: Object.freeze(sources),
    }) as QueryResult<S, V>;
  }

  /**
   * Where every instance of an entity is: a count and the keys for each state.
   *
   * The same union a query makes, grouped. Resident instances and stored ones are both
   * counted, and the map reports itself incomplete for exactly the reasons a query over
   * the entity would.
   */
  async map<S extends string = string>(
    entity: string,
    options: StateMapOptions = {}
  ): Promise<StateMap<S>> {
    const { limitPerState } = options;
    assertLimit(limitPerState, "a map's limitPerState", "every key");
    const found = await this.query({ entity });
    return stateMap<S>(
      entity,
      found.instances,
      found.reasons,
      found.sources,
      limitPerState
    );
  }

  /**
   * The state map of what is in memory, without asking a store.
   *
   * Synchronous and cheap, for a view that refreshes often. Never complete by
   * construction: an evicted instance, or one this runtime has not loaded, is not in it,
   * and the result says so with `resident-only`.
   */
  residentMap<S extends string = string>(entity: string): StateMap<S> {
    this.#definitionFor(entity);
    const instances = [
      ...this.#residentMatches(
        entity,
        undefined,
        undefined,
        this.#now(),
        false
      ),
    ].sort(byAgeThenKey);
    return stateMap<S>(entity, instances, IN_MEMORY_ONLY, RESIDENT_ONLY);
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
   * With a store, instances it holds that are not resident are evaluated too. A store
   * that cannot be scanned, or an instance that cannot be loaded, is reported through
   * `onUnhandled` and does not reject the pass.
   *
   * Overlapping passes are not useful, so a call made while one is running returns 0
   * immediately rather than queueing behind it.
   */
  async sweep(): Promise<number> {
    if (this.#sweeping || this.#closing.signal.aborted) {
      return 0;
    }

    this.#sweeping = true;
    const sweeping = this.#sweepOnce();
    this.#temporalSweep = sweeping.then(noop, noop);
    try {
      return await sweeping;
    } finally {
      this.#sweeping = false;
      this.#temporalSweep = undefined;
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
   * `forget()`, a storage sweep and a time-in-state sweep that had already begun. The
   * last loads nothing more once this is called and ends as soon as the escalation it is
   * delivering settles. Only then are the store layers closed, so none of that work meets
   * a closed connection.
   *
   * Writes to the cache layers are waited for next, when one of them outlives the process.
   * A write it never received would leave it a commit behind the authority, for the next
   * process to load and have its first commit refused. A stack whose caches are all held
   * in memory is not waited for: what they are owed dies with them. Where the two are
   * mixed, a key's writes go to its layers in one order, so they are waited for together.
   *
   * The snapshot an eviction leaves behind is not waited for either. It is an
   * optimization whose loss costs replay time, never committed state. A cache write still
   * queued when the layers are closed is dropped, and never run against a closed layer.
   *
   * The wait is bounded, and one deadline covers all of it. A handler that never settles,
   * or a cache that never answers, would otherwise hold shutdown open forever, so after
   * `timeoutMs` the layers are closed regardless and `runtime.closed` telemetry reports
   * `drained: false`, with how many keys were still busy and how many still had cache
   * writes queued.
   *
   * Safe to call more than once, and from several places at once: every call shares the
   * same shutdown and the first call's deadline.
   *
   * @param options `timeoutMs` is how long to wait for in-flight work. Defaults to 30 seconds.
   */
  close(options: CloseOptions = {}): Promise<void> {
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
    const deadline = performance.now() + timeoutMs;
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
        this.#temporalSweep,
      ]),
      timeoutMs
    );

    const cachePending = await this.#drainCaches(deadline);

    this.#emit({
      type: "runtime.closed",
      drained: drained && cachePending === 0,
      pending:
        instances.filter((instance) => !instance.idle).length +
        this.#forgetting.size,
      cachePending,
      at: telemetryNow(),
    });

    this.#caches.close();
    await Promise.all(this.#stack.layers.map((layer) => layer.close?.()));
  }

  /**
   * Wait, until the shutdown's deadline, for writes owed to a cache layer that outlives
   * the process. Answers how many keys still had some queued when the wait ended.
   */
  async #drainCaches(deadline: number): Promise<number> {
    if (!this.#caches.outlasting) {
      return 0;
    }

    const remaining = deadline - performance.now();
    if (remaining > 0) {
      await settledWithin(this.#caches.idle(), remaining);
    }
    return this.#caches.queued;
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
      const usage = layer.usage?.();
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
    assertBuilt(definition);
    const existing = this.#definitions.get(definition.name);

    if (existing !== undefined) {
      throw new EkmanError(
        "DUPLICATE_ENTITY",
        `entity "${definition.name}" is already registered with this runtime. It was ` +
          "already passed in entities, or define() was called twice for it."
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
    const rules = constraintsOf(definition)?.rulesByState;
    if (rules !== undefined && rules.size > 0) {
      this.#rules.set(definition.name, rules);
    }
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
      map: (options?: StateMapOptions) => this.map(definition.name, options),
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

  /**
   * Load or lazily initialize the instance. Initialization is a commit at sequence 0.
   *
   * `loadOnly` is for a reader that must not create what it is looking for: the record
   * loads the key if the store holds it and is left unloaded if the store does not.
   */
  #resolveInstance(
    key: string,
    definition: AnyDefinition,
    cause: EventCause,
    loadOnly = false
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
      states: statesOf(definition),
      at: this.#now(),
      cause,
      deps: this.#runtime,
      onIdle: () => this.#onIdle(instance),
      loadOnly,
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

    const rules = this.#rules.get(record.entity)?.get(record.state);
    if (rules !== undefined) {
      this.#evaluateRules(
        this.#instances.get(record.key) as AnyInstance,
        rules
      );
    }
  }

  /**
   * Ask each rule watching an instance's state whether its condition holds on what was
   * just committed, and propose for the ones that have come to hold.
   *
   * A rule that holds and has already said so is passed over, which is what makes a
   * value that stays over a threshold one proposal. One that does not hold is armed
   * again. Run from the commit hook, inside the committing turn, so nothing here waits.
   */
  #evaluateRules(instance: AnyInstance, rules: readonly CompiledRule[]): void {
    const snapshot = instance.snapshot();

    for (const rule of rules) {
      const reason = heldBy(rule, snapshot);
      if (reason === undefined) {
        instance.rearm(rule.name);
      } else if (
        !(instance.hasFired(rule.name) || instance.isProposing(rule.name))
      ) {
        this.#propose(instance, rule, reason);
      }
    }
  }

  /**
   * Arm again every rule whose condition does not hold on an instance just loaded.
   *
   * A stream records a rule matching and never records it ceasing to, so the latch a
   * load rebuilds can name a rule as done whose condition stopped holding long ago.
   * Left alone, the commit that next made it hold would be passed over.
   */
  #rearmRules(instance: AnyInstance): void {
    const rules = this.#rules.get(instance.entity)?.get(instance.state);
    if (rules === undefined) {
      return;
    }

    const snapshot = instance.snapshot();
    for (const rule of rules) {
      if (heldBy(rule, snapshot) === undefined) {
        instance.rearm(rule.name);
      }
    }
  }

  /**
   * Record that a rule's condition came to hold and, unless it only warns, send its
   * proposal.
   *
   * The proposal goes through `send()` and is not awaited: this runs inside the turn of
   * the commit that made the condition hold, and the proposal queues behind it. The
   * runtime never writes state on its own. `propose` rides on the trigger, and the
   * handler decides.
   *
   * A proposal that was turned away for a reason that passes stays owed. The match is
   * already in the stream, so the next commit sends the trigger again under the id that
   * match named and records nothing twice.
   */
  #propose(instance: AnyInstance, rule: CompiledRule, reason: string): void {
    const owed = instance.undelivered(rule.name);
    const cause =
      owed === undefined
        ? this.#freshCause(instance, rule.trigger)
        : { type: rule.trigger, id: owed };
    const { key, entity, state } = instance;

    if (owed === undefined) {
      instance.violation({
        violation: {
          kind: "rule",
          name: rule.name,
          policy: rule.policy,
          reason,
        },
        at: this.#now(),
        cause,
      });
      this.#emit({
        type: "constraint.violated",
        key,
        entity,
        state,
        kind: "rule",
        constraint: rule.name,
        policy: rule.policy,
        reason,
        trigger: cause,
        at: telemetryNow(),
      });
    }

    if (rule.policy === "warn") {
      return;
    }

    const trigger: RuleTrigger<string, string> = {
      ...cause,
      rule: rule.name,
      state,
      ...(rule.propose === undefined ? {} : { propose: rule.propose }),
      reason,
    };
    instance.proposing(rule.name, cause.id);

    this.send(key, trigger)
      .then(
        (): EscalationOutcome => "delivered",
        (error: unknown): EscalationOutcome => {
          this.#onUnhandled(error, { source: "escalation", key });
          return refusalOutcome(error);
        }
      )
      .then((outcome) => {
        instance.proposed(rule.name, cause.id);
        if (outcome === "refused") {
          instance.refused(rule.name, cause.id);
        }
        this.#emit({
          type: "constraint.escalated",
          key,
          entity,
          kind: "rule",
          constraint: rule.name,
          state,
          escalateTo: rule.propose,
          trigger: cause,
          delivered: outcome === "delivered",
          at: telemetryNow(),
        });
      });
  }

  /** Reconcile an instance with the store, reporting a reload when one happened. */
  async #hydrate(instance: AnyInstance): Promise<void> {
    const before = instance.lastRestored;
    await instance.ready();
    if (instance.unloaded || this.#instances.get(instance.key) !== instance) {
      // Asked only to load, and the store holds nothing. Or the record was released while
      // it loaded, which only one nothing is queued on can be. Indexing either would
      // leave the ledger and the index holding a key the runtime does not.
      return;
    }

    this.#ledger.record(instance.key, instance.bytes);
    this.#temporal.enter(instance.key, instance.entity, instance.state);
    this.#rearmRules(instance);

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
          .catch(this.#unhandled("snapshot", instance.key))
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
  #fanOut(event: TransitionEvent): void {
    for (const sink of this.#audit) {
      setImmediate(() => this.#deliver(sink, event));
    }
  }

  #deliver(sink: AuditSink, event: TransitionEvent): void {
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
      .catch(this.#unhandled("audit", event.key));
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
      this.sweep().catch(this.#unhandled("sweep"));
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
      this.sweepStorage().catch(this.#unhandled("storage-sweep"));
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

      // Read after the pass, so this is what the layer holds now rather than what it held
      // when the pass started.
      const usage = layer.usage?.();
      this.#emit({
        type: "storage.swept",
        at: telemetryNow(),
        store: layer.name,
        logs: swept.logs,
        reclaimed: swept.reclaimed,
        bytes: usage?.bytes ?? 0,
        maxBytes: usage?.maxBytes ?? null,
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
    const noted = new Set<string>();
    let fired = 0;

    for (const definition of this.#definitions.values()) {
      const byState = constraintsOf(definition)?.boundsByState;
      // An entity with guards or a transition graph and no bound of either kind has an
      // empty map here, and nothing to sweep. Asking its store anyway would read every
      // instance.
      if (byState === undefined || byState.size === 0) {
        continue;
      }

      for (const [state, constraints] of byState) {
        for (const key of this.#temporal.keys(definition.name, state)) {
          // biome-ignore lint/performance/noAwaitInLoops: an escalation dispatches like any other trigger, and a pass that fired several should report every one of them as processed
          fired += await this.#sweepInstance(key, state, constraints, at);
        }
      }

      fired += await this.#sweepStore(definition, byState, at, noted);
    }

    for (const key of this.#settled.keys()) {
      if (!noted.has(key)) {
        this.#settled.delete(key);
      }
    }
    return fired;
  }

  /**
   * Evaluate the instances of an entity that a store holds and this runtime does not.
   *
   * The instances most likely to be stuck are the idle ones, which are the first a memory
   * budget releases, and after a restart nothing is resident at all. So the store is asked
   * the same questions a query asks: who has been in a state for longer than this, and
   * who has not committed for longer than that.
   *
   * One scan per entity for each kind of bound it declares, bounded by the shortest bound
   * of that kind on any of its states, and told which keys are resident so it does not
   * load them. A store that cannot be scanned is reported and the pass moves on, because
   * a sweep on an interval has no caller.
   */
  async #sweepStore(
    definition: AnyDefinition,
    byState: ReadonlyMap<string, readonly CompiledBound[]>,
    at: number,
    noted: Set<string>
  ): Promise<number> {
    const { authority } = this.#stack;
    if (authority === undefined) {
      return 0;
    }

    const skip = new Set<string>();
    for (const state of byState.keys()) {
      for (const key of this.#temporal.keys(definition.name, state)) {
        // Only a record that is current speaks for its key. One another writer has
        // overtaken is passed over by the resident walk, so the store is asked about it.
        if (this.#instances.get(key)?.needsHydration === false) {
          skip.add(key);
        }
      }
    }

    const bounds = [...byState.values()].flat();
    let due: readonly ScanMatch[];
    try {
      due = await this.#scanDue(authority, definition.name, bounds, at, skip);
    } catch (error) {
      this.#onUnhandled(error, { source: "sweep" });
      return 0;
    }

    let fired = 0;
    for (const [state, constraints] of byState) {
      const waiting = due
        .filter(
          (match) =>
            match.state === state &&
            constraints.some((bound) => isPast(bound, match, at))
        )
        .sort(byKey);

      for (const match of waiting) {
        // biome-ignore lint/performance/noAwaitInLoops: stored instances are escalated one at a time, in key order, for the same reason resident ones are
        fired += await this.#sweepStored(
          match,
          definition,
          constraints,
          at,
          noted
        );
      }
    }

    return fired;
  }

  /**
   * Ask a store which instances of an entity could be past one of these bounds.
   *
   * Time in state and time since the last commit are different criteria, and a scan
   * applies every criterion it is given at once, so each kind of bound gets its own scan
   * and the answers are joined by key.
   */
  async #scanDue(
    authority: Store,
    entity: string,
    bounds: readonly CompiledBound[],
    at: number,
    skip: ReadonlySet<string>
  ): Promise<readonly ScanMatch[]> {
    const found = new Map<string, ScanMatch>();

    for (const kind of ["temporal", "stale"] as const) {
      const limits = bounds.filter((bound) => bound.kind === kind).map(limitOf);
      if (limits.length === 0) {
        continue;
      }

      const shortest = Math.min(...limits);
      // biome-ignore lint/performance/noAwaitInLoops: at most two scans, and the second is only worth making once the first has not failed
      const scanned = await this.#scanStore(authority, {
        entity,
        now: at,
        skip,
        ...(kind === "temporal"
          ? { olderThanMs: shortest }
          : { staleForMs: shortest }),
      });
      for (const match of scanned.matches) {
        found.set(match.key, match);
      }

      if (!scanned.complete) {
        // Said out loud, because the instances the store left out are not swept and
        // nothing else would ever mention them.
        this.#onUnhandled(
          new EkmanError(
            "NOT_IMPLEMENTED",
            `store "${authority.name}" answered a scan of ${JSON.stringify(entity)} ` +
              "with part of the answer, and a sweep has no way to ask for the rest. " +
              "Its bounds were evaluated for the instances it returned and " +
              "for no others it holds."
          ),
          { source: "sweep" }
        );
      }
    }

    return [...found.values()];
  }

  /**
   * Load one stored instance that is past a bound, and evaluate it like a resident one.
   *
   * Loading it is the same thing a trigger for an evicted instance does, and the budget
   * sees it the same way: the instance comes back, is told what it is owed, and is
   * released again once idle. The load never creates the key. A scan row can outlive the
   * instance it describes, and a sweep that initialized whatever it could not find would
   * bring a deleted instance back.
   *
   * A load that is refused, by a full budget or by the store, is reported and left for
   * the next pass.
   */
  async #sweepStored(
    match: ScanMatch,
    definition: AnyDefinition,
    constraints: readonly CompiledBound[],
    at: number,
    noted: Set<string>
  ): Promise<number> {
    if (this.#closing.signal.aborted) {
      // Nothing is loaded on behalf of a runtime that is shutting down. Whatever this
      // instance is owed, the next runtime's sweep finds it the same way.
      return 0;
    }

    const { key, state } = match;
    const note = this.#settled.get(key);
    if (
      note !== undefined &&
      note.seq === match.seq &&
      note.enteredAt === match.enteredAt &&
      at < note.dueAt
    ) {
      noted.add(key);
      return 0;
    }

    const forgetting = this.#forgetting.get(key);
    if (forgetting !== undefined) {
      await forgetting;
    }
    if (this.#closing.signal.aborted) {
      return 0;
    }
    const resident = this.#instances.get(key);
    if (resident !== undefined) {
      if (!(resident.needsHydration && resident.idle)) {
        // Current, in which case the next pass finds it there. Or busy, and the trigger
        // it is handling reconciles it.
        return 0;
      }
      // Behind the store with nothing to prompt a reload, so it would sit out every
      // pass. Released, and read back below like any other instance the store holds.
      this.#evict(resident);
    }

    let instance: AnyInstance;
    try {
      const cause = { type: "sweep", id: this.#nextTriggerId() };
      instance = this.#resolveInstance(key, definition, cause, true);
    } catch (error) {
      this.#onUnhandled(error, { source: "sweep", key });
      return 0;
    }

    // Held from before the load until every bound has been read. Nothing is queued on
    // the record, so without this it looks idle throughout: it could be evicted or
    // deleted while it loads, and an escalation's own turn ending would release it with
    // its other bounds still to evaluate.
    const unpin = instance.pin();
    try {
      await this.#hydrate(instance);
      if (
        instance.unloaded ||
        this.#closing.signal.aborted ||
        this.#instances.get(key) !== instance
      ) {
        // Nothing stored after all, or the runtime began to close while it loaded, in
        // which case nothing more is written on its behalf.
        return 0;
      }

      const fired = await this.#sweepInstance(key, state, constraints, at);

      if (instance.state === state && !instance.needsHydration) {
        noted.add(key);
        this.#settled.set(key, {
          seq: instance.seq,
          enteredAt: instance.enteredAt,
          dueAt: nextDue(instance, constraints, at),
        });
      }
      return fired;
    } catch (error) {
      this.#onUnhandled(error, { source: "sweep", key });
      return 0;
    } finally {
      unpin();
      this.#rest(instance);
    }
  }

  /**
   * Offer a record the sweep loaded to eviction, if nothing else has.
   *
   * A record is normally offered when its inbox drains. One the sweep loaded and sent
   * nothing to never ran a turn, so nothing would offer it, and it would stay resident
   * past the budget until some other key went idle.
   */
  #rest(instance: AnyInstance): void {
    // Not while a trigger that arrived in the meantime is still being handled. Its own
    // turn ending is what offers the record then.
    if (instance.idle) {
      this.#onIdle(instance);
    }
  }

  /**
   * Evaluate one instance against the constraints watching the state it is in.
   *
   * Constraints run in declaration order. One is done once its escalation has been
   * answered or refused for good, so an escalation turned away by a full inbox is raised
   * again by the next sweep. The pass ends as soon as the instance has left the state: the
   * remaining constraints watch somewhere it no longer is.
   *
   * @returns how many escalations were raised, delivered or not
   */
  async #sweepInstance(
    key: string,
    state: string,
    constraints: readonly CompiledBound[],
    at: number
  ): Promise<number> {
    let fired = 0;

    for (const constraint of constraints) {
      const aged = this.#ageOf(key, state, at);
      if (aged === undefined) {
        return fired;
      }

      const { instance } = aged;
      // Time in the state for one kind of bound, time since anything was committed for
      // the other. Read again for each bound, since the one before may have committed.
      const elapsedMs =
        constraint.kind === "temporal"
          ? aged.elapsedMs
          : at - instance.lastCommittedAt;
      if (
        elapsedMs < limitOf(constraint) ||
        instance.hasFired(constraint.name)
      ) {
        continue;
      }

      fired += 1;
      // biome-ignore lint/performance/noAwaitInLoops: two constraints on one state fire in declaration order, and the second runs only if the first left the instance where it was
      await this.#escalate(instance, constraint, elapsedMs, at);
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
    entity: string,
    only: string | undefined,
    olderThanMs: number | undefined,
    at: number,
    reading: boolean
  ): Generator<QueryMatch> {
    const states = only === undefined ? this.#temporal.states(entity) : [only];

    for (const state of states) {
      for (const key of this.#temporal.keys(entity, state)) {
        const aged = this.#ageOf(key, state, at);
        if (aged === undefined || (olderThanMs ?? 0) > aged.elapsedMs) {
          continue;
        }

        yield {
          key,
          entity,
          state,
          seq: aged.instance.seq,
          enteredAt: aged.instance.enteredAt,
          ageMs: aged.elapsedMs,
          resident: true,
          lastCommittedAt: aged.instance.lastCommittedAt,
          staleMs: at - aged.instance.lastCommittedAt,
          ...(reading ? { values: aged.instance.values } : {}),
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
   *
   * A match is rebuilt field by field, so values a store returned without being asked
   * never reach an answer that did not ask for them.
   */
  async #scanInto(
    matches: Map<string, QueryMatch>,
    authority: Store,
    entity: string,
    state: string | undefined,
    olderThanMs: number | undefined,
    staleForMs: number | undefined,
    at: number,
    reading: boolean,
    reasons: Set<Partiality>
  ): Promise<void> {
    const result = await this.#scanStore(authority, {
      entity,
      now: at,
      ...(state === undefined ? {} : { state }),
      ...(olderThanMs === undefined ? {} : { olderThanMs }),
      ...(staleForMs === undefined ? {} : { staleForMs }),
      skip: new Set(matches.keys()),
      ...(reading ? { includeValues: true } : {}),
    });

    if (!result.complete) {
      reasons.add("limit-reached");
    }
    if (result.filtered) {
      reasons.add("unsupported-criteria");
    }

    for (const match of result.matches) {
      if (!matches.has(match.key)) {
        matches.set(match.key, {
          key: match.key,
          entity: match.entity,
          state: match.state,
          seq: match.seq,
          enteredAt: match.enteredAt,
          ageMs: at - match.enteredAt,
          resident: false,
          ...(match.lastCommittedAt === undefined
            ? {}
            : {
                lastCommittedAt: match.lastCommittedAt,
                staleMs: at - match.lastCommittedAt,
              }),
          ...(reading ? { values: match.values as Readonly<Values> } : {}),
        });
      }
    }
  }

  /**
   * Scan a store, applying here whatever criteria it could not apply itself.
   *
   * A store that could not filter says so and hands back more than was asked for. The
   * filter is finished here, so a query and a sweep both get exactly the rows they asked
   * about, and `filtered` says that it had to be.
   *
   * What the store declared it cannot do counts as well as what this answer reported, so
   * a store that declares no filter by state and then forgets to say so in an answer is
   * still filtered. The declaration and the answer cannot disagree.
   *
   * Values are finished here in the same way. A store asked for them that returned a match
   * without any has that key loaded, so every match of a scan that asked carries values.
   */
  async #scanStore(
    authority: Store,
    criteria: ScanCriteria
  ): Promise<{
    matches: readonly ScanMatch[];
    complete: boolean;
    filtered: boolean;
  }> {
    const result = await authority.scan(criteria);
    const { state, olderThanMs, staleForMs, now } = criteria;
    const declared = authority.capabilities.scan;
    const unsupported = new Set<ScanFilter>(result.unsupported);
    if (!declared.byState && state !== undefined) {
      unsupported.add("state");
    }
    if (!declared.olderThan && olderThanMs !== undefined) {
      unsupported.add("olderThan");
    }
    if (declared.staleFor !== true && staleForMs !== undefined) {
      unsupported.add("staleFor");
    }

    // What a row already says is settled before anything is loaded. A store that could
    // not filter hands back every instance of the entity, and reading each one's values
    // or last commit only to discard it on its state would replay the whole entity.
    const filtered = unsupported.size > 0;
    const narrowed = filtered
      ? result.matches.filter((match) => isPlaced(match, criteria))
      : result.matches;
    const read = await this.#readMissing(
      authority,
      criteria,
      narrowed,
      unsupported.has("staleFor")
    );
    const matches = unsupported.has("staleFor")
      ? read.filter((match) => isQuiet(match, staleForMs as number, now))
      : read;

    return { matches, complete: result.complete, filtered };
  }

  /**
   * Load whatever a scan needed from a match and a store left off it.
   *
   * Values, when the scan asked for them. And the time of the last commit, when the
   * runtime has to finish a freshness filter the store could not apply and so cannot go
   * by the store's word for which rows passed it.
   *
   * The key can have committed between the scan and this load, so the match is rebuilt
   * whole from what was loaded and held to the criteria again. Laying the loaded values
   * over the scan's row would describe a revision that never existed: one commit's state
   * and sequence with a later commit's values.
   *
   * A match whose key is gone by the time it is loaded was deleted in between, and is
   * dropped: it is no longer an instance.
   */
  async #readMissing(
    authority: Store,
    criteria: ScanCriteria,
    matches: readonly ScanMatch[],
    filteringByLastCommit: boolean
  ): Promise<readonly ScanMatch[]> {
    const lacks = (match: ScanMatch): boolean =>
      (criteria.includeValues === true && match.values === undefined) ||
      (filteringByLastCommit && match.lastCommittedAt === undefined);
    if (!matches.some(lacks)) {
      return matches;
    }

    const read = await Promise.all(
      matches.map(async (match) => {
        if (!lacks(match)) {
          return match;
        }
        const loaded = await authority.load(match.key);
        const current = loaded === undefined ? undefined : replay(loaded);
        if (
          current === undefined ||
          !isPlaced(current, criteria) ||
          !(
            criteria.staleForMs === undefined ||
            isQuiet(current, criteria.staleForMs, criteria.now)
          )
        ) {
          return;
        }
        return {
          key: match.key,
          entity: match.entity,
          state: current.state,
          seq: current.seq,
          enteredAt: current.enteredAt,
          ...(criteria.includeValues === true
            ? { values: current.values }
            : {}),
          ...lastCommitOf(current),
        };
      })
    );
    return read.filter((match) => match !== undefined);
  }

  /**
   * Record a bound's violation and, unless it is only a warning, deliver its escalation.
   *
   * The escalation goes through `send()`, so it queues behind whatever the instance is
   * already doing and dispatches against the state it is in when its turn comes. The
   * runtime never writes state on its own: the state asked for rides on the trigger, as
   * `escalateTo` for a time-in-state bound and `propose` for a freshness bound, and the
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
    constraint: CompiledBound,
    elapsedMs: number,
    at: number
  ): Promise<EscalationOutcome> {
    const owed = instance.undelivered(constraint.name);
    const cause =
      owed === undefined
        ? this.#freshCause(instance, constraint.trigger)
        : { type: constraint.trigger, id: owed };
    const { state } = instance;
    const target =
      constraint.kind === "temporal"
        ? constraint.escalateTo
        : constraint.propose;
    const trigger:
      | TemporalTrigger<string, string>
      | StaleTrigger<string, string> = {
      ...cause,
      constraint: constraint.name,
      state,
      sinceMs: elapsedMs,
      ...(target === undefined
        ? {}
        : {
            [constraint.kind === "temporal" ? "escalateTo" : "propose"]: target,
          }),
    };

    if (owed === undefined) {
      this.#recordBoundViolation(instance, constraint, elapsedMs, at, cause);
    }

    if (constraint.policy === "warn") {
      return "warned";
    }

    let outcome: EscalationOutcome = "delivered";
    try {
      await this.send(instance.key, trigger);
    } catch (error) {
      outcome = refusalOutcome(error);
      this.#onUnhandled(error, { source: "escalation", key: instance.key });
    }
    if (outcome === "refused") {
      // The one ending the stream does not show. A commit or a recorded refusal has
      // settled the bound already, and one turned away for a reason that passes stays
      // owed for the next sweep.
      instance.refused(constraint.name, cause.id);
    }

    this.#emit({
      type: "constraint.escalated",
      key: instance.key,
      entity: instance.entity,
      kind: constraint.kind,
      constraint: constraint.name,
      state,
      elapsedMs,
      escalateTo: target,
      trigger: cause,
      delivered: outcome === "delivered",
      at: telemetryNow(),
    });

    return outcome;
  }

  /**
   * A cause for an escalation raised for the first time.
   *
   * Never one this instance still owes to another bound. Trigger ids start over with each
   * process, so a fresh id can repeat one a previous process left owed, and the commit
   * that answered either escalation would then settle both.
   */
  #freshCause(instance: AnyInstance, type: string): EventCause {
    let cause = { type, id: this.#nextTriggerId() };
    while (instance.owes(cause)) {
      cause = { type, id: this.#nextTriggerId() };
    }
    return cause;
  }

  /** Write a bound's violation to the instance's stream and mirror it in telemetry. */
  #recordBoundViolation(
    instance: AnyInstance,
    constraint: CompiledBound,
    elapsedMs: number,
    at: number,
    cause: { type: string; id: string }
  ): void {
    const reason =
      constraint.kind === "temporal"
        ? `has been in "${constraint.in}" for ${elapsedMs}ms, over its bound of ` +
          `${constraint.within}ms`
        : `has committed nothing for ${elapsedMs}ms, over its bound of ` +
          `${constraint.after}ms`;

    instance.violation({
      violation: {
        kind: constraint.kind,
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
      state: instance.state,
      kind: constraint.kind,
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

  /** A rejection handler that reports to `onUnhandled` with where the failure came from. */
  #unhandled(
    source: UnhandledContext["source"],
    key?: string
  ): (error: unknown) => void {
    const context = key === undefined ? { source } : { source, key };
    return (error) => this.#onUnhandled(error, context);
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
const IN_MEMORY_ONLY: readonly Partiality[] = Object.freeze([
  "resident-only" as const,
]);
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
 * What a rule's condition says about an instance: why it holds, or undefined when it
 * does not. A condition that throws holds, with what it threw as the reason, because a
 * broken condition read as "does not hold" would be a rule that silently never fires.
 */
function heldBy(
  rule: CompiledRule,
  snapshot: InstanceSnapshot
): string | undefined {
  let outcome: boolean | string;
  try {
    outcome = rule.when(snapshot);
  } catch (thrown) {
    return `the condition threw: ${thrownMessage(thrown)}`;
  }
  if (outcome === false) {
    return;
  }
  return typeof outcome === "string" ? outcome : "the condition held";
}

/** Refuse a limit that is not a count. `undefined` means no limit. */
function assertLimit(
  limit: number | undefined,
  what: string,
  everything: string
): void {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${what} must be a non-negative integer, received ${JSON.stringify(limit)}. ` +
        `Omit it to ask for ${everything}.`
    );
  }
}

/** Whether one committed revision of an instance meets a scan's state and age criteria. */
function isPlaced(
  current: { readonly state: string; readonly enteredAt: number },
  criteria: ScanCriteria
): boolean {
  return (
    (criteria.state === undefined || current.state === criteria.state) &&
    (criteria.olderThanMs === undefined ||
      criteria.now - current.enteredAt >= criteria.olderThanMs)
  );
}

/** A match as an answer that did not ask for values shows it. */
function withoutValues(match: QueryMatch): QueryMatch {
  const { values: _values, ...rest } = match;
  return rest;
}

/**
 * Group matches by state. They arrive oldest first, so each state's keys come out oldest
 * first as well. Grouped in a `Map` and then laid into an object with no prototype, so a
 * state with a name an object treats specially is an ordinary entry when present and
 * absent when not.
 */
function stateMap<S extends string>(
  entity: string,
  instances: readonly QueryMatch[],
  reasons: readonly Partiality[],
  sources: readonly string[],
  limitPerState?: number
): StateMap<S> {
  const groups = new Map<string, { count: number; keys: string[] }>();
  let truncated = false;

  for (const { state, key } of instances) {
    let group = groups.get(state);
    if (group === undefined) {
      group = { count: 0, keys: [] };
      groups.set(state, group);
    }
    group.count += 1;
    if (limitPerState === undefined || group.keys.length < limitPerState) {
      group.keys.push(key);
    } else {
      truncated = true;
    }
  }

  const all = new Set(reasons);
  if (truncated) {
    all.add("limit-reached");
  }

  // With no prototype, so a state nothing is in reads as undefined whatever it is called.
  // On an ordinary object `byState.constructor` is a function every object inherits.
  const byState: Record<string, StateMapEntry> = Object.create(null);
  for (const [state, { count, keys }] of groups) {
    byState[state] = Object.freeze({ count, keys: Object.freeze(keys) });
  }

  return Object.freeze({
    entity,
    byState: Object.freeze(byState) as StateMap<S>["byState"],
    total: instances.length,
    complete: all.size === 0,
    reasons: Object.freeze([...all]),
    sources,
  });
}

/**
 * Order scan rows by key, as plain strings, so a pass walks them the same way every time.
 * A store holds a key once, so there is no equal case.
 */
function byKey(a: ScanMatch, b: ScanMatch): number {
  return a.key < b.key ? -1 : 1;
}

/**
 * When a bound on this instance could next have something to say.
 *
 * A bound that has fired has nothing more to say during this stay. One that is owed an
 * escalation is due now. One that has not fired is due when its time is up.
 */
function nextDue(
  instance: AnyInstance,
  constraints: readonly CompiledBound[],
  at: number
): number {
  let dueAt = Number.POSITIVE_INFINITY;
  for (const constraint of constraints) {
    if (instance.hasFired(constraint.name)) {
      continue;
    }
    const since =
      constraint.kind === "temporal"
        ? instance.enteredAt
        : instance.lastCommittedAt;
    const due =
      instance.undelivered(constraint.name) === undefined
        ? since + limitOf(constraint)
        : at;
    dueAt = Math.min(dueAt, due);
  }
  return dueAt;
}

/**
 * Whether a scan row has gone at least this long without a commit. A row whose last
 * commit time the store does not know has not: unknown is not stale.
 */
function isQuiet(
  match: { readonly lastCommittedAt?: number | undefined },
  forMs: number,
  at: number
): boolean {
  return (
    match.lastCommittedAt !== undefined && at - match.lastCommittedAt >= forMs
  );
}

/** Whether a scan row is past a bound, on the clock that bound reads. */
function isPast(bound: CompiledBound, match: ScanMatch, at: number): boolean {
  return bound.kind === "temporal"
    ? at - match.enteredAt >= bound.within
    : isQuiet(match, bound.after, at);
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
  "cache",
  "store",
  "memory",
  "audit",
  "execution",
  "telemetry",
  "now",
  "onUnhandled",
] as const;

const SWEEP_KEYS = ["sweepMs"] as const;

const CACHE_KEYS = ["timeoutMs"] as const;

/**
 * The time bound on a call into a cache layer, refused when a timer could not hold it.
 *
 * There is no way to ask for no bound. A cache that may take forever is the failure the
 * bound exists to contain, and the largest value a timer holds is over three weeks.
 */
function resolveCacheTimeout(cache: CacheConfig | undefined): number {
  const timeoutMs = cache?.timeoutMs ?? DEFAULT_CACHE_TIMEOUT_MS;
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `cache timeoutMs must be a positive number of milliseconds, at most ${MAX_TIMER_MS}, received ${JSON.stringify(timeoutMs)}`
    );
  }
  return timeoutMs;
}

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
  assertKnownKeys("cache", config.cache, CACHE_KEYS);
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

function defaultOnUnhandled(error: unknown, context: UnhandledContext): void {
  const where =
    context.key === undefined
      ? context.source
      : `${context.source} for ${context.key}`;
  console.error(`[ekman] unhandled failure (${where})`, error);
}
