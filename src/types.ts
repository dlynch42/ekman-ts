import type { EkmanEvent, TransitionEvent } from "./events";
import type { HandlerResult } from "./results";

/** An instance's state-local data. Must be serializable. */
export type Values = Record<string, unknown>;

/** The minimum a trigger must be: something with a `type` the runtime can classify. */
export interface TriggerLike {
  readonly type: string;
  /**
   * Optional caller-supplied id. When absent the runtime assigns one, so every event's
   * cause is traceable back to the trigger that produced it.
   */
  readonly id?: string;
}

/** A trigger with an arbitrary payload alongside its `type`. */
export type Trigger = TriggerLike & { readonly [key: string]: unknown };

/**
 * What a handler sees: the current committed state and values, frozen.
 *
 * Mutating `values` does nothing useful. Return `stay(next)` or `transitionTo(s, next)`
 * to change them.
 */
export interface InstanceSnapshot<
  S extends string = string,
  V extends Values = Values,
> {
  readonly key: string;
  readonly entity: string;
  readonly state: S;
  readonly values: Readonly<V>;
  readonly seq: number;
}

export interface HandlerContext {
  readonly key: string;
  readonly entity: string;
  /** 1 for the first attempt. Retries are a later phase; this is always 1 for now. */
  readonly attempt: number;
  /**
   * Cooperative cancellation. Handlers that can abort early should watch this.
   *
   * It never aborts yet. Timeouts arrive in a later phase, and when they do the fence
   * covers handlers that ignore this signal, so watching it stays optional.
   */
  readonly signal: AbortSignal;
}

export type Handler<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> = (
  instance: InstanceSnapshot<S, V>,
  trigger: T,
  ctx: HandlerContext
) => HandlerResult<S, V> | Promise<HandlerResult<S, V>>;

export type ErrorHandler<
  S extends string = string,
  V extends Values = Values,
> = (
  instance: InstanceSnapshot<S, V>,
  error: Error,
  ctx: HandlerContext
) => HandlerResult<S, V> | Promise<HandlerResult<S, V>>;

/**
 * What to do with a trigger nothing handles. Never silently discards.
 *
 * `reject` refuses the trigger, records the refusal in the key's event stream, and
 * rejects the sender's promise.
 */
export type UnknownPolicy = "reject";

/** The fallback key in an `onError` map: matches any classification. */
export const ERROR_FALLBACK = "*";

export interface EntityConfig<
  S extends string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  /** The one state a new instance starts in. Must have a handler in `states`. */
  readonly initial: NoInfer<S>;
  /** Values a new instance starts with. Omitted means `{}`. */
  readonly values?: V;
  /** Defaults to `reject`. */
  readonly unknown?: UnknownPolicy;
  /**
   * Trigger types this entity recognizes. Omitted means every type is recognized and
   * only a state with no handler reaches the unknown policy.
   */
  readonly triggers?: readonly string[];
  /**
   * Exactly one handler per state. Exhaustive over `S`.
   *
   * Every type parameter is wrapped in `NoInfer`, and each one earns it:
   *
   * - `S`: without it `S` sits in both the key and the value position of this mapped
   *   type, TypeScript cannot resolve the circularity, and the state union widens to
   *   `string`. Blocking the value position leaves the keys as the sole source.
   * - `V`: a handler returning `stay()` with no arguments offers `never` as a candidate,
   *   so an entity whose handlers all omit values would infer `V` as `never` and give
   *   its handlers an unusable `instance.values`. Values come from `values` alone.
   * - `T`: an unannotated handler parameter offers the bare constraint, which has no
   *   index signature, so `trigger.actor` would not compile. Blocking it lets the
   *   default apply instead.
   */
  readonly states: {
    readonly [K in S]: Handler<NoInfer<S>, NoInfer<V>, NoInfer<T>>;
  };
  /**
   * Handlers keyed by error classification, with `"*"` as the fallback. Classification
   * is `error.name` unless `classify` says otherwise.
   */
  readonly onError?: Readonly<
    Record<string, ErrorHandler<NoInfer<S>, NoInfer<V>>>
  >;
  readonly classify?: (error: Error) => string;
  /**
   * Not implemented yet. Setting it throws `NOT_IMPLEMENTED` rather than being quietly
   * ignored, so a config that looks like it constrains something actually does.
   */
  readonly constraints?: unknown;
}

/** A validated, runtime-free entity definition. Safe to share across runtimes. */
export interface EntityDefinition<
  N extends string = string,
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  readonly name: N;
  readonly initial: S;
  readonly initialValues: Readonly<V>;
  readonly unknownPolicy: UnknownPolicy;
  /** Null means every trigger type is recognized. */
  readonly triggers: ReadonlySet<string> | null;
  readonly states: ReadonlyMap<string, Handler<S, V, T>>;
  readonly errorHandlers: ReadonlyMap<string, ErrorHandler<S, V>>;
  readonly classify: (error: Error) => string;
  /** Build a full key from an id, without needing a runtime. */
  key: (id: string) => string;
}

/** Any definition, for positions that hold a heterogeneous list of them. */
// biome-ignore lint/suspicious/noExplicitAny: a heterogeneous list of definitions has no narrower common type, because `unknown` fails in the contravariant handler positions these feed
export type AnyEntityDefinition = EntityDefinition<string, any, any, any>;

/** What a committed `send()` resolves to. */
export interface CommitResult<
  S extends string = string,
  V extends Values = Values,
> {
  readonly key: string;
  readonly state: S;
  readonly values: Readonly<V>;
  readonly seq: number;
  readonly event: TransitionEvent<S, V>;
}

/**
 * An entity bound to a runtime. Addresses instances by id rather than by full key, so
 * callers stop building key strings by hand.
 */
export interface EntityHandle<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  readonly name: string;
  key: (id: string) => string;
  /** Resolves at commit. Rejects on a failed handler or a refused trigger. */
  send: (id: string, trigger: T) => Promise<CommitResult<S, V>>;
  /** Fire and forget. Wraps `send` and swallows nothing: failures surface as telemetry. */
  post: (id: string, trigger: T) => void;
  inspect: (id: string) => InstanceSnapshot<S, V> | undefined;
  history: (id: string) => readonly EkmanEvent<S, V>[];
}

type HandleFor<D> =
  D extends EntityDefinition<string, infer S, infer V, infer T>
    ? EntityHandle<S, V, T>
    : never;

/** Maps a tuple of definitions to `{ [name]: handle }`, preserving each one's types. */
export type EntityHandles<D extends readonly AnyEntityDefinition[]> = {
  readonly [K in D[number]["name"]]: HandleFor<Extract<D[number], { name: K }>>;
};

export interface EkmanConfig<
  D extends readonly AnyEntityDefinition[] = readonly AnyEntityDefinition[],
> {
  /** Entities available from construction. More can be added with `define()`. */
  readonly entities?: D;
  /** Time source, in milliseconds. Defaults to `Date.now`. Injected by tests. */
  readonly now?: () => number;
  /**
   * Where a failure from `post()` goes. There is no caller to reject, and dropping it
   * silently is exactly the failure mode this runtime exists to prevent.
   *
   * Defaults to logging on stderr. Replace it to route into your own telemetry.
   */
  readonly onUnhandled?: (error: unknown) => void;
}
