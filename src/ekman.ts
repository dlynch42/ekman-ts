import type { AuditSink } from "./audit";
import { deliverTo } from "./audit";
import type { RuntimeDeps } from "./config";
import { resolveInboxConfig } from "./config";
import type { CompiledTemporal } from "./constraints";
import type { DispatchDeps } from "./dispatch";
import { dispatch } from "./dispatch";
import { EkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import { InstanceRecord } from "./instance";
import { parseKey } from "./key";
import type { ResolvedMemoryConfig } from "./memory";
import { MemoryLedger, resolveMemoryConfig } from "./memory";
import type {
  HistoryResult,
  Partiality,
  QueryCriteria,
  QueryMatch,
  QueryResult,
} from "./query";
import { mergeRestores, parseDuration } from "./query";
import type { ResolvedStack } from "./stack";
import { resolveStack } from "./stack";
import type { Store } from "./store";
import type { TelemetryEvent } from "./telemetry";
import { emit, telemetryNow } from "./telemetry";
import { TemporalIndex } from "./temporal";
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
  readonly #memory: ResolvedMemoryConfig;
  readonly #audit: readonly AuditSink[];
  /** What is resident and what it costs, in least-recently-used order. */
  readonly #ledger = new MemoryLedger();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Declared here and assigned in the constructor rather than initialized inline. An
   * inline `= false` narrows the field to the literal `false`, after which the re-entry
   * guard that reads it looks statically dead. The inbox's `#running` carries the same
   * note for the same reason.
   */
  #sweeping: boolean;
  #triggerSeq = 0;

  constructor(config: EkmanConfig<D> = {}) {
    this.#now = config.now ?? Date.now;
    this.#onUnhandled = config.onUnhandled ?? defaultOnUnhandled;
    this.#sweeping = false;

    // Everything is resolved here, at construction, so a configuration the stores cannot
    // satisfy fails at startup rather than being discovered under load. A runtime that
    // cannot keep its promises should refuse to start rather than quietly keep fewer.
    this.#stack = resolveStack(config.store);
    this.#memory = resolveMemoryConfig(config.memory, {
      hasStore: this.#stack.authority !== undefined,
    });
    this.#audit = config.audit ?? [];

    this.#runtime = {
      now: () => this.#now(),
      telemetry: config.telemetry,
      onUnhandled: (error) => this.#onUnhandled(error),
      inbox: resolveInboxConfig(config.inbox),
      stack: this.#stack,
      memory: this.#memory,
      audit: (event) => this.#fanOut(event),
    };

    this.#deps = {
      now: () => this.#now(),
      policy: config.execution,
      emit: (event) => this.#emit(event),
    };

    const handles: Record<string, EntityHandle> = {};
    for (const definition of config.entities ?? []) {
      handles[definition.name] = this.#register(definition);
    }
    this.entities = Object.freeze(handles) as EntityHandles<D>;

    this.#startSweeping(config.temporal?.sweepMs);
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
   * Deliver a trigger to the instance at `key`.
   *
   * Resolves at commit with the committed state, values and sequence. Rejects with an
   * `EkmanError` if the key is malformed, the entity is unregistered, the trigger is
   * refused, or the handler fails.
   */
  async send<S extends string = string, V extends Values = Values>(
    key: string,
    trigger: Trigger
  ): Promise<CommitResult<S, V>> {
    const parsed = parseKey(key);
    const definition = this.#definitions.get(parsed.entity);

    if (definition === undefined) {
      throw new EkmanError(
        "UNKNOWN_ENTITY",
        `key ${JSON.stringify(key)} names entity "${parsed.entity}", which is not registered. ` +
          `Registered: ${this.entityNames.join(", ") || "(none)"}`,
        { key }
      );
    }

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
    return instance?.snapshot() as InstanceSnapshot<S, V> | undefined;
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
    const parsed = parseKey(key).key;
    const instance = this.#instances.get(parsed);
    const { authority } = this.#stack;

    if (authority === undefined) {
      return Object.freeze({
        key: parsed,
        events: (instance?.events ?? []) as readonly EkmanEvent<S, V>[],
        complete: false,
        reasons: NO_DURABLE_STORE,
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

    return Object.freeze({
      key: parsed,
      // Restores are never persisted, so they are woven back in here. Without that, a
      // stream read after a reload would give no sign that anything was reloaded.
      events: mergeRestores(
        stored,
        (instance?.events ?? []) as readonly EkmanEvent<S, V>[]
      ),
      complete: this.#stack.durable,
      reasons: this.#stack.durable ? NONE : NO_DURABLE_STORE,
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
    const ordered = [...matches.values()].sort(byAgeThenKey);
    const limited =
      criteria.limit === undefined ? ordered : ordered.slice(0, criteria.limit);

    if (limited.length < ordered.length) {
      reasons.add("limit-reached");
    }

    return Object.freeze({
      instances: Object.freeze(limited),
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
    if (this.#sweeping) {
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
   * Release what the runtime is holding: currently the automatic sweep interval.
   *
   * Safe to call more than once. A runtime that was never given a `sweepMs` still has one
   * of these, so shutdown code does not have to know how it was configured.
   */
  async close(): Promise<void> {
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }

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

  #register(definition: AnyDefinition): EntityHandle {
    const existing = this.#definitions.get(definition.name);

    if (existing !== undefined) {
      throw new EkmanError(
        "DUPLICATE_ENTITY",
        `entity "${definition.name}" is already registered with this runtime`
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
      at: this.#now(),
      cause: { type: "init", id: trigger.id as string },
      deps: this.#runtime,
      onIdle: () => this.#onIdle(),
    });

    this.#instances.set(key, instance);
    this.#ledger.record(key, instance.bytes);
    // Initialization is an entry into the initial state, so the clock on time-in-state
    // starts here rather than at the first transition.
    this.#temporal.enter(key, definition.name, definition.initial);
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

    return this.#hydrate(instance).then(() =>
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

    // Only a move re-indexes. A commit that changed values alone leaves the instance where
    // it was, and its time in state keeps running.
    if (result.event.from !== result.event.to) {
      this.#temporal.enter(instance.key, instance.entity, result.state);
    }

    this.#account(instance);
    return result;
  }

  /** Reconcile an instance with the store, reporting a reload when one happened. */
  async #hydrate(instance: AnyInstance): Promise<void> {
    const before = instance.events.length;
    await instance.ready();

    const restored = instance.events
      .slice(before)
      .find((event) => event.type === "restored");

    if (restored !== undefined && restored.type === "restored") {
      this.#temporal.enter(instance.key, instance.entity, instance.state);
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
   * Record what an instance costs and act on the budget.
   *
   * Runs after every commit, which is where the number changes and where the serialized
   * values needed to measure it already exist.
   */
  #account(instance: AnyInstance): void {
    this.#ledger.record(instance.key, instance.bytes);
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
  #onIdle(): void {
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
    for (const key of this.#ledger.lru) {
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

  #evict(instance: AnyInstance): void {
    const { authority } = this.#stack;
    // Gated on a store existing, not on it being durable. Snapshotting into an ephemeral
    // store is worth doing: it is exactly what the next in-process reload reads.
    const snapshotted = this.#memory.snapshotOnEvict && authority !== undefined;

    if (snapshotted) {
      // Not awaited: the snapshot is an optimization for the next load, and the events it
      // summarizes are already in the store. A failed snapshot costs replay time, never
      // state.
      authority
        .snapshot(instance.key, instance.storeSnapshot(this.#now()))
        .catch(this.#onUnhandled);
    }

    const bytes = this.#ledger.release(instance.key);
    this.#instances.delete(instance.key);
    this.#temporal.remove(instance.key);

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
   */
  #fanOut(event: EkmanEvent): void {
    for (const sink of this.#audit) {
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

    this.#writeCaches(event);
  }

  /**
   * Mirror an event into the cache layers.
   *
   * After the authority, never awaited, and a failure is reported rather than raised. The
   * commit is already durable by this point, so a stale cache is a performance problem.
   * Treating it as a commit failure would turn it into a correctness one.
   */
  #writeCaches(event: EkmanEvent): void {
    for (const cache of this.#stack.caches) {
      cache.append(event.key, event, previousSeq(event)).catch((error) => {
        this.#emit({
          type: "store.cacheFailed",
          key: event.key,
          entity: parseKey(event.key).entity,
          store: cache.name,
          error: (error as Error).message,
          seq: event.seq,
          at: telemetryNow(),
        });
      });
    }
  }

  #startSweeping(sweepMs: number | undefined): void {
    if (sweepMs === undefined) {
      return;
    }

    if (!(Number.isFinite(sweepMs) && sweepMs > 0)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `temporal sweepMs must be a positive number of milliseconds, received ${JSON.stringify(sweepMs)}. ` +
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

  /** Evaluate one instance against the constraints watching the state it is in. */
  async #sweepInstance(
    key: string,
    state: string,
    constraints: readonly CompiledTemporal[],
    at: number
  ): Promise<number> {
    const aged = this.#ageOf(key, state, at);
    if (aged === undefined) {
      return 0;
    }

    const { instance, elapsedMs } = aged;
    let fired = 0;

    for (const constraint of constraints) {
      if (elapsedMs < constraint.within || instance.hasFired(constraint.name)) {
        continue;
      }

      instance.markFired(constraint.name);
      fired += 1;
      // biome-ignore lint/performance/noAwaitInLoops: two constraints on one state fire in declaration order, and the second observes what the first produced
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
    if (instance === undefined || instance.state !== state) {
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
   */
  async #escalate(
    instance: AnyInstance,
    constraint: CompiledTemporal,
    elapsedMs: number,
    at: number
  ): Promise<void> {
    // Allocated even for a warning, so the recorded violation always has a cause that can
    // be traced, and so the counter advances identically under either policy.
    const id = this.#nextTriggerId();
    const trigger = {
      type: constraint.trigger,
      id,
      constraint: constraint.name,
      state: constraint.in,
      sinceMs: elapsedMs,
      ...(constraint.escalateTo === undefined
        ? {}
        : { escalateTo: constraint.escalateTo }),
    } as Trigger;

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
      cause: { type: constraint.trigger, id },
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
      trigger: { type: constraint.trigger, id },
      at: telemetryNow(),
    });

    if (constraint.policy === "warn") {
      return;
    }

    let delivered = true;
    try {
      await this.send(instance.key, trigger);
    } catch (error) {
      // An escalation that cannot be delivered is itself worth knowing about: the usual
      // cause is that the state an instance is stuck in has no handler, which is exactly
      // the situation the constraint was watching for.
      delivered = false;
      this.#onUnhandled(error);
    }

    this.#emit({
      type: "constraint.escalated",
      key: instance.key,
      entity: instance.entity,
      constraint: constraint.name,
      state: constraint.in,
      elapsedMs,
      escalateTo: constraint.escalateTo,
      trigger: { type: constraint.trigger, id },
      delivered,
      at: telemetryNow(),
    });
  }

  #emit(event: TelemetryEvent): void {
    emit(this.#runtime.telemetry, event, this.#onUnhandled);
  }
}

const NONE: readonly Partiality[] = Object.freeze([]);
const NO_DURABLE_STORE: readonly Partiality[] = Object.freeze([
  "no-durable-store" as const,
]);
const RESIDENT_ONLY: readonly string[] = Object.freeze(["resident"]);

/**
 * Oldest first, which is the order the question is asked in: "what has been stuck longest".
 * Ties break on the key so a limited answer is the same answer twice.
 */
function byAgeThenKey(a: QueryMatch, b: QueryMatch): number {
  return b.ageMs - a.ageMs || a.key.localeCompare(b.key);
}

function defaultOnUnhandled(error: unknown): void {
  console.error("[ekman] unhandled failure from post()", error);
}

/**
 * What a cache append is conditional on.
 *
 * A commit is conditional on the sequence before it, so a cache that has fallen behind
 * refuses the write rather than accepting a hole. Anything else carries the current
 * sequence, because it does not advance one.
 */
function previousSeq(event: EkmanEvent): number {
  return event.type === "transition" ? event.seq - 1 : event.seq;
}
