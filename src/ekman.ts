import { dispatch } from "./dispatch"
import type { DispatchDeps } from "./dispatch"
import { EkmanError } from "./errors"
import type { EkmanEvent } from "./events"
import { InstanceRecord } from "./instance"
import { parseKey } from "./key"
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
} from "./types"

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyInstance = InstanceRecord<any, any>
type AnyDefinition = EntityDefinition<string, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  readonly entities: EntityHandles<D>

  readonly #definitions = new Map<string, AnyDefinition>()
  readonly #instances = new Map<string, AnyInstance>()
  readonly #now: () => number
  readonly #onUnhandled: (error: unknown) => void
  readonly #deps: DispatchDeps
  #triggerSeq = 0

  constructor(config: EkmanConfig<D> = {}) {
    this.#now = config.now ?? Date.now
    this.#onUnhandled = config.onUnhandled ?? defaultOnUnhandled

    // Handlers get a signal from the first attempt so the context shape never changes.
    // Nothing aborts it yet; timeouts wire into it in a later phase.
    this.#deps = { now: () => this.#now(), signal: new AbortController().signal }

    const handles: Record<string, EntityHandle> = {}
    for (const definition of config.entities ?? []) {
      handles[definition.name] = this.#register(definition)
    }
    this.entities = Object.freeze(handles) as EntityHandles<D>
  }

  /**
   * Register an entity after construction and get its handle.
   *
   * Safe while the runtime is dispatching: it only adds to the registry, so no in-flight
   * handler is affected.
   */
  define<N extends string, S extends string, V extends Values, T extends TriggerLike>(
    definition: EntityDefinition<N, S, V, T>,
  ): EntityHandle<S, V, T> {
    // The registry is heterogeneous, so the handle comes back erased. The definition's
    // own type parameters are the truth here.
    return this.#register(definition) as unknown as EntityHandle<S, V, T>
  }

  /** Every registered entity name, in registration order. */
  get entityNames(): readonly string[] {
    return [...this.#definitions.keys()]
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
    trigger: Trigger,
  ): Promise<CommitResult<S, V>> {
    const parsed = parseKey(key)
    const definition = this.#definitions.get(parsed.entity)

    if (definition === undefined) {
      throw new EkmanError(
        "UNKNOWN_ENTITY",
        `key ${JSON.stringify(key)} names entity "${parsed.entity}", which is not registered. ` +
          `Registered: ${this.entityNames.join(", ") || "(none)"}`,
        { key },
      )
    }

    const normalized = this.#normalizeTrigger(trigger, key)
    const instance = this.#resolveInstance(key, definition, normalized)

    return this.#enqueue(instance, definition, normalized) as Promise<CommitResult<S, V>>
  }

  /**
   * Fire and forget. Wraps `send`.
   *
   * A failure here has no caller to reject, so it goes to `onUnhandled` rather than
   * disappearing. Silence is the one thing this runtime should never do.
   */
  post(key: string, trigger: Trigger): void {
    void this.send(key, trigger).catch(this.#onUnhandled)
  }

  /** Current committed state, or undefined if nothing has addressed this key yet. */
  inspect<S extends string = string, V extends Values = Values>(
    key: string,
  ): InstanceSnapshot<S, V> | undefined {
    const instance = this.#instances.get(parseKey(key).key)
    return instance?.snapshot() as InstanceSnapshot<S, V> | undefined
  }

  /**
   * The per-key ordered event stream.
   *
   * Memory-only in this phase, so it covers what this runtime has seen since it started
   * and nothing before that.
   */
  history<S extends string = string, V extends Values = Values>(
    key: string,
  ): readonly EkmanEvent<S, V>[] {
    const instance = this.#instances.get(parseKey(key).key)
    return (instance?.events ?? []) as readonly EkmanEvent<S, V>[]
  }

  /** Keys of every resident instance. */
  get residentKeys(): readonly string[] {
    return [...this.#instances.keys()]
  }

  #register(definition: AnyDefinition): EntityHandle {
    const existing = this.#definitions.get(definition.name)

    if (existing !== undefined) {
      throw new EkmanError(
        "DUPLICATE_ENTITY",
        `entity "${definition.name}" is already registered with this runtime`,
      )
    }

    this.#definitions.set(definition.name, definition)
    return this.#makeHandle(definition)
  }

  #makeHandle(definition: AnyDefinition): EntityHandle {
    return Object.freeze({
      name: definition.name,
      key: (id: string) => definition.key(id),
      send: (id: string, trigger: Trigger) => this.send(definition.key(id), trigger),
      post: (id: string, trigger: Trigger) => this.post(definition.key(id), trigger),
      inspect: (id: string) => this.inspect(definition.key(id)),
      history: (id: string) => this.history(definition.key(id)),
    }) as EntityHandle
  }

  /**
   * A trigger needs a type to be classified and an id to be traceable. The id is
   * assigned from a per-runtime counter when the caller does not supply one, which keeps
   * event causes deterministic.
   */
  #normalizeTrigger(trigger: Trigger, key: string): Trigger {
    if (typeof trigger !== "object" || trigger === null) {
      throw new EkmanError(
        "UNKNOWN_TRIGGER",
        `trigger for ${key} must be an object with a "type", received ${typeof trigger}`,
        { key },
      )
    }

    if (typeof trigger.type !== "string" || trigger.type.length === 0) {
      throw new EkmanError(
        "UNKNOWN_TRIGGER",
        `trigger for ${key} must have a non-empty string "type"`,
        { key },
      )
    }

    this.#triggerSeq += 1
    return (
      trigger.id === undefined ? { ...trigger, id: `t${this.#triggerSeq}` } : trigger
    ) as Trigger
  }

  /** Load or lazily initialize the instance. Initialization is a commit at sequence 0. */
  #resolveInstance(key: string, definition: AnyDefinition, trigger: Trigger): AnyInstance {
    const existing = this.#instances.get(key)
    if (existing !== undefined) return existing

    const instance = new InstanceRecord({
      key,
      entity: definition.name,
      initial: definition.initial,
      initialValues: definition.initialValues,
      at: this.#now(),
      cause: { type: "init", id: trigger.id as string },
    })

    this.#instances.set(key, instance)
    return instance
  }

  /**
   * Take a turn in this key's serializer chain.
   *
   * The caller's promise carries the real outcome. The chain itself is kept
   * non-rejecting so one failed trigger cannot poison the triggers queued behind it.
   */
  #enqueue(
    instance: AnyInstance,
    definition: AnyDefinition,
    trigger: Trigger,
  ): Promise<CommitResult> {
    const turn = instance.tail.then(() => {
      instance.markActive()
      return dispatch(instance, definition, trigger, this.#deps).finally(() => {
        instance.markIdle()
      })
    })

    instance.tail = turn.then(ignore, ignore)
    return turn as Promise<CommitResult>
  }
}

function ignore(): void {}

function defaultOnUnhandled(error: unknown): void {
  console.error("[ekman] unhandled failure from post()", error)
}
