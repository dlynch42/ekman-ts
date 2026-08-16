import type { AuditSink } from "./audit";
import type { CompiledConstraints, ConstraintsConfig } from "./constraints";
import type { TransitionEvent } from "./events";
import type { MemoryConfig } from "./memory";
import type { ExecutionPolicy } from "./policy";
import type { HistoryResult, QueryCriteria, QueryResult } from "./query";
import type { HandlerResult } from "./results";
import type { Store } from "./store";
// Type-only, and so erased: `telemetry.ts` names `OverflowPolicy` from here, and this
// names `TelemetrySink` from there. Neither import survives compilation, so the cycle
// exists only for the typechecker, which resolves it fine.
import type { TelemetrySink } from "./telemetry";

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
  /**
   * 1 for the first attempt, incrementing for each retry the execution policy allows.
   *
   * Read it to make a handler behave differently on a later try. Do not count with it: it
   * is runtime state, and putting it in committed values makes it domain state.
   */
  readonly attempt: number;
  /**
   * Cooperative cancellation. Handlers that can abort early should watch this.
   *
   * It aborts when the attempt times out. Watching it stays optional, because a handler
   * that ignores it is covered by the fence instead: the attempt's commit token is
   * invalidated at the same moment, so the abandoned handler's eventual result is refused.
   * The signal is the courtesy; the fence is the guarantee.
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
 * A state's handler plus an execution policy that overrides the entity's and the
 * runtime's for this state alone.
 *
 * Written inline where the handler is declared, because how a piece of work is retried
 * and how long it may take belong with the work itself:
 *
 * ```ts
 * states: {
 *   pending: handlePending,
 *   shipping: {
 *     handler: callTheCarrier,
 *     maxAttempts: 5,
 *     timeoutMs: 30_000,
 *     backoff: { kind: "exponential", baseMs: 50 },
 *   },
 * }
 * ```
 *
 * Adding this union member is safe for inference only because every type parameter in
 * the `states` value position is wrapped in `NoInfer`. The value side contributes no
 * inference candidates, so `S` still comes from the keys alone and cannot widen.
 */
export interface StatePolicyConfig<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> extends ExecutionPolicy {
  readonly handler: Handler<S, V, T>;
}

export type StateConfig<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> = Handler<S, V, T> | StatePolicyConfig<S, V, T>;

/** One state's handler with its policy already layered and resolved. */
export interface StateEntry<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  readonly handler: Handler<S, V, T>;
  /** The entity-level policy with this state's override applied. Still unresolved. */
  readonly policy: ExecutionPolicy | undefined;
}

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
    readonly [K in S]: StateConfig<NoInfer<S>, NoInfer<V>, NoInfer<T>>;
  };
  /**
   * Execution policy for every state of this entity, layered over the runtime's own
   * default and under any per-state override.
   */
  readonly policy?: ExecutionPolicy;
  /**
   * Handlers keyed by error classification, with `"*"` as the fallback. Classification
   * is `error.name` unless `classify` says otherwise.
   */
  readonly onError?: Readonly<
    Record<string, ErrorHandler<NoInfer<S>, NoInfer<V>>>
  >;
  readonly classify?: (error: Error) => string;
  /**
   * The strictness dial: transition graph, guards, invariants, and time-in-state bounds,
   * each with its own `reject` / `warn` / `off` policy.
   *
   * Entirely opt-in. An entity that declares none is unconstrained, and one whose
   * constraints are all `off` costs exactly the same.
   */
  readonly constraints?: ConstraintsConfig<NoInfer<S>, NoInfer<V>, NoInfer<T>>;
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
  readonly states: ReadonlyMap<string, StateEntry<S, V, T>>;
  readonly errorHandlers: ReadonlyMap<string, ErrorHandler<S, V>>;
  readonly classify: (error: Error) => string;
  /**
   * Compiled constraints, or undefined when the entity declares none. Constraints set to
   * `off` compile away entirely, so undefined and "all off" are the same fast path.
   */
  readonly constraints: CompiledConstraints<S, V, T> | undefined;
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
  /** The full per-key stream, read through the store when one is configured. */
  history: (id: string) => Promise<HistoryResult<S, V>>;
  /** This entity's instances by state and time in state. */
  query: (criteria?: Omit<QueryCriteria, "entity">) => Promise<QueryResult>;
}

type HandleFor<D> =
  D extends EntityDefinition<string, infer S, infer V, infer T>
    ? EntityHandle<S, V, T>
    : never;

/** Maps a tuple of definitions to `{ [name]: handle }`, preserving each one's types. */
export type EntityHandles<D extends readonly AnyEntityDefinition[]> = {
  readonly [K in D[number]["name"]]: HandleFor<Extract<D[number], { name: K }>>;
};

/**
 * What to do with a trigger arriving at a full inbox. Never silently discards: every
 * policy tells the sender, and every policy is visible in telemetry.
 *
 * - `reject` refuses the arriving trigger and leaves the queue alone. The default,
 *   because it is the only one that pushes back on the producer.
 * - `drop-newest` also refuses the arriving trigger. Identical to `reject` in effect,
 *   named separately so a config reads as a deliberate shedding choice.
 * - `drop-oldest` refuses the longest-waiting trigger to make room, which is what you
 *   want when the freshest trigger carries the most current information.
 */
export type OverflowPolicy = "reject" | "drop-newest" | "drop-oldest";

/**
 * The bounded per-key inbox. One setting for every instance in the runtime.
 *
 * Unbounded queues turn overload into silent latency and unbounded memory, so there is
 * no "unlimited" here on purpose.
 */
export interface InboxConfig {
  /**
   * Queue length. `capacity: 128` means "up to 128 triggers may be waiting".
   *
   * The trigger currently being handled has already left the queue and does not count
   * against it, so `capacity: 0` means no queuing at all: anything arriving while a
   * handler runs meets the overflow policy.
   */
  readonly capacity?: number;
  /** Defaults to `reject`. */
  readonly overflow?: OverflowPolicy;
  /**
   * Also record overflow in the key's event stream, not only in telemetry.
   *
   * Off by default. An overload storm would otherwise grow per-key history without
   * bound at exactly the moment memory is already the problem. Turn it on when you want
   * per-key forensics and can afford the writes.
   */
  readonly recordOverflow?: boolean;
}

/**
 * How temporal constraints are evaluated.
 *
 * Evaluation is a sweep rather than a timer per instance, so one pass costs the states
 * that are actually watched and nothing else. `sweep()` runs a pass on demand; `sweepMs`
 * additionally runs one on an interval.
 */
export interface TemporalConfig {
  /**
   * Milliseconds between automatic sweeps. Omitted means no automatic sweeping, and
   * `sweep()` is the only way a temporal constraint fires.
   *
   * The interval does not hold the process open.
   */
  readonly sweepMs?: number;
}

export interface EkmanConfig<
  D extends readonly AnyEntityDefinition[] = readonly AnyEntityDefinition[],
> {
  /** Entities available from construction. More can be added with `define()`. */
  readonly entities?: D;
  /** Bounded per-key inbox settings. */
  readonly inbox?: InboxConfig;
  /** How often, if ever, temporal constraints are swept for automatically. */
  readonly temporal?: TemporalConfig;
  /**
   * Where commits go. Omitted means memory only, which is a valid documented mode rather
   * than a degraded one: nothing survives the process, and nothing pretends to.
   *
   * A list is a layered stack, read fastest first. Exactly one layer is the commit
   * authority: the last durable one, or the last one when none is durable, unless a layer
   * claims it with `authority: true`. Every other layer is a cache, written after the fact
   * and never able to fail a commit.
   */
  readonly store?: Store | readonly Store[];
  /**
   * The resident memory budget and what happens when it is full.
   *
   * Omitted means unlimited, which is the right setting only when you know your working
   * set. An unbounded map of resident instances is the failure mode this exists to prevent.
   */
  readonly memory?: MemoryConfig;
  /**
   * Sinks receiving copies of committed events, asynchronously and at least once.
   *
   * A sink can never veto or delay a commit. An audit outage must not become a write
   * outage.
   */
  readonly audit?: readonly AuditSink[];
  /**
   * Default execution policy for every handler in the runtime: attempts, timeout, and
   * backoff.
   *
   * An entity may override it with `policy`, and a single state may override that again
   * inline in `states`. Layered field by field, so a narrower override that sets only
   * `timeoutMs` keeps the wider `maxAttempts`.
   */
  readonly execution?: ExecutionPolicy;
  /**
   * Runtime telemetry: queue depth, drops, handler duration. Keyed by event name, with
   * `"*"` as the catch-all.
   *
   * Separate from the per-key event stream on purpose. Nothing here is domain history.
   */
  readonly telemetry?: TelemetrySink;
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
