import { describe, expect, it } from "vitest";
import {
  composeStack,
  EkmanError,
  ERROR_CODES,
  isEkmanError,
} from "../src/errors.js";

describe("EkmanError", () => {
  it("carries a stable code", () => {
    const err = new EkmanError("INVALID_KEY", "bad key");
    expect(err.code).toBe("INVALID_KEY");
    expect(err.message).toBe("bad key");
  });

  it("is a real Error with a useful name and stack", () => {
    const err = new EkmanError("UNKNOWN_STATE", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EkmanError");
    expect(err.stack).toContain("EkmanError");
  });

  it("carries the offending key when there is one", () => {
    const err = new EkmanError("UNKNOWN_STATE", "nope", { key: "orders:1" });
    expect(err.key).toBe("orders:1");
  });

  it("preserves an underlying cause", () => {
    const cause = new TypeError("boom");
    const err = new EkmanError("HANDLER_FAILED", "handler failed", { cause });
    expect(err.cause).toBe(cause);
  });

  it("omits key and cause rather than setting them undefined", () => {
    const err = new EkmanError("INVALID_KEY", "bad key");
    expect("key" in err).toBe(false);
    expect(err.cause).toBeUndefined();
  });

  it("exposes every code the conformance suite asserts on", () => {
    // These strings are shared verbatim with other implementations. Changing one
    // is a breaking change to the conformance suite, not a rename.
    expect([...ERROR_CODES]).toEqual([
      "INVALID_KEY",
      "UNKNOWN_ENTITY",
      "UNKNOWN_STATE",
      "UNKNOWN_TRIGGER",
      "HANDLER_FAILED",
      "INBOX_OVERFLOW",
      "TRIGGER_DROPPED",
      "HANDLER_TIMEOUT",
      "COMMIT_FENCED",
      "CONSTRAINT_VIOLATED",
      "DUPLICATE_ENTITY",
      "DUPLICATE_STATE_HANDLER",
      "MISSING_INITIAL_STATE",
      "INITIAL_STATE_NOT_IN_STATES",
      "INVALID_CONFIG",
      "NOT_IMPLEMENTED",
    ]);
  });
});

describe("isEkmanError", () => {
  it("recognizes an EkmanError", () => {
    expect(isEkmanError(new EkmanError("INVALID_KEY", "x"))).toBe(true);
  });

  it("rejects other errors and non-errors, so a broad catch can branch safely", () => {
    expect(isEkmanError(new TypeError("x"))).toBe(false);
    expect(isEkmanError(new Error("x"))).toBe(false);
    expect(isEkmanError("INVALID_KEY")).toBe(false);
    expect(isEkmanError(null)).toBe(false);
    expect(isEkmanError(undefined)).toBe(false);
    expect(isEkmanError({ code: "INVALID_KEY" })).toBe(false);
  });

  it("narrows to the code without a cast", () => {
    const thrown: unknown = new EkmanError("UNKNOWN_STATE", "x");
    expect(isEkmanError(thrown) ? thrown.code : "not-ekman").toBe(
      "UNKNOWN_STATE"
    );
  });
});

describe("stack capture on engines without captureStackTrace", () => {
  it("still produces a stack headed by the error name", () => {
    // `Error.captureStackTrace` is a V8 extension. The fallback branch is what runs on
    // engines that lack it, so exercise it by taking it away.
    type Capturer = typeof Error.captureStackTrace;
    const ctor = Error as unknown as {
      captureStackTrace?: Capturer | undefined;
    };
    const original = ctor.captureStackTrace;
    // biome-ignore lint/performance/noDelete: the property has to be absent, not undefined, or the fallback branch never runs
    delete ctor.captureStackTrace;

    try {
      const err = new EkmanError("INVALID_KEY", "no capture here");
      expect(err.name).toBe("EkmanError");
      expect(err.stack).toContain("EkmanError: no capture here");
      expect(err.code).toBe("INVALID_KEY");
    } finally {
      ctor.captureStackTrace = original;
    }
  });
});

describe("composeStack", () => {
  it("heads an existing stack with the error name and message", () => {
    expect(composeStack("EkmanError", "bad key", "  at foo\n  at bar")).toBe(
      "EkmanError: bad key\n  at foo\n  at bar"
    );
  });

  it("returns just the header when the engine gave no stack at all", () => {
    expect(composeStack("EkmanError", "bad key", undefined)).toBe(
      "EkmanError: bad key"
    );
  });

  it("does not leave a dangling newline when there is nothing to append", () => {
    expect(composeStack("EkmanError", "bad key", undefined)).not.toContain(
      "\n"
    );
  });
});
