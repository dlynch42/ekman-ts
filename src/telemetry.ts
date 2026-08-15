/**
 * Runtime telemetry: queue depth, drops, handler duration, and later retries, timeouts
 * and fenced commits.
 *
 * This is deliberately a different stream from the per-key event stream. That one is the
 * domain's: transitions, refusals, and violations, ordered per key and replayable.
 * This one is the runtime's, and none of it ever reaches a key's history.
 *
 * The `type` strings are the cross-implementation contract. Every port emits these names
 * with these fields; how a port lets you subscribe is its own business.
 */
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
  readonly maxQueued: number;
  readonly trigger: TriggerRef;
}

/** A trigger was refused because the inbox was full and the policy is `reject`. */
export interface InboxRejectedEvent extends TelemetryBase {
  readonly type: "inbox.rejected";
  readonly depth: number;
  readonly maxQueued: number;
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
  readonly maxQueued: number;
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

export type TelemetryEvent =
  | InboxEnqueuedEvent
  | InboxRejectedEvent
  | InboxDroppedEvent
  | HandlerStartedEvent
  | HandlerSettledEvent;

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
 * ```ts
 * telemetry: {
 *   "inbox.dropped":   metrics.inc("ekman.inbox.dropped", { which: e.dropped }),
 *   "handler.settled": metrics.observe("ekman.handler.ms", e.durationMs),
 *   "*":               log.debug(e.type, e.key),
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

/** The correlating half of a trigger, for telemetry that should not carry a payload. */
export function triggerRef(trigger: {
  type: string;
  id?: string | undefined;
}): TriggerRef {
  return { type: trigger.type, id: trigger.id as string };
}
