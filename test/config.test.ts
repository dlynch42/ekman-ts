import { describe, expect, it } from "vitest";
import { DEFAULT_CAPACITY, resolveInboxConfig } from "../src/config";
import { EkmanError } from "../src/errors";

describe("resolveInboxConfig", () => {
  it("defaults to a bounded inbox that rejects on overflow", () => {
    expect(resolveInboxConfig(undefined)).toEqual({
      capacity: DEFAULT_CAPACITY,
      overflow: "reject",
      recordOverflow: false,
    });
  });

  it("keeps what the caller set", () => {
    expect(
      resolveInboxConfig({
        capacity: 4,
        overflow: "drop-oldest",
        recordOverflow: true,
      })
    ).toEqual({ capacity: 4, overflow: "drop-oldest", recordOverflow: true });
  });

  it("allows a capacity of zero, meaning no backlog at all", () => {
    expect(resolveInboxConfig({ capacity: 0 }).capacity).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a capacity of %s rather than reinterpreting it",
    (capacity) => {
      try {
        resolveInboxConfig({ capacity });
        throw new Error("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EkmanError);
        expect((error as EkmanError).code).toBe("INVALID_CONFIG");
      }
    }
  );

  it("refuses an unrecognized overflow policy", () => {
    try {
      resolveInboxConfig({ overflow: "explode" as never });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as EkmanError).code).toBe("INVALID_CONFIG");
      expect((error as Error).message).toContain("drop-oldest");
    }
  });

  it("is frozen, so a resolved config cannot drift under the runtime", () => {
    expect(Object.isFrozen(resolveInboxConfig(undefined))).toBe(true);
  });
});
