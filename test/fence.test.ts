import { describe, expect, it } from "vitest";
import type { EkmanError } from "../src/errors";
import {
  assertCommittable,
  CommitToken,
  fenceReason,
  fenceViolation,
} from "../src/fence";

const token = (seq = 0, attempt = 1) =>
  new CommitToken({ key: "orders:1", seq, attempt });

const at = (seq: number) => ({ key: "orders:1", seq });

const WRONG_KEY = /issued for orders:1, not orders:2/;
const INVALIDATED_BY_EVICTED = /invalidated by evicted/;
const INVALIDATED_BY_TIMEOUT = /invalidated by timeout/;
const STALE_SEQUENCE = /observed sequence 3, but the instance is now at 4/;
const ISSUED_FOR_KEY = /issued for orders:1/;

describe("CommitToken", () => {
  it("starts valid", () => {
    const issued = token();
    expect(issued.valid).toBe(true);
    expect(issued.invalidatedBy).toBeUndefined();
  });

  it("records why it was invalidated", () => {
    const issued = token();
    issued.invalidate("timeout");

    expect(issued.valid).toBe(false);
    expect(issued.invalidatedBy).toBe("timeout");
  });

  it("keeps the first reason, because that is the one that explains the outcome", () => {
    const issued = token();
    issued.invalidate("timeout");
    issued.invalidate("superseded");

    // A timed-out attempt is later superseded by the retry that replaced it. To an
    // operator reading telemetry it timed out.
    expect(issued.invalidatedBy).toBe("timeout");
  });
});

describe("fenceViolation", () => {
  it("permits a valid token against the sequence it observed", () => {
    expect(fenceViolation(token(3), at(3))).toBeUndefined();
  });

  it("refuses a token issued for another key", () => {
    expect(fenceViolation(token(0), { key: "orders:2", seq: 0 })).toMatch(
      WRONG_KEY
    );
  });

  it("refuses an invalidated token", () => {
    const issued = token();
    issued.invalidate("evicted");

    expect(fenceViolation(issued, at(0))).toMatch(INVALIDATED_BY_EVICTED);
  });

  it("refuses a token whose sequence has moved on", () => {
    // The case a serialized key cannot produce through the public API: something else
    // committed between dispatch and this commit. The fence catches it anyway.
    expect(fenceViolation(token(3), at(4))).toMatch(STALE_SEQUENCE);
  });

  it("checks the key before the sequence, so the message names the real problem", () => {
    const issued = token(3);
    issued.invalidate("timeout");

    expect(fenceViolation(issued, { key: "orders:2", seq: 9 })).toMatch(
      ISSUED_FOR_KEY
    );
  });
});

describe("assertCommittable", () => {
  it("passes a valid token through", () => {
    expect(() => assertCommittable(token(2), at(2))).not.toThrow();
  });

  it("throws COMMIT_FENCED with the reason attached", () => {
    const issued = token();
    issued.invalidate("timeout");

    try {
      assertCommittable(issued, at(0));
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as EkmanError).code).toBe("COMMIT_FENCED");
      expect((error as EkmanError).key).toBe("orders:1");
      expect((error as Error).message).toMatch(INVALIDATED_BY_TIMEOUT);
    }
  });
});

describe("sealing a token", () => {
  it("starts unsealed", () => {
    expect(token().sealed).toBe(false);
  });

  it("takes ownership and reports success", () => {
    const issued = token();
    expect(issued.seal()).toBe(true);
    expect(issued.sealed).toBe(true);
    expect(issued.valid).toBe(true);
  });

  it("refuses to seal a token that was already invalidated", () => {
    const issued = token();
    issued.invalidate("timeout");

    expect(issued.seal()).toBe(false);
    expect(issued.sealed).toBe(false);
  });

  it("records a late invalidation without acting on it", () => {
    // The write already reached the authority. Refusing to apply it now would leave the
    // store holding an event the runtime never had, which is the worse failure by far.
    const issued = token();
    issued.seal();
    issued.invalidate("timeout");

    expect(issued.valid).toBe(true);
    expect(issued.invalidatedBy).toBeUndefined();
    expect(issued.racedBy).toBe("timeout");
  });

  it("keeps the first thing that arrived late", () => {
    const issued = token();
    issued.seal();
    issued.invalidate("timeout");
    issued.invalidate("superseded");

    expect(issued.racedBy).toBe("timeout");
  });

  it("reports nothing raced when nothing did", () => {
    const issued = token();
    issued.seal();
    expect(issued.racedBy).toBeUndefined();
  });
});

describe("fenceReason", () => {
  it("reports the reason a token was invalidated with", () => {
    const issued = token();
    issued.invalidate("evicted");

    expect(fenceReason(issued)).toBe("evicted");
  });

  it("calls an overtaken but still valid token superseded", () => {
    // Nothing invalidated it; another commit simply moved the sequence past it. On a
    // serialized key that needs a store or a second runtime, so it is unreachable
    // through the public API today and checked here instead.
    expect(fenceReason(token(3))).toBe("superseded");
  });
});
