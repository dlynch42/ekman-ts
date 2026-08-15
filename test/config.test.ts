import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_QUEUED, resolveInboxConfig } from "../src/config";
import { EkmanError } from "../src/errors";

describe("resolveInboxConfig", () => {
  it("defaults to a bounded inbox that rejects on overflow", () => {
    expect(resolveInboxConfig(undefined)).toEqual({
      maxQueued: DEFAULT_MAX_QUEUED,
      overflow: "reject",
      recordOverflow: false,
    });
  });

  it("keeps what the caller set", () => {
    expect(
      resolveInboxConfig({
        maxQueued: 4,
        overflow: "drop-oldest",
        recordOverflow: true,
      })
    ).toEqual({ maxQueued: 4, overflow: "drop-oldest", recordOverflow: true });
  });

  it("allows a maxQueued of zero, meaning no backlog at all", () => {
    expect(resolveInboxConfig({ maxQueued: 0 }).maxQueued).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a maxQueued of %s rather than reinterpreting it",
    (maxQueued) => {
      try {
        resolveInboxConfig({ maxQueued });
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
