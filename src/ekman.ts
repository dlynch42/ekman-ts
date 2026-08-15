import type { RuntimeDeps } from "./config";
import { resolveInboxConfig } from "./config";
import type { DispatchDeps } from "./dispatch";
import { dispatch } from "./dispatch";
import { EkmanError, isEkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import { InstanceRecord } from "./instance";
import { parseKey } from "./key";
import type { TelemetryEvent } from "./telemetry";
import { emit, telemetryNow, triggerRef } from "./telemetry";
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
  #triggerSeq = 0;

  constructor(config: EkmanConfig<D> = {}) {
    this.#now = config.now ?? Date.now;
    this.#onUnhandled = config.onUnhandled ?? defaultOnUnhandled;

    // Resolved here, at construction, so an unsatisfiable inbox configuration fails at
    // startup rather than at the first overload.
    this.#runtime = {
      now: () => this.#now(),
      telemetry: config.telemetry,
      onUnhandled: (error) => this.#onUnhandled(error),
      inbox: resolveInboxConfig(config.inbox),
    };

    // Handlers get a signal from the first attempt so the context shape never changes.
    // Nothing aborts it yet; timeouts wire into it in a later phase.
    this.#deps = {
      now: () => this.#now(),
      signal: new AbortController().signal,
    };

    const handles: Record<string, EntityHandle> = {};
    for (const definition of config.entities ?? []) {
      handles[definition.name] = this.#register(definition);
    }
    this.entities = Object.freeze(handles) as EntityHandles<D>;
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

    this.#triggerSeq += 1;
    return (
      trigger.id === undefined
        ? { ...trigger, id: `t${this.#triggerSeq}` }
        : trigger
    ) as Trigger;
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
   * Run one dequeued trigger, bracketed by telemetry.
   *
   * Duration and attempt count are runtime metadata, so they are measured here and
   * reported to the telemetry sink. None of it reaches the key's event stream.
   */
  async #run(
    instance: AnyInstance,
    definition: AnyDefinition,
    trigger: Trigger,
    depth: number
  ): Promise<CommitResult> {
    // Wall clock, not the injected one: duration is telemetry, and the injected clock
    // belongs to the domain event stream.
    const startedAt = telemetryNow();
    // Captured before dispatch, because a committed result has already moved it on.
    const { state, key, entity } = instance;
    const common = {
      key,
      entity,
      state,
      attempt: 1,
      trigger: triggerRef(trigger),
    };

    this.#emit({ type: "handler.started", ...common, depth, at: startedAt });

    try {
      const result = await dispatch(instance, definition, trigger, this.#deps);
      this.#settled(common, startedAt, "committed");
      return result;
    } catch (error) {
      this.#settled(common, startedAt, outcomeOf(error));
      throw error;
    }
  }

  #settled(
    common: {
      key: string;
      entity: string;
      state: string;
      attempt: number;
      trigger: { type: string; id: string };
    },
    startedAt: number,
    outcome: "committed" | "failed" | "refused"
  ): void {
    const at = telemetryNow();
    this.#emit({
      type: "handler.settled",
      ...common,
      durationMs: at - startedAt,
      outcome,
      at,
    });
  }

  #emit(event: TelemetryEvent): void {
    emit(this.#runtime.telemetry, event, this.#onUnhandled);
  }
}

/**
 * A trigger that never reached a handler was refused, not failed. The distinction is
 * what lets an operator separate "the domain rejected this" from "the handler broke".
 */
function outcomeOf(error: unknown): "failed" | "refused" {
  return isEkmanError(error) &&
    (error.code === "UNKNOWN_STATE" || error.code === "UNKNOWN_TRIGGER")
    ? "refused"
    : "failed";
}

function defaultOnUnhandled(error: unknown): void {
  console.error("[ekman] unhandled failure from post()", error);
}
