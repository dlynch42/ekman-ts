import { describe, expect, it } from "vitest";
import { Ekman } from "../src/ekman";
import { EkmanError } from "../src/errors";
import {
  assertPolicyKeys,
  backoffDelay,
  DEFAULT_POLICY,
  defaultRetryable,
  MAX_TIMER_MS,
  resolvePolicy,
} from "../src/policy";

const resolve = (
  global: Parameters<typeof resolvePolicy>[0],
  override?: Parameters<typeof resolvePolicy>[1]
) => resolvePolicy(global, override, 'entity "orders" state "pending"');

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as EkmanError).code;
  }
  throw new Error("expected a throw");
};

describe("resolvePolicy", () => {
  it("defaults to a single attempt with no timeout", () => {
    const policy = resolve(undefined, undefined);
    expect(policy.maxAttempts).toBe(1);
    expect(policy.timeoutMs).toBeUndefined();
  });

  it("layers field by field, so a narrow override keeps the wider settings", () => {
    // The property that makes three levels of policy usable: setting only a timeout on
    // one state must not silently revert that state to one attempt.
    const policy = resolve({ maxAttempts: 5 }, { timeoutMs: 200 });

    expect(policy.maxAttempts).toBe(5);
    expect(policy.timeoutMs).toBe(200);
  });

  it("lets the narrower level win where both set the same field", () => {
    expect(resolve({ maxAttempts: 5 }, { maxAttempts: 2 }).maxAttempts).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "refuses maxAttempts of %s",
    (maxAttempts) => {
      expect(codeOf(() => resolve({ maxAttempts }))).toBe("INVALID_CONFIG");
    }
  );

  it.each([0, -5])("refuses a timeout of %s", (timeoutMs) => {
    expect(codeOf(() => resolve({ timeoutMs }))).toBe("INVALID_CONFIG");
  });

  it("refuses a negative or non-finite backoff delay", () => {
    expect(
      codeOf(() => resolve({ backoff: { kind: "fixed", delayMs: -1 } }))
    ).toBe("INVALID_CONFIG");
    expect(
      codeOf(() =>
        resolve({
          backoff: { kind: "exponential", baseMs: Number.POSITIVE_INFINITY },
        })
      )
    ).toBe("INVALID_CONFIG");
  });

  it("names the entity and state, so an invalid policy says where it is", () => {
    try {
      resolve({ maxAttempts: 0 });
    } catch (error) {
      expect((error as Error).message).toContain('state "pending"');
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(resolve(undefined))).toBe(true);
  });
});

describe("backoffDelay", () => {
  it("returns the same delay every time when fixed", () => {
    const backoff = { kind: "fixed", delayMs: 25 } as const;
    expect([2, 3, 4].map((n) => backoffDelay(backoff, n))).toEqual([
      25, 25, 25,
    ]);
  });

  it("doubles by default, starting from the base before the second attempt", () => {
    const backoff = { kind: "exponential", baseMs: 10 } as const;
    expect([2, 3, 4].map((n) => backoffDelay(backoff, n))).toEqual([
      10, 20, 40,
    ]);
  });

  it("honours an explicit factor", () => {
    const backoff = { kind: "exponential", baseMs: 10, factor: 3 } as const;
    expect([2, 3].map((n) => backoffDelay(backoff, n))).toEqual([10, 30]);
  });

  it("caps at maxDelayMs", () => {
    const backoff = {
      kind: "exponential",
      baseMs: 100,
      maxDelayMs: 250,
    } as const;
    expect([2, 3, 4, 9].map((n) => backoffDelay(backoff, n))).toEqual([
      100, 200, 250, 250,
    ]);
  });

  it("is deterministic, because a shared scenario suite cannot assert on jitter", () => {
    const { backoff } = DEFAULT_POLICY;
    expect(backoffDelay(backoff, 3)).toBe(backoffDelay(backoff, 3));
  });
});

describe("defaultRetryable", () => {
  it("retries an ordinary failure", () => {
    expect(defaultRetryable(new Error("carrier timed out"))).toBe(true);
  });

  it("retries a handler failure, which is the case retries exist for", () => {
    expect(defaultRetryable(new EkmanError("HANDLER_FAILED", "boom"))).toBe(
      true
    );
  });

  it.each([
    "UNKNOWN_STATE",
    "UNKNOWN_TRIGGER",
    "INBOX_OVERFLOW",
    "TRIGGER_DROPPED",
    "COMMIT_FENCED",
    "INVALID_CONFIG",
  ] as const)(
    "does not retry %s, which would only be refused again",
    (code) => {
      expect(defaultRetryable(new EkmanError(code, "refused"))).toBe(false);
    }
  );
});

describe("timer-backed settings", () => {
  it("accepts the longest delay a timer can hold", () => {
    expect(resolve({ timeoutMs: MAX_TIMER_MS }).timeoutMs).toBe(2 ** 31 - 1);
  });

  it.each([
    ["timeoutMs", { timeoutMs: 2 ** 31 }],
    ["timeoutMs", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["a fixed delay", { backoff: { kind: "fixed", delayMs: 2 ** 31 } }],
    ["a base delay", { backoff: { kind: "exponential", baseMs: 2 ** 31 } }],
    [
      "a delay ceiling",
      { backoff: { kind: "exponential", baseMs: 1, maxDelayMs: 2 ** 31 } },
    ],
    [
      "a negative delay ceiling",
      { backoff: { kind: "exponential", baseMs: 1, maxDelayMs: -1 } },
    ],
    [
      "a factor that is not a number",
      { backoff: { kind: "exponential", baseMs: 1, factor: Number.NaN } },
    ],
    [
      "a factor that shrinks the delay to nothing",
      { backoff: { kind: "exponential", baseMs: 1, factor: 0 } },
    ],
    ["a backoff of no known kind", { backoff: { kind: "linear" } }],
  ] as const)("refuses %s out of range", (_what, policy) => {
    expect(codeOf(() => resolve(policy as never))).toBe("INVALID_CONFIG");
  });
});

describe("assertPolicyKeys", () => {
  it("accepts every documented option", () => {
    expect(() =>
      assertPolicyKeys(
        {
          maxAttempts: 2,
          timeoutMs: 5,
          retryable: () => true,
          backoff: { kind: "exponential", baseMs: 1, factor: 2, maxDelayMs: 9 },
        },
        "runtime execution policy"
      )
    ).not.toThrow();
    expect(() => assertPolicyKeys(undefined, "x")).not.toThrow();
  });

  it("refuses an option it does not have", () => {
    expect(
      codeOf(() => assertPolicyKeys({ retries: 3 } as never, "runtime"))
    ).toBe("INVALID_CONFIG");
  });

  it("refuses a null backoff as bad configuration, not with a TypeError", () => {
    const policy = { backoff: null } as never;
    expect(codeOf(() => assertPolicyKeys(policy, "runtime"))).toBe(
      "INVALID_CONFIG"
    );
    expect(codeOf(() => new Ekman({ entities: [], execution: policy }))).toBe(
      "INVALID_CONFIG"
    );
  });
});
