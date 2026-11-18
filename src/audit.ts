import { assertKnownKeys } from "./config";
import { EkmanError } from "./errors";
import type { TransitionEvent } from "./events";

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
  /**
   * Deliver one committed event. May reject; the runtime retries and then reports.
   *
   * Commits only: the initialization of an instance and every transition after it. A
   * refused trigger or a constraint violation changed nothing and is not delivered.
   */
  deliver: (event: TransitionEvent) => void | Promise<void>;
  /**
   * How many delivery attempts this sink gets. Defaults to 3.
   *
   * Bounded on purpose. The runtime is not a durable queue, and pretending otherwise
   * would mean holding events in memory precisely when memory is the constraint.
   */
  readonly maxAttempts?: number;
}

export const DEFAULT_AUDIT_ATTEMPTS = 3;

const SINK_KEYS = ["name", "deliver", "maxAttempts"] as const;

/**
 * Refuse an audit sink that could never deliver anything.
 *
 * A sink given zero attempts drops every event without a word, which is the silent failure
 * an audit trail exists to rule out, so it is refused when the runtime is built.
 */
export function assertAuditSink(sink: AuditSink): void {
  const where = `audit sink ${JSON.stringify(sink.name)}`;
  assertKnownKeys(where, sink, SINK_KEYS);

  if (typeof sink.name !== "string" || sink.name.length === 0) {
    throw new EkmanError(
      "INVALID_CONFIG",
      "an audit sink needs a non-empty `name`, which is how a failed delivery is reported"
    );
  }
  if (typeof sink.deliver !== "function") {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${where} has no \`deliver\` function, so it could never receive an event`
    );
  }

  const { maxAttempts } = sink;
  if (
    maxAttempts !== undefined &&
    !(Number.isInteger(maxAttempts) && maxAttempts >= 1)
  ) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${where}: maxAttempts must be an integer of at least 1, received ` +
        `${JSON.stringify(maxAttempts)}. Fewer than one attempt delivers nothing.`
    );
  }
}

/**
 * Deliver one event to one sink, retrying a bounded number of times.
 *
 * Returns the failure rather than throwing it, because the caller is a fan-out that must
 * report every sink's outcome and cannot let one failure hide the others.
 */
export async function deliverTo(
  sink: AuditSink,
  event: TransitionEvent
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
