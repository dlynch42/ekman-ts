import type { AuditSink } from "./audit";
import { assertAuditSink, deliverTo } from "./audit";
import { Caches, DEFAULT_CACHE_TIMEOUT_MS } from "./caches";
import { assertBuilt, constraintsOf } from "./compiled";
import type { CommittedRecord, RuntimeDeps } from "./config";
import { assertKnownKeys, resolveInboxConfig } from "./config";
import type { CompiledRule, RuleTrigger } from "./constraints";
import { thrownMessage } from "./constraints";
import { dispatch } from "./dispatch";
import { EkmanError } from "./errors";
import type { TransitionEvent } from "./events";
import { parseKey } from "./key";
import { resolveMemoryConfig } from "./memory";
import { assertPolicyKeys, MAX_TIMER_MS, resolvePolicy } from "./policy";
import type {
  HistoryResult,
  QueryCriteria,
  QueryResult,
  ReadContext,
  StateMap,
  StateMapOptions,
} from "./query";
import {
  mapStates,
  queryInstances,
  readHistory,
  residentStateMap,
} from "./query";
import type { AnyDefinition, AnyInstance } from "./residency";
import { Residency } from "./residency";
import type { ResolvedStack } from "./stack";
import { assertCoordination, resolveStack } from "./stack";
import type { StorageSweep } from "./store";
import { EMPTY_SEQ } from "./store";
import {
  assertSweepInterval,
  EMPTY_SWEEP,
  PeriodicPass,
  sweepStorageOnce,
  TemporalSweeper,
} from "./sweep";
import type { TelemetryEvent, TelemetrySink } from "./telemetry";
import {
  emit,
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_FALLBACK,
  telemetryNow,
} from "./telemetry";
import type { EscalationOutcome } from "./temporal";
import { freshCause, refusalOutcome } from "./temporal";
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
  readonly #now: () => number;
  readonly #onUnhandled: OnUnhandled;
  readonly #telemetry: TelemetrySink | undefined;
  readonly #runtime: RuntimeDeps;
  /** What is in memory, what it costs, and where each instance sits. */
  readonly #residency: Residency;
  /** What a query, a map and a history read through. */
  readonly #reads: ReadContext;
  readonly #stack: ResolvedStack;
  readonly #caches: Caches;
  readonly #audit: readonly AuditSink[];
  /** Deletions still in progress, by key. A new record for the key waits on its entry before loading. */
  readonly #forgetting = new Map<string, Promise<void>>();
  /** Aborted when `close()` begins. From then on no trigger is accepted and no retry starts. */
  readonly #closing = new AbortController();
  /** The one shutdown every `close()` call shares. */
  #closed: Promise<void> | undefined;
  readonly #sweeper: TemporalSweeper;
  /** The time-in-state pass. Waited for at shutdown, because it loads and records. */
  readonly #temporalPass: PeriodicPass<number>;
  readonly #storagePass: PeriodicPass<StorageSweep>;
  #triggerSeq = 0;

  constructor(config: EkmanConfig<D> = {}) {
    assertRuntimeConfig(config);
    this.#now = config.now ?? Date.now;
    this.#onUnhandled = config.onUnhandled ?? defaultOnUnhandled;
    this.#telemetry = config.telemetry;

    // Everything is resolved here, at construction, so a configuration the stores cannot
    // satisfy fails at startup rather than being discovered under load. A runtime that
    // cannot keep its promises should refuse to start rather than quietly keep fewer.
    this.#stack = resolveStack(config.store);
    assertCoordination(this.#stack, config.coordination);
    const memory = resolveMemoryConfig(config.memory, {
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
      emit: (event) => this.#emit(event),
      onUnhandled: (error, context) => this.#onUnhandled(error, context),
      policy: config.execution,
      reconcile: (instance) => this.#hydrate(instance as AnyInstance),
      closing: this.#closing.signal,
      inbox: resolveInboxConfig(config.inbox),
      stack: this.#stack,
      caches: this.#caches,
      memory,
      audit: (event) => this.#fanOut(event),
      committed: (record, moved) => this.#committed(record, moved),
    };
    this.#residency = new Residency(this.#runtime);
    this.#reads = {
      now: () => this.#now(),
      stack: this.#stack,
      residency: this.#residency,
      known: (entity, key) => {
        this.#definitionFor(entity, key);
      },
    };

    const handles: Record<string, EntityHandle> = {};
    for (const definition of config.entities ?? []) {
      handles[definition.name] = this.#register(definition);
    }
    this.entities = Object.freeze(handles) as EntityHandles<D>;

    this.#sweeper = new TemporalSweeper({
      deps: this.#runtime,
      definitions: this.#definitions,
      residency: this.#residency,
      forgetting: this.#forgetting,
      send: (key, trigger) => this.send(key, trigger),
      nextTriggerId: () => this.#nextTriggerId(),
    });
    const closing = this.#closing.signal;
    this.#temporalPass = new PeriodicPass(
      () => this.#sweeper.once(),
      0,
      closing
    );
    this.#storagePass = new PeriodicPass(
      () => sweepStorageOnce(this.#runtime),
      EMPTY_SWEEP,
      closing
    );

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
    const instance = this.#residency.materialize(key, definition, {
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
    const instance = this.#residency.get(parseKey(key).key);
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
    const instance = this.#residency.get(parsed);

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

    const bytes =
      instance === undefined ? 0 : this.#residency.release(instance);
    this.#sweeper.forget(parsed);

    const deleting = (this.#forgetting.get(parsed) ?? Promise.resolve()).then(
      async () => {
        await instance?.flushed();
        await this.#residency.snapshotting(parsed);

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
      residentBytes: this.#residency.bytes,
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
  history<S extends string = string, V extends Values = Values>(
    key: string
  ): Promise<HistoryResult<S, V>> {
    return readHistory<S, V>(this.#reads, key);
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
  query<S extends string = string, V extends Values = Values>(
    criteria: QueryCriteria<S, V>
  ): Promise<QueryResult<S, V>> {
    return queryInstances<S, V>(this.#reads, criteria);
  }

  /**
   * Where every instance of an entity is: a count and the keys for each state.
   *
   * The same union a query makes, grouped. Resident instances and stored ones are both
   * counted, and the map reports itself incomplete for exactly the reasons a query over
   * the entity would.
   */
  map<S extends string = string>(
    entity: string,
    options: StateMapOptions = {}
  ): Promise<StateMap<S>> {
    return mapStates<S>(this.#reads, entity, options);
  }

  /**
   * The state map of what is in memory, without asking a store.
   *
   * Synchronous and cheap, for a view that refreshes often. Never complete by
   * construction: an evicted instance, or one this runtime has not loaded, is not in it,
   * and the result says so with `resident-only`.
   */
  residentMap<S extends string = string>(entity: string): StateMap<S> {
    return residentStateMap<S>(this.#reads, entity);
  }

  /** Keys of every resident instance. */
  get residentKeys(): readonly string[] {
    return [...this.#residency.keys()];
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
  sweep(): Promise<number> {
    return this.#temporalPass.run();
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
  sweepStorage(): Promise<StorageSweep> {
    return this.#storagePass.run();
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
    this.#temporalPass.stop();
    this.#storagePass.stop();

    const instances = [...this.#residency.instances()];
    const drained = await settledWithin(
      Promise.all([
        ...instances.map((instance) =>
          instance.inbox.whenIdle().then(() => instance.flushed())
        ),
        ...this.#forgetting.values(),
        this.#storagePass.settled,
        this.#temporalPass.settled,
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
    return this.#residency.usage;
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
        this.#runtime.policy,
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
      this.#runtime,
      depth
    );

    this.#residency.account(instance);
    return result;
  }

  /**
   * Keep the indexes in step with a commit a record has just applied, and ask its rules.
   *
   * The record is always the one in the table:
   * a commit is applied inside its key's turn, a busy key is never evicted or forgotten,
   * and an attempt that outlived its turn is fenced before it can apply anything.
   */
  #committed(record: CommittedRecord, moved: boolean): void {
    this.#residency.committed(record, moved);

    const rules = this.#rules.get(record.entity)?.get(record.state);
    if (rules !== undefined) {
      this.#evaluateRules(
        this.#residency.get(record.key) as AnyInstance,
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
        ? freshCause(instance, rule.trigger, () => this.#nextTriggerId())
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
    if (!this.#residency.holds(instance)) {
      // Asked only to load, and the store holds nothing. Or the record was released while
      // it loaded, which only one nothing is queued on can be. Indexing either would
      // leave the ledger and the index holding a key the runtime does not.
      return;
    }

    this.#residency.loaded(instance);
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

    assertSweepInterval(
      sweepMs,
      "temporal",
      "sweep only when sweep() is called"
    );
    this.#temporalPass.every(sweepMs, () => {
      this.sweep().catch(this.#unhandled("sweep"));
    });
  }

  #startStorageSweeping(sweepMs: number | undefined): void {
    if (sweepMs === undefined) {
      return;
    }

    assertSweepInterval(
      sweepMs,
      "storage",
      "reclaim only when sweepStorage() is called"
    );

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

    this.#storagePass.every(sweepMs, () => {
      this.sweepStorage().catch(this.#unhandled("storage-sweep"));
    });
  }

  #emit(event: TelemetryEvent): void {
    emit(this.#telemetry, event, this.#onUnhandled);
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
