import type { EkmanEvent } from "./events";

/**
 * Audit sinks: copies of committed events, delivered out of band.
 *
 * The one rule is that a sink can never gate a commit. Not veto it, not delay it, not slow
 * it down. A commit that waited on a Kafka round trip would make an audit outage into a
 * write outage, which inverts what auditing is for.
 *
 * Delivery is at-least-once. A sink that throws is retried a bounded number of times and
 * then reported; it is never retried forever, because an unbounded retry queue is just an
 * unbounded queue.
 */
export interface AuditSink {
  readonly name: string;
  /** Deliver one committed event. May reject; the runtime retries and then reports. */
  deliver: (event: EkmanEvent) => void | Promise<void>;
  /**
   * How many delivery attempts this sink gets. Defaults to 3.
   *
   * Bounded on purpose. The runtime is not a durable queue, and pretending otherwise
   * would mean holding events in memory precisely when memory is the constraint.
   */
  readonly maxAttempts?: number;
}

export const DEFAULT_AUDIT_ATTEMPTS = 3;

/**
 * Deliver one event to one sink, retrying a bounded number of times.
 *
 * Returns the failure rather than throwing it, because the caller is a fan-out that must
 * report every sink's outcome and cannot let one failure hide the others.
 */
export async function deliverTo(
  sink: AuditSink,
  event: EkmanEvent
): Promise<Error | undefined> {
  const attempts = sink.maxAttempts ?? DEFAULT_AUDIT_ATTEMPTS;
  let last: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: retries are sequential by definition
      await sink.deliver(event);
      return;
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
  }

  return last;
}
