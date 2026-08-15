import { beforeEach, describe, expect, it } from "vitest";
import { TemporalIndex } from "../src/temporal";

describe("TemporalIndex", () => {
  let index: TemporalIndex;

  beforeEach(() => {
    index = new TemporalIndex();
  });

  it("starts empty", () => {
    expect(index.size).toBe(0);
    expect(index.keys("orders", "pending")).toEqual([]);
    expect(index.states("orders")).toEqual([]);
  });

  it("records where a key sits", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:2", "orders", "pending");

    expect(index.keys("orders", "pending")).toEqual(["orders:1", "orders:2"]);
    expect(index.size).toBe(2);
  });

  it("moves a key rather than listing it twice", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:1", "orders", "approved");

    expect(index.keys("orders", "pending")).toEqual([]);
    expect(index.keys("orders", "approved")).toEqual(["orders:1"]);
    expect(index.size).toBe(1);
  });

  it("puts a re-entering key at the back, so entries stay oldest first", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:2", "orders", "pending");
    index.enter("orders:1", "orders", "approved");
    index.enter("orders:1", "orders", "pending");

    // orders:1 entered `pending` most recently, so it sorts after orders:2 even though it
    // was there first. Time in state restarts on re-entry.
    expect(index.keys("orders", "pending")).toEqual(["orders:2", "orders:1"]);
  });

  it("keeps entities apart", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("carts:1", "carts", "pending");

    expect(index.keys("orders", "pending")).toEqual(["orders:1"]);
    expect(index.states("carts")).toEqual(["pending"]);
  });

  it("drops a key entirely", () => {
    index.enter("orders:1", "orders", "pending");
    index.remove("orders:1");

    expect(index.size).toBe(0);
    expect(index.keys("orders", "pending")).toEqual([]);
  });

  it("forgets a state once its last key leaves", () => {
    index.enter("orders:1", "orders", "pending");
    index.enter("orders:2", "orders", "pending");
    index.remove("orders:1");

    expect(index.states("orders")).toEqual(["pending"]);

    index.remove("orders:2");
    expect(index.states("orders")).toEqual([]);
  });

  it("ignores removal of a key it never held", () => {
    expect(() => index.remove("orders:404")).not.toThrow();
    expect(index.size).toBe(0);
  });
});
