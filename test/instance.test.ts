import { describe, expect, it } from "vitest";
import { EkmanError } from "../src/errors";
import { isTransitionEvent } from "../src/events";
import { InstanceRecord, sealValues } from "../src/instance";

const make = (values: Record<string, unknown> = {}) =>
  // Widened on purpose: these tests commit to states beyond the initial one.
  new InstanceRecord<string, Record<string, unknown>>({
    key: "orders:1",
    entity: "orders",
    initial: "pending",
    initialValues: Object.freeze(values),
    at: 1000,
    cause: { type: "init", id: "t1" },
  });

describe("InstanceRecord", () => {
  it("starts at sequence zero with an initialization event", () => {
    const instance = make();

    expect(instance.state).toBe("pending");
    expect(instance.seq).toBe(0);
    expect(instance.events).toHaveLength(1);
    expect(instance.events[0]).toMatchObject({
      from: null,
      to: "pending",
      seq: 0,
      at: 1000,
    });
  });

  it("exposes a frozen snapshot", () => {
    const snapshot = make({ a: 1 }).snapshot();

    expect(snapshot).toEqual({
      key: "orders:1",
      entity: "orders",
      state: "pending",
      values: { a: 1 },
      seq: 0,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("advances the sequence by exactly one per commit", () => {
    const instance = make();

    instance.commit({
      state: "approved",
      values: {},
      at: 2000,
      cause: { type: "approve", id: "t2" },
    });
    instance.commit({
      state: "shipped",
      values: {},
      at: 3000,
      cause: { type: "ship", id: "t3" },
    });

    expect(instance.seq).toBe(2);
    expect(instance.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("applies state, values, sequence and event together", () => {
    const instance = make();
    const event = instance.commit({
      state: "approved",
      values: Object.freeze({ by: "amy" }),
      at: 2000,
      cause: { type: "approve", id: "t2" },
    });

    expect(instance.state).toBe("approved");
    expect(instance.values).toEqual({ by: "amy" });
    expect(instance.seq).toBe(event.seq);
    expect(instance.events.at(-1)).toBe(event);
  });

  it("records the state it moved from", () => {
    const instance = make();
    const event = instance.commit({
      state: "approved",
      values: {},
      at: 2000,
      cause: { type: "a", id: "t2" },
    });
    expect(event.from).toBe("pending");
  });

  it("records a rejection without advancing the sequence", () => {
    const instance = make();
    instance.commit({
      state: "approved",
      values: {},
      at: 2000,
      cause: { type: "a", id: "t2" },
    });
    instance.reject({
      code: "UNKNOWN_STATE",
      reason: "no handler",
      at: 3000,
      cause: { type: "x", id: "t3" },
    });

    expect(instance.seq).toBe(1);
    expect(instance.events).toHaveLength(3);
    expect(instance.events[2]).toMatchObject({
      type: "rejected",
      seq: 1,
      code: "UNKNOWN_STATE",
    });
  });

  it("keeps seq non-decreasing across a stream that mixes commits and rejections", () => {
    const instance = make();
    instance.reject({
      code: "UNKNOWN_TRIGGER",
      reason: "x",
      at: 1,
      cause: { type: "x", id: "t2" },
    });
    instance.commit({
      state: "approved",
      values: {},
      at: 2,
      cause: { type: "a", id: "t3" },
    });
    instance.reject({
      code: "UNKNOWN_STATE",
      reason: "y",
      at: 3,
      cause: { type: "y", id: "t4" },
    });

    const seqs = instance.events.map((e) => e.seq);
    expect(seqs).toEqual([0, 0, 1, 1]);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("leaves only transition events for replay", () => {
    const instance = make();
    instance.commit({
      state: "approved",
      values: {},
      at: 2,
      cause: { type: "a", id: "t2" },
    });
    instance.reject({
      code: "UNKNOWN_STATE",
      reason: "y",
      at: 3,
      cause: { type: "y", id: "t3" },
    });

    const replayed = instance.events.filter(isTransitionEvent);
    expect(replayed.at(-1)?.to).toBe("approved");
  });

  it("tracks whether a handler is running, which is what eviction will need", () => {
    const instance = make();
    expect(instance.idle).toBe(true);

    instance.markActive();
    expect(instance.idle).toBe(false);

    instance.markIdle();
    expect(instance.idle).toBe(true);
  });
});

describe("sealValues", () => {
  it("copies, so a later mutation of the source cannot reach committed state", () => {
    const source = { by: "amy", nested: { deep: 1 } };
    const sealed = sealValues(source, "orders:1");

    source.by = "mallory";
    source.nested.deep = 99;

    expect(sealed).toEqual({ by: "amy", nested: { deep: 1 } });
  });

  it("freezes the result", () => {
    expect(Object.isFrozen(sealValues({ a: 1 }, "orders:1"))).toBe(true);
  });

  it("refuses values that cannot be serialized, naming the key", () => {
    try {
      sealValues({ fn: () => 1 }, "orders:1");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EkmanError);
      expect((err as EkmanError).code).toBe("HANDLER_FAILED");
      expect((err as EkmanError).key).toBe("orders:1");
    }
  });
});
