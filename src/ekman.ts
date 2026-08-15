import type { RuntimeDeps } from "./config";
import { resolveInboxConfig } from "./config";
import type { CompiledTemporal } from "./constraints";
import type { DispatchDeps } from "./dispatch";
import { dispatch } from "./dispatch";
import { EkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import { InstanceRecord } from "./instance";
import { parseKey } from "./key";
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

    // Resolved here, at construction, so an unsatisfiable inbox configuration fails at
    // startup rather than at the first overload.
    this.#runtime = {
      now: () => this.#now(),
      telemetry: config.telemetry,
      onUnhandled: (error) => this.#onUnhandled(error),
      inbox: resolveInboxConfig(config.inbox),
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
   * The per-key ordered event stream.
   *
   * Memory-only in this phase, so it covers what this runtime has seen since it started
   * and nothing before that.
   */
  history<S extends string = string, V extends Values = Values>(
    key: string
  ): readonly EkmanEvent<S, V>[] {
    const instance = this.#instances.get(parseKey(key).key);
    return (instance?.events ?? []) as readonly EkmanEvent<S, V>[];
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
    await Promise.resolve();
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

    const instance = new InstanceRecord({
      key,
      entity: definition.name,
      initial: definition.initial,
      initialValues: definition.initialValues,
      at: this.#now(),
      cause: { type: "init", id: trigger.id as string },
      deps: this.#runtime,
    });

    this.#instances.set(key, instance);
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
  #run(
    instance: AnyInstance,
    definition: AnyDefinition,
    trigger: Trigger,
    depth: number
  ): Promise<CommitResult> {
    return dispatch(instance, definition, trigger, this.#deps, depth).then(
      (result) => {
        // Only a move re-indexes. A commit that changed values alone leaves the instance
        // where it was, and its time in state keeps running.
        if (result.event.from !== result.event.to) {
          this.#temporal.enter(instance.key, instance.entity, result.state);
        }
        return result;
      }
    );
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
    const instance = this.#instances.get(key);

    // The index is maintained at commit, so a key found here is in this state. The guard
    // costs nothing and means a future indexing bug degrades into a missed escalation
    // rather than one aimed at the wrong state.
    if (instance === undefined || instance.state !== state) {
      return 0;
    }

    let fired = 0;
    for (const constraint of constraints) {
      const elapsedMs = at - instance.enteredAt;
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

function defaultOnUnhandled(error: unknown): void {
  console.error("[ekman] unhandled failure from post()", error);
}
