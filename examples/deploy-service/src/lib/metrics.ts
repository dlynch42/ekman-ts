/**
 * Telemetry into whatever this service uses for metrics.
 *
 * In a real service the bodies of these handlers are one line each into StatsD, Prometheus
 * or OpenTelemetry. Here they add up in a map so `/ops/metrics` has something to show.
 *
 * Note what is *not* here: nothing in this file reaches a deployment's history. Queue
 * depth, handler duration, retries and evictions are the runtime's business. The per-key
 * event stream stays domain-only, which is what keeps "what happened to this deployment"
 * readable a year later.
 */

import type { TelemetrySink } from "ekman";

const counters = new Map<string, number>();
const durations: number[] = [];

function inc(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/**
 * Handlers are keyed by event name, so each one's argument is already narrowed. There is
 * no event union to switch on and a misspelled name is a compile error.
 */
export const telemetry: TelemetrySink = {
  "handler.settled": (event) => {
    inc(`handler.settled.${event.outcome}`);
    durations.push(event.durationMs);
  },
  "handler.retried": (event) => {
    inc("handler.retried");
    inc(`retry.${event.entity}`);
  },
  "handler.timedOut": () => inc("handler.timedOut"),

  "inbox.rejected": () => inc("inbox.rejected"),
  "inbox.dropped": () => inc("inbox.dropped"),

  "constraint.violated": (event) => {
    inc("constraint.violated");
    inc(`violation.${event.kind}.${event.constraint}`);
  },
  "constraint.escalated": () => inc("constraint.escalated"),

  "commit.fenced": () => inc("commit.fenced"),
  "commit.raced": () => inc("commit.raced"),

  "instance.evicted": () => inc("instance.evicted"),
  "instance.restored": () => inc("instance.restored"),
  "memory.refused": () => inc("memory.refused"),

  "audit.failed": (event) => inc(`audit.failed.${event.sink}`),
  "store.cacheFailed": (event) => inc(`store.cacheFailed.${event.store}`),

  // Everything not named above. Without this, an event nobody claimed goes nowhere, and
  // the first sign of that is a metric that was always zero.
  "*": (event) => inc(`other.${event.type}`),
};

export function metricsSnapshot(): Record<string, unknown> {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    counters: Object.fromEntries([...counters].sort()),
    handlerDurationMs: {
      count: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1) ?? 0,
    },
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}
