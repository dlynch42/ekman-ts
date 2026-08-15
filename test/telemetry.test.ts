import { describe, expect, it, vi } from "vitest";
import type { TelemetryEvent, TelemetrySink } from "../src/telemetry";
import {
  emit,
  TELEMETRY_FALLBACK,
  telemetryNow,
  triggerRef,
} from "../src/telemetry";

const dropped: TelemetryEvent = {
  type: "inbox.dropped",
  key: "orders:1",
  entity: "orders",
  dropped: "oldest",
  depth: 1,
  capacity: 1,
  overflow: "drop-oldest",
  trigger: { type: "go", id: "t1" },
  at: 1000,
};

const unhandled = () => vi.fn();

describe("emit", () => {
  it("does nothing when no sink is configured", () => {
    expect(() => emit(undefined, dropped, unhandled())).not.toThrow();
  });

  it("delivers to the handler named for the event type", () => {
    const onDropped = vi.fn();
    emit({ "inbox.dropped": onDropped }, dropped, unhandled());

    expect(onDropped).toHaveBeenCalledWith(dropped);
  });

  it("falls back to the catch-all when no named handler claims the event", () => {
    const catchAll = vi.fn();
    emit({ [TELEMETRY_FALLBACK]: catchAll }, dropped, unhandled());

    expect(catchAll).toHaveBeenCalledWith(dropped);
  });

  it("prefers the named handler, so an event reaches exactly one", () => {
    const onDropped = vi.fn();
    const catchAll = vi.fn();

    emit(
      { "inbox.dropped": onDropped, [TELEMETRY_FALLBACK]: catchAll },
      dropped,
      unhandled()
    );

    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(catchAll).not.toHaveBeenCalled();
  });

  it("drops the event when nothing is listening for it", () => {
    const other = vi.fn();
    emit({ "handler.settled": other }, dropped, unhandled());

    expect(other).not.toHaveBeenCalled();
  });

  it("routes a throwing sink out rather than letting it break the caller", () => {
    const onUnhandled = vi.fn();
    const boom = new Error("sink exploded");
    const sink: TelemetrySink = {
      "inbox.dropped": () => {
        throw boom;
      },
    };

    // Telemetry observes the runtime. A broken observer must not take down the
    // dispatch that reported to it.
    expect(() => emit(sink, dropped, onUnhandled)).not.toThrow();
    expect(onUnhandled).toHaveBeenCalledWith(boom);
  });
});

describe("telemetryNow", () => {
  it("reads wall time, not the runtime's injectable clock", () => {
    const before = Date.now();
    const stamp = telemetryNow();

    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });
});

describe("triggerRef", () => {
  it("keeps only what correlates a telemetry event with a stream event", () => {
    expect(
      triggerRef({
        type: "approve",
        id: "t7",
        secret: "do not log me",
      } as never)
    ).toEqual({ type: "approve", id: "t7" });
  });
});
