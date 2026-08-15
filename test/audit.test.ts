import { describe, expect, it, vi } from "vitest";
import type { AuditSink } from "../src/audit";
import { DEFAULT_AUDIT_ATTEMPTS, deliverTo } from "../src/audit";
import type { EkmanEvent } from "../src/events";

const event: EkmanEvent = Object.freeze({
  type: "transition" as const,
  key: "orders:1",
  from: null,
  to: "open",
  seq: 0,
  at: 0,
  cause: { type: "init", id: "t1" },
  values: {},
});

describe("delivering to an audit sink", () => {
  it("reports nothing when delivery succeeds", async () => {
    const deliver = vi.fn();
    expect(await deliverTo({ name: "ok", deliver }, event)).toBeUndefined();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("accepts a synchronous sink as readily as an async one", async () => {
    const seen: EkmanEvent[] = [];
    const sink: AuditSink = {
      name: "sync",
      deliver: (delivered) => {
        seen.push(delivered);
      },
    };

    expect(await deliverTo(sink, event)).toBeUndefined();
    expect(seen).toEqual([event]);
  });

  it("retries a failing delivery up to the default number of attempts", async () => {
    const deliver = vi.fn(() => {
      throw new Error("nope");
    });

    const failure = await deliverTo({ name: "broken", deliver }, event);

    expect(deliver).toHaveBeenCalledTimes(DEFAULT_AUDIT_ATTEMPTS);
    expect(failure?.message).toBe("nope");
  });

  it("stops as soon as an attempt succeeds", async () => {
    let attempts = 0;
    const sink: AuditSink = {
      name: "flaky",
      deliver: () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("not yet");
        }
      },
    };

    expect(await deliverTo(sink, event)).toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("honours a per-sink attempt limit", async () => {
    const deliver = vi.fn(() => Promise.reject(new Error("nope")));
    await deliverTo({ name: "once", deliver, maxAttempts: 1 }, event);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("returns the failure rather than throwing it", async () => {
    // The caller is a fan-out across sinks: one sink throwing must not hide the others.
    const result = deliverTo(
      {
        name: "broken",
        deliver: () => {
          throw new Error("nope");
        },
      },
      event
    );

    await expect(result).resolves.toBeInstanceOf(Error);
  });

  it("wraps a sink that rejects with something that is not an Error", async () => {
    const failure = await deliverTo(
      { name: "rude", deliver: () => Promise.reject("just a string") },
      event
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe("just a string");
  });
});
