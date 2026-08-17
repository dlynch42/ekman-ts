/**
 * Runtime telemetry: queue depth, drops, handler duration, retries, timeouts, and
 * fenced commits.
 *
 * This is deliberately a different stream from the per-key event stream. That one is the
 * domain's: transitions, refusals, and violations, ordered per key and replayable.
 * This one is the runtime's, and none of it ever reaches a key's history.
 *
 * The `type` strings are the cross-implementation contract. Every port emits these names
 * with these fields; how a port lets you subscribe is its own business.
 */
import type { ConstraintKind } from "./events";
import type { FenceReason } from "./fence";
import type { OverflowPolicy } from "./types";

/** The `"*"` key: receives any event no named handler claimed. */
export const TELEMETRY_FALLBACK = "*";

/** What every telemetry event carries. */
interface TelemetryBase {
  readonly key: string;
  readonly entity: string;
  readonly at: number;
}

/** Enough of a trigger to correlate a telemetry event with a stream event. */
export interface TriggerRef {
  readonly type: string;
  readonly id: string;
}

/** A trigger was accepted into an instance's inbox. `depth` is measured after the push. */
export interface InboxEnqueuedEvent extends TelemetryBase {
  readonly type: "inbox.enqueued";
  readonly depth: number;
  readonly capacity: number;
  readonly trigger: TriggerRef;
}

/** A trigger was refused because the inbox was full and the policy is `reject`. */
export interface InboxRejectedEvent extends TelemetryBase {
  readonly type: "inbox.rejected";
  readonly depth: number;
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  readonly trigger: TriggerRef;
}

/**
 * A trigger was dropped because the inbox was full.
 *
 * `dropped` says which end went: `newest` is the arriving trigger, `oldest` is the one
 * that had been waiting longest. `trigger` is always the one that was dropped, not the
 * one that arrived.
 */
export interface InboxDroppedEvent extends TelemetryBase {
  readonly type: "inbox.dropped";
  readonly dropped: "newest" | "oldest";
  readonly depth: number;
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  readonly trigger: TriggerRef;
}

/** A handler attempt began. `depth` is what was still queued behind it. */
export interface HandlerStartedEvent extends TelemetryBase {
  readonly type: "handler.started";
  readonly state: string;
  readonly attempt: number;
  readonly depth: number;
  readonly trigger: TriggerRef;
}

/**
 * A trigger finished being processed.
 *
 * `refused` means it never reached a handler: an unrecognized trigger type, or a state
 * with no handler.
 */
export interface HandlerSettledEvent extends TelemetryBase {
  readonly type: "handler.settled";
  readonly state: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly outcome: "committed" | "failed" | "refused";
  readonly trigger: TriggerRef;
}

/** An attempt failed and another will be made. `delayMs` is the wait before it. */
export interface HandlerRetriedEvent extends TelemetryBase {
  readonly type: "handler.retried";
  readonly state: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly error: string;
  readonly trigger: TriggerRef;
}

/**
 * An attempt ran past its timeout and was abandoned.
 *
 * The handler itself may still be running: this says the runtime stopped waiting and
 * fenced the attempt, not that the function stopped executing.
 */
export interface HandlerTimedOutEvent extends TelemetryBase {
  readonly type: "handler.timedOut";
  readonly state: string;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly trigger: TriggerRef;
}

/**
 * A superseded attempt finished and tried to commit. Its result was discarded.
 *
 * This is the fence doing its job, and seeing it is normal in a system with timeouts. A
 * sustained rate of it means handlers are outliving their timeouts.
 */
export interface CommitFencedEvent extends TelemetryBase {
  readonly type: "commit.fenced";
  readonly attempt: number;
  readonly reason: FenceReason;
  /** The sequence the fenced attempt observed when it was dispatched. */
  readonly tokenSeq: number;
  /** Where the instance actually is now. */
  readonly currentSeq: number;
  readonly trigger: TriggerRef;
}

/**
 * A constraint did not hold.
 *
 * The authoritative record of this is the violation event in the key's own stream. This is
 * the mirror an operator alerts on, because a rising rate of violations is a runtime
 * signal even when each individual one is a domain fact. Telemetry never travels the other
 * way: nothing in this file reaches a key's history.
 */
export interface ConstraintViolatedEvent extends TelemetryBase {
  readonly type: "constraint.violated";
  readonly kind: ConstraintKind;
  readonly constraint: string;
  /** `warn` means the commit went ahead regardless. */
  readonly policy: "reject" | "warn";
  /** The state the instance was in when the constraint was checked. */
  readonly state: string;
  readonly reason: string;
  readonly trigger: TriggerRef;
}

/**
 * A temporal constraint fired and its escalation trigger was delivered.
 *
 * Separate from the violation itself because delivery can fail on its own: the instance
 * may have no handler for the state it is stuck in, which is precisely the situation a
 * temporal constraint is there to surface.
 */
export interface ConstraintEscalatedEvent extends TelemetryBase {
  readonly type: "constraint.escalated";
  readonly constraint: string;
  readonly state: string;
  /** How long the instance had been in the state when it fired. */
  readonly elapsedMs: number;
  readonly escalateTo: string | undefined;
  readonly trigger: TriggerRef;
  readonly delivered: boolean;
}

/**
 * A commit reached the authority and a timeout arrived while it was in flight.
 *
 * The commit stands, because it is already durable. The sender was told the attempt timed
 * out, so this is the record of the two crossing. Rare and worth watching: a sustained rate
 * means timeouts are set close to how long the store actually takes.
 */
export interface CommitRacedEvent extends TelemetryBase {
  readonly type: "commit.raced";
  readonly attempt: number;
  readonly reason: FenceReason;
  /** The sequence the commit landed at. */
  readonly seq: number;
  readonly trigger: TriggerRef;
}

/** An instance was released to stay inside the memory budget. */
export interface InstanceEvictedEvent extends TelemetryBase {
  readonly type: "instance.evicted";
  readonly state: string;
  readonly seq: number;
  /** What it was accounted at, freed by this eviction. */
  readonly bytes: number;
  readonly snapshotted: boolean;
  /** Resident bytes after the release. */
  readonly residentBytes: number;
}

/**
 * An instance was deleted outright: resident state and every store layer.
 *
 * Distinct from `instance.evicted`, and the distinction matters. Eviction releases memory
 * and keeps the truth; this destroys it. An operator reading one stream should never have
 * to guess which of the two happened.
 */
export interface InstanceForgottenEvent extends TelemetryBase {
  readonly type: "instance.forgotten";
  /** The state it was in when it was forgotten. */
  readonly state: string;
  /** The sequence it had reached. */
  readonly seq: number;
  /** What it was accounted at, freed by this deletion. Zero if it was not resident. */
  readonly bytes: number;
  /** Whether the key was resident at the time, as opposed to only on disk. */
  readonly resident: boolean;
  /** Resident bytes after the release. */
  readonly residentBytes: number;
}

/** An instance was rebuilt from the store because a trigger arrived for it. */
export interface InstanceRestoredEvent extends TelemetryBase {
  readonly type: "instance.restored";
  readonly state: string;
  readonly seq: number;
  readonly from: "snapshot" | "replay";
  readonly replayed: number;
}

/**
 * Resident accounting after a commit.
 *
 * `overBudget` is what an operator alerts on: under `none` it is the only signal that the
 * working set has outgrown its allowance, because nothing else will happen.
 */
export interface MemoryAccountedEvent extends TelemetryBase {
  readonly type: "memory.accounted";
  readonly bytes: number;
  readonly residentBytes: number;
  readonly residentCount: number;
  /** `null` when the budget is unlimited. */
  readonly maxBytes: number | null;
  readonly overBudget: boolean;
}

/** A new instance was refused because the budget is full and the policy is `reject`. */
export interface MemoryRefusedEvent extends TelemetryBase {
  readonly type: "memory.refused";
  readonly residentBytes: number;
  readonly maxBytes: number;
}

/**
 * An audit sink could not be delivered to, after its retries.
 *
 * Never affects the commit, which happened regardless. This is the whole of what
 * "at-least-once, and told about it when not" means in practice.
 */
export interface AuditFailedEvent extends TelemetryBase {
  readonly type: "audit.failed";
  readonly sink: string;
  readonly error: string;
  readonly seq: number;
}

/** A cache layer could not be written. The commit is unaffected; the layer is now stale. */
export interface StoreCacheFailedEvent extends TelemetryBase {
  readonly type: "store.cacheFailed";
  readonly store: string;
  readonly error: string;
  readonly seq: number;
}

export type TelemetryEvent =
  | InboxEnqueuedEvent
  | InboxRejectedEvent
  | InboxDroppedEvent
  | HandlerStartedEvent
  | HandlerSettledEvent
  | HandlerRetriedEvent
  | HandlerTimedOutEvent
  | CommitFencedEvent
  | CommitRacedEvent
  | ConstraintViolatedEvent
  | ConstraintEscalatedEvent
  | InstanceEvictedEvent
  | InstanceForgottenEvent
  | InstanceRestoredEvent
  | MemoryAccountedEvent
  | MemoryRefusedEvent
  | AuditFailedEvent
  | StoreCacheFailedEvent;

export type TelemetryEventType = TelemetryEvent["type"];

/**
 * Where telemetry goes: a map from event name to handler, each one precisely typed, plus
 * `"*"` for everything no named handler claimed.
 *
 * Resolution is specific-then-fallback, the same rule `onError` uses with
 * `ERROR_FALLBACK`. An event is delivered to exactly one handler.
 *
 * ```ts
 * telemetry: {
 *   "inbox.dropped":   (e) => metrics.inc("ekman.inbox.dropped", { which: e.dropped }),
 *   "handler.settled": (e) => metrics.observe("ekman.handler.ms", e.durationMs),
 *   "*":               (e) => log.debug(e.type, e.key),
 * }
 * ```
 *
 * A handler is any function that accepts its event, so a plain reference works and the
 * arrow is only needed when the event has to be reshaped into someone else's arguments:
 *
 * ```ts
 * telemetry: {
 *   "handler.settled": recordHandlerDuration,   // (e: HandlerSettledEvent) => void
 *   "*":               console.log,
 * }
 * ```
 */
export type TelemetrySink = {
  readonly [K in TelemetryEventType]?: (
    event: Extract<TelemetryEvent, { type: K }>
  ) => void;
} & {
  readonly [TELEMETRY_FALLBACK]?: (event: TelemetryEvent) => void;
};

/**
 * Deliver one telemetry event.
 *
 * A sink that throws must not be able to break the dispatch that emitted the event, so
 * its failure is routed out the same way a `post()` failure is. Telemetry observes the
 * runtime; it never gates it.
 */
export function emit(
  sink: TelemetrySink | undefined,
  event: TelemetryEvent,
  onUnhandled: (error: unknown) => void
): void {
  if (sink === undefined) {
    return;
  }

  const handler = sink[event.type] ?? sink[TELEMETRY_FALLBACK];
  if (handler === undefined) {
    return;
  }

  try {
    (handler as (delivered: TelemetryEvent) => void)(event);
  } catch (error) {
    onUnhandled(error);
  }
}

/**
 * Wall-clock stamp for a telemetry event.
 *
 * Deliberately *not* the runtime's injected clock. That clock exists to make the domain
 * event stream deterministic, and a scenario asserts on the `at` it produces. If
 * telemetry drew from it too, every telemetry event added in a later phase would shift
 * the timestamps in the domain stream, and a second implementation would have to match
 * this one's internal count of clock reads for the shared scenarios to pass.
 *
 * Two streams, two time sources. Domain history is reproducible; telemetry is wall time.
 */
export function telemetryNow(): number {
  return Date.now();
}

/** The correlating half of a trigger, for telemetry that should not carry a payload. */
export function triggerRef(trigger: {
  type: string;
  id?: string | undefined;
}): TriggerRef {
  return { type: trigger.type, id: trigger.id as string };
}
