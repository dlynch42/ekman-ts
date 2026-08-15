import { describe, expect, it } from "vitest";
import {
  fail,
  isFail,
  isHandlerResult,
  isStay,
  isTransitionTo,
  stay,
  transitionTo,
} from "../src/results.js";

describe("transitionTo", () => {
  it("carries the target state and values", () => {
    expect(transitionTo("approved", { by: "amy" })).toEqual({
      kind: "transitionTo",
      state: "approved",
      values: { by: "amy" },
    });
  });

  it("omits values when not given, meaning carry the current ones forward", () => {
    const result = transitionTo("approved");
    expect(result).toEqual({ kind: "transitionTo", state: "approved" });
    expect("values" in result).toBe(false);
  });

  it("is frozen so a handler cannot mutate it after returning", () => {
    expect(Object.isFrozen(transitionTo("approved"))).toBe(true);
  });
});

describe("stay", () => {
  it("carries values", () => {
    expect(stay({ attempt: 2 })).toEqual({
      kind: "stay",
      values: { attempt: 2 },
    });
  });

  it("omits values when not given", () => {
    const result = stay();
    expect(result).toEqual({ kind: "stay" });
    expect("values" in result).toBe(false);
  });
});

describe("fail", () => {
  it("carries an Error as given", () => {
    const error = new TypeError("boom");
    expect(fail(error)).toEqual({ kind: "fail", error });
  });

  it("wraps a string into an Error so the failure path always has one", () => {
    const result = fail("nope");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe("nope");
  });

  it("wraps a thrown non-error value without losing it", () => {
    const result = fail({ weird: true });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.cause).toEqual({ weird: true });
  });
});

describe("guards", () => {
  it("narrow each result kind", () => {
    expect(isTransitionTo(transitionTo("a"))).toBe(true);
    expect(isTransitionTo(stay())).toBe(false);
    expect(isStay(stay())).toBe(true);
    expect(isFail(fail("x"))).toBe(true);
    expect(isFail(stay())).toBe(false);
  });

  it("recognizes any well-formed result and nothing else", () => {
    expect(isHandlerResult(transitionTo("a"))).toBe(true);
    expect(isHandlerResult(stay())).toBe(true);
    expect(isHandlerResult(fail("x"))).toBe(true);
    expect(isHandlerResult(undefined)).toBe(false);
    expect(isHandlerResult(null)).toBe(false);
    expect(isHandlerResult({ kind: "somethingElse" })).toBe(false);
    expect(isHandlerResult("approved")).toBe(false);
  });
});

describe("fail with awkward values", () => {
  it("describes a circular object instead of throwing while building the error", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    const result = fail(circular);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.cause).toBe(circular);
  });

  it("keeps a bigint failure reportable", () => {
    const result = fail(10n);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.cause).toBe(10n);
  });
});

describe("fail with values JSON cannot represent", () => {
  it("falls back to String() when stringify yields undefined", () => {
    // JSON.stringify returns undefined (rather than throwing) for a function.
    const result = fail(function orphaned() {
      // The body is irrelevant: what matters is that a function is not stringifiable.
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain("orphaned");
  });

  it("handles a symbol the same way", () => {
    const result = fail(Symbol("nope"));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain("Symbol(nope)");
  });
});
