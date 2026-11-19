import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { RuleConstraint, RuleTrigger } from "../src/constraints";
import { DEFAULT_RULE_TRIGGER } from "../src/constraints";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import { isEkmanError } from "../src/errors";
import type { EkmanEvent } from "../src/events";
import { stay, transitionTo } from "../src/results";
import type { Store } from "../src/store";
import { fileStore } from "../src/stores/file";
import { memoryStore } from "../src/stores/memory";
import type { TelemetryEvent } from "../src/telemetry";
import type { Trigger } from "../src/types";

type Health = "healthy" | "degraded";
interface Known extends Record<string, unknown> {
  failures: number;
}

/** Holds a `set` trigger sent with `gated: true` inside its handler until released. */
let gate: Promise<void> = Promise.resolve();
let release: () => void = () => undefined;
function closeGate(): void {
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
}

const tooMany: RuleConstraint<Health, Known> = {
  name: "too-many",
  in: "healthy",
  when: (service) => service.values.failures >= 3,
  propose: "degraded",
};

/**
 * A service that counts failed probes. What it does with a proposal is the test's to say:
 * `accept` moves where the rule asked, anything else stays.
 */
function services(
  rules: readonly RuleConstraint<Health, Known>[] = [tooMany],
  onProposal: (trigger: Trigger) => "accept" | "decline" | "throw" = () =>
    "accept"
) {
  return defineEntity("services", {
    initial: "healthy",
    values: { failures: 0 } as Known,
    states: {
      healthy: (service, trigger) => {
        if (trigger.type === "probe") {
          return stay({
            failures: trigger.ok === true ? 0 : service.values.failures + 1,
          });
        }
        if (trigger.type === "set") {
          const failures = trigger.failures as number;
          // Held open by a test that needs something queued behind this commit.
          return trigger.gated === true
            ? gate.then(() => stay({ failures }))
            : stay({ failures });
        }
        if (trigger.type !== DEFAULT_RULE_TRIGGER) {
          return stay();
        }
        const answer = onProposal(trigger);
        if (answer === "throw") {
          throw new Error("cannot take a proposal");
        }
        return answer === "accept"
          ? transitionTo(trigger.propose as Health, service.values)
          : stay();
      },
      degraded: (service, trigger) =>
        trigger.type === "recover"
          ? transitionTo("healthy", {
              failures: (trigger.failures as number | undefined) ?? 0,
            })
          : stay(service.values),
    },
    constraints: { rules },
  });
}

const failing = { type: "probe", ok: false };

/** Every rule match in a key's stream. */
async function matches(ekman: Ekman, key = "services:api") {
  const { events } = await ekman.history(key);
  return events.filter(
    (event): event is Extract<EkmanEvent, { type: "violation" }> =>
      event.type === "violation" && event.constraint.kind === "rule"
  );
}

/** Let a proposal sent from inside a commit be delivered and answered. */
const settled = async (ekman: Ekman, key = "services:api") => {
  await ekman.send(key, { type: "noop" }).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
};

describe("a rule", () => {
  it("proposes a move as a trigger when its condition comes to hold, and the handler decides", async () => {
    const seen: Trigger[] = [];
    const ekman = new Ekman({
      entities: [
        services([tooMany], (trigger) => {
          seen.push(trigger);
          return "accept";
        }),
      ],
    });
    const api = ekman.entities.services;

    await api.send("api", failing);
    await api.send("api", failing);
    expect(await matches(ekman)).toEqual([]);

    await api.send("api", failing);
    await vi.waitFor(() => expect(api.inspect("api")?.state).toBe("degraded"));

    expect(seen).toEqual([
      {
        type: DEFAULT_RULE_TRIGGER,
        id: expect.any(String),
        rule: "too-many",
        state: "healthy",
        propose: "degraded",
        reason: "the condition held",
      },
    ]);

    const [match] = await matches(ekman);
    expect(match).toMatchObject({
      seq: 3,
      constraint: { kind: "rule", name: "too-many" },
      policy: "reject",
      reason: "the condition held",
      cause: { type: DEFAULT_RULE_TRIGGER, id: seen[0]?.id },
    });
    expect(match && "attempted" in match).toBe(false);

    const { events } = await ekman.history("services:api");
    expect(events.at(-1)).toMatchObject({
      type: "transition",
      from: "healthy",
      to: "degraded",
      cause: { type: DEFAULT_RULE_TRIGGER, id: seen[0]?.id },
    });
    await ekman.close();
  });

  it("says so once while the condition goes on holding", async () => {
    const ekman = new Ekman({
      entities: [services([tooMany], () => "decline")],
    });
    const api = ekman.entities.services;

    await api.send("api", { type: "set", failures: 3 });
    await settled(ekman);
    await api.send("api", failing);
    await api.send("api", failing);
    await settled(ekman);

    expect(await matches(ekman)).toHaveLength(1);
    expect(api.inspect("api")).toMatchObject({
      state: "healthy",
      values: { failures: 5 },
    });
    await ekman.close();
  });

  it("is armed again when the condition stops holding", async () => {
    const ekman = new Ekman({
      entities: [services([tooMany], () => "decline")],
    });
    const api = ekman.entities.services;

    await api.send("api", { type: "set", failures: 3 });
    await settled(ekman);
    await api.send("api", { type: "probe", ok: true });
    await api.send("api", { type: "set", failures: 4 });
    await settled(ekman);

    expect((await matches(ekman)).map((match) => match.seq)).toEqual([1, 5]);
    await ekman.close();
  });

  it("is armed again by a move, so coming back over the threshold proposes again", async () => {
    const ekman = new Ekman({ entities: [services()] });
    const api = ekman.entities.services;

    await api.send("api", { type: "set", failures: 3 });
    await vi.waitFor(() => expect(api.inspect("api")?.state).toBe("degraded"));
    await api.send("api", { type: "recover", failures: 3 });
    await vi.waitFor(() => expect(api.inspect("api")?.state).toBe("degraded"));

    expect(await matches(ekman)).toHaveLength(2);
    await ekman.close();
  });

  it("sends one proposal when more commits land before it is answered", async () => {
    const ekman = new Ekman({
      entities: [services([tooMany], () => "decline")],
    });
    const api = ekman.entities.services;

    // All three are queued before the first runs, so the proposal the first one raises
    // waits behind two more commits that also find the condition holding.
    await Promise.all([
      api.send("api", { type: "set", failures: 3 }),
      api.send("api", failing),
      api.send("api", failing),
    ]);
    await settled(ekman);

    expect(await matches(ekman)).toHaveLength(1);
    await ekman.close();
  });

  it("does not send a proposal twice when an earlier one is answered while it is still queued", async () => {
    const seen: string[] = [];
    const ekman = new Ekman({
      entities: [
        services([tooMany], (trigger) => {
          seen.push(trigger.id as string);
          return "decline";
        }),
      ],
    });
    const api = ekman.entities.services;
    closeGate();

    // The first proposal is queued behind two more commits: one that stops the condition
    // holding, which arms the rule again, and one that makes it hold again, which raises
    // a second proposal. That last commit is held open so a trigger can be queued between
    // the two proposals.
    const batch = Promise.all([
      api.send("api", { type: "set", failures: 3 }),
      api.send("api", { type: "probe", ok: true }),
      api.send("api", { type: "set", failures: 4, gated: true }),
    ]);
    await vi.waitFor(async () => expect((await matches(ekman)).length).toBe(1));
    const between = api.send("api", failing);
    release();
    await batch;
    await between;
    await settled(ekman);

    // The inbox ran: first proposal, the commit between, second proposal. The first being
    // answered must not make the commit between send the second again.
    expect(await matches(ekman)).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    await ekman.close();
  });

  it("does not silence a rule over the refusal of a proposal from an earlier match", async () => {
    let calls = 0;
    const ekman = new Ekman({
      entities: [
        services([tooMany], () => {
          calls += 1;
          return calls === 1 ? "throw" : "decline";
        }),
      ],
      onUnhandled: () => undefined,
    });
    const api = ekman.entities.services;

    // Queued together, so the first proposal runs after the rule has been armed again
    // and has matched again. Its handler fails, which is a refusal of the first match.
    await Promise.all([
      api.send("api", { type: "set", failures: 3 }),
      api.send("api", { type: "probe", ok: true }),
      api.send("api", { type: "set", failures: 4 }),
    ]);
    await vi.waitFor(() => expect(calls).toBe(2));
    await settled(ekman);

    // Armed again and matching again: the rule has to be free to say so a third time.
    await api.send("api", { type: "probe", ok: true });
    await api.send("api", { type: "set", failures: 5 });
    await vi.waitFor(() => expect(calls).toBe(3));

    expect(await matches(ekman)).toHaveLength(3);
    await ekman.close();
  });

  it.each([
    ["nothing", null, "null"],
    ["undefined", undefined, "undefined"],
    ["a string", "no such field", "no such field"],
  ])(
    "counts a condition that throws %s as holding, and still commits",
    async (_what, thrown, said) => {
      const audited: number[] = [];
      const ekman = new Ekman({
        entities: [
          services(
            [
              {
                name: "broken",
                when: () => {
                  throw thrown;
                },
              },
            ],
            () => "decline"
          ),
        ],
        audit: [
          {
            name: "seen",
            deliver: (event) => {
              audited.push(event.seq);
            },
          },
        ],
      });

      // The condition runs after the commit is applied. Whatever it throws, the sender is
      // told the commit landed and the audit sink still hears of it.
      const committed = await ekman.entities.services.send("api", failing);
      expect(committed.seq).toBe(1);
      await settled(ekman);

      expect((await matches(ekman)).map((match) => match.reason)).toEqual([
        `the condition threw: ${said}`,
      ]);
      await vi.waitFor(() => expect(audited).toContain(1));
      await ekman.close();
    }
  );

  it("takes a string from the condition as the reason", async () => {
    const ekman = new Ekman({
      entities: [
        services([
          {
            ...tooMany,
            when: (service) =>
              service.values.failures >= 3 &&
              `${service.values.failures} failed probes`,
          },
        ]),
      ],
    });

    await ekman.entities.services.send("api", { type: "set", failures: 7 });

    expect((await matches(ekman))[0]?.reason).toBe("7 failed probes");
    await ekman.close();
  });

  it("counts a condition that throws as holding, with what it threw", async () => {
    const ekman = new Ekman({
      entities: [
        services(
          [
            {
              name: "broken",
              when: () => {
                throw new Error("no such field");
              },
            },
          ],
          () => "decline"
        ),
      ],
    });

    await ekman.entities.services.send("api", failing);
    await ekman.entities.services.send("api", failing);
    await settled(ekman);

    expect((await matches(ekman)).map((match) => match.reason)).toEqual([
      "the condition threw: no such field",
    ]);
    await ekman.close();
  });

  it("carries no proposed state when the rule names none", async () => {
    const seen: Trigger[] = [];
    const ekman = new Ekman({
      entities: [
        services([{ name: "noisy", when: () => true }], (trigger) => {
          seen.push(trigger);
          return "decline";
        }),
      ],
    });

    await ekman.entities.services.send("api", failing);
    await settled(ekman);

    expect(seen).toHaveLength(1);
    expect(seen[0] && "propose" in seen[0]).toBe(false);
    await ekman.close();
  });

  it("is not asked in the state it proposes", async () => {
    const { in: _scope, ...unscoped } = tooMany;
    const ekman = new Ekman({ entities: [services([unscoped])] });
    const api = ekman.entities.services;

    await api.send("api", { type: "set", failures: 3 });
    await vi.waitFor(() => expect(api.inspect("api")?.state).toBe("degraded"));
    // Commits in `degraded`, with the condition still holding.
    await api.send("api", { type: "noop" });
    await api.send("api", { type: "noop" });

    expect(await matches(ekman)).toHaveLength(1);
    await ekman.close();
  });

  it("costs an entity with no rules nothing but a lookup", async () => {
    const plain = defineEntity("plain", {
      initial: "a",
      states: { a: () => stay() },
    });
    const ekman = new Ekman({ entities: [plain, services()] });

    await ekman.send("plain:1", { type: "t" });

    expect((await ekman.history("plain:1")).events).toHaveLength(2);
    await ekman.close();
  });

  describe("under warn", () => {
    it("records the match and delivers nothing", async () => {
      const telemetry: TelemetryEvent[] = [];
      const onProposal = vi.fn(() => "accept" as const);
      const ekman = new Ekman({
        entities: [services([{ ...tooMany, policy: "warn" }], onProposal)],
        telemetry: { "*": (event) => telemetry.push(event) },
      });
      const api = ekman.entities.services;

      await api.send("api", { type: "set", failures: 3 });
      await api.send("api", failing);
      await settled(ekman);

      const found = await matches(ekman);
      expect(found).toHaveLength(1);
      expect(found[0]?.policy).toBe("warn");
      expect(onProposal).not.toHaveBeenCalled();
      expect(api.inspect("api")?.state).toBe("healthy");
      expect(
        telemetry.filter((event) => event.type === "constraint.escalated")
      ).toEqual([]);
      await ekman.close();
    });

    it("need not have its trigger declared", () => {
      expect(() =>
        defineEntity("quiet", {
          initial: "a",
          triggers: ["t"],
          states: { a: () => stay() },
          constraints: { rules: [{ when: () => true, policy: "warn" }] },
        })
      ).not.toThrow();
    });
  });

  describe("at definition", () => {
    const code = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return isEkmanError(error) ? error.code : "not-an-ekman-error";
      }
      return "no-throw";
    };

    it("refuses a rule whose trigger the entity does not declare", () => {
      expect(() =>
        defineEntity("strict", {
          initial: "a",
          triggers: ["t"],
          states: { a: () => stay() },
          constraints: { rules: [{ name: "r", when: () => true }] },
        })
      ).toThrow(
        'rule "r" delivers trigger type "rule.matched", which is not in the declared triggers list'
      );
    });

    it("refuses an option a rule does not have", () => {
      expect(
        code(() =>
          defineEntity("typo", {
            initial: "a",
            states: { a: () => stay() },
            constraints: {
              rules: [{ when: () => true, proposes: "a" } as never],
            },
          })
        )
      ).toBe("INVALID_CONFIG");
    });

    it("types the trigger a rule delivers, for a union to include", () => {
      interface Probe {
        type: "probe";
        ok: boolean;
      }
      const typed = defineEntity.withTriggers<Probe | RuleTrigger<Health>>()(
        "typed",
        {
          initial: "healthy",
          values: { failures: 0 },
          triggers: ["probe", DEFAULT_RULE_TRIGGER],
          states: {
            healthy: (service, trigger) => {
              if (trigger.type === DEFAULT_RULE_TRIGGER) {
                expectTypeOf(trigger.propose).toEqualTypeOf<
                  Health | undefined
                >();
                return transitionTo(trigger.propose ?? "degraded");
              }
              return stay({ failures: service.values.failures + 1 });
            },
            degraded: () => stay(),
          },
          constraints: {
            rules: [
              {
                in: "healthy",
                when: (service) => service.values.failures >= 1,
                propose: "degraded",
              },
            ],
          },
        }
      );

      expect(typed.name).toBe("typed");
    });
  });

  describe("in telemetry", () => {
    it("mirrors the match, then says how delivery went", async () => {
      const telemetry: TelemetryEvent[] = [];
      const ekman = new Ekman({
        entities: [services()],
        telemetry: { "*": (event) => telemetry.push(event) },
      });
      const api = ekman.entities.services;

      await api.send("api", { type: "set", failures: 3 });
      await vi.waitFor(() =>
        expect(
          telemetry.some((event) => event.type === "constraint.escalated")
        ).toBe(true)
      );

      const constraint = telemetry.filter((event) =>
        event.type.startsWith("constraint.")
      );
      expect(constraint).toEqual([
        expect.objectContaining({
          type: "constraint.violated",
          kind: "rule",
          constraint: "too-many",
          policy: "reject",
          state: "healthy",
          reason: "the condition held",
        }),
        expect.objectContaining({
          type: "constraint.escalated",
          kind: "rule",
          constraint: "too-many",
          state: "healthy",
          escalateTo: "degraded",
          delivered: true,
        }),
      ]);
      expect("elapsedMs" in (constraint[1] as object)).toBe(false);
      await ekman.close();
    });
  });

  describe("whose proposal is refused", () => {
    it("is done for this match when the handler fails, and says where the failure came from", async () => {
      const onUnhandled = vi.fn();
      const telemetry: TelemetryEvent[] = [];
      const ekman = new Ekman({
        entities: [services([tooMany], () => "throw")],
        onUnhandled,
        telemetry: { "*": (event) => telemetry.push(event) },
      });
      const api = ekman.entities.services;

      await api.send("api", { type: "set", failures: 3 });
      await vi.waitFor(() => expect(onUnhandled).toHaveBeenCalledTimes(1));
      await api.send("api", failing);
      await settled(ekman);

      expect(onUnhandled.mock.calls[0]?.[1]).toEqual({
        source: "escalation",
        key: "services:api",
      });
      expect(await matches(ekman)).toHaveLength(1);
      expect(
        telemetry.filter((event) => event.type === "constraint.escalated")
      ).toEqual([expect.objectContaining({ delivered: false })]);
      await ekman.close();
    });

    it("is sent again by the next commit, under the same id, when the refusal was one that passes", async () => {
      const onUnhandled = vi.fn();
      const seen: Trigger[] = [];
      const ekman = new Ekman({
        entities: [
          services([tooMany], (trigger) => {
            seen.push(trigger);
            return "decline";
          }),
        ],
        inbox: { capacity: 1 },
        onUnhandled,
      });
      const api = ekman.entities.services;

      // The second fills the inbox while the first runs, so the proposal the first
      // commit raises is turned away. The second commit finds it owed and sends it.
      await Promise.all([
        api.send("api", { type: "set", failures: 3 }),
        api.send("api", failing),
      ]);
      await vi.waitFor(() => expect(seen).toHaveLength(1));

      expect(onUnhandled.mock.calls[0]?.[0]).toMatchObject({
        code: "INBOX_OVERFLOW",
      });
      const found = await matches(ekman);
      expect(found).toHaveLength(1);
      expect(seen[0]?.id).toBe(found[0]?.cause.id);
      await ekman.close();
    });
  });

  it("answers a proposal from a stay that is over without disturbing the current one's", async () => {
    const seen: string[] = [];
    const ekman = new Ekman({
      entities: [
        services([tooMany], (trigger) => {
          if (trigger.rule === undefined) {
            return "accept";
          }
          seen.push(trigger.id as string);
          return "decline";
        }),
      ],
    });
    const api = ekman.entities.services;

    // Queued together: the first commit raises a proposal, and before it is answered the
    // instance leaves `healthy` and comes back still over the threshold, which raises a
    // second. Each is answered once.
    const degrade = defineLeave(ekman);
    await Promise.all([
      api.send("api", { type: "set", failures: 3 }),
      degrade(),
      api.send("api", { type: "recover", failures: 3 }),
    ]);
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    await api.send("api", failing);
    await settled(ekman);

    expect(await matches(ekman)).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    await ekman.close();
  });
});

/** Send a proposal by hand, as a caller could, to move the instance out of `healthy`. */
function defineLeave(ekman: Ekman) {
  return () =>
    ekman.send("services:api", {
      type: DEFAULT_RULE_TRIGGER,
      propose: "degraded",
    });
}

describe("a rule across a reload", () => {
  const restart = async (ekman: Ekman, store: Store, entity = services()) => {
    await ekman.close();
    return new Ekman({ entities: [entity], store });
  };

  it("stays fired through an eviction while its condition goes on holding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-rules-"));
    const declining = services([tooMany], () => "decline");
    const ekman = new Ekman({
      entities: [declining],
      store: fileStore(dir),
      memory: { maxBytes: 0 },
    });
    const api = ekman.entities.services;

    await api.send("api", { type: "set", failures: 3 });
    await settled(ekman);
    await vi.waitFor(() => expect(ekman.residentKeys).toEqual([]));

    await api.send("api", failing);
    await settled(ekman);

    expect(await matches(ekman)).toHaveLength(1);
    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not send a failed proposal again once a snapshot says the rule is done", async () => {
    // The handler fails, so nothing in the stream answers the proposal. The rule is done
    // all the same, and a snapshot taken afterwards says so. The store hands the original
    // match back beside that snapshot, and it must not read as a new one.
    const dir = mkdtempSync(join(tmpdir(), "ekman-rules-"));
    let calls = 0;
    const alwaysThrows = services([tooMany], () => {
      calls += 1;
      return "throw";
    });
    const ekman = new Ekman({
      entities: [alwaysThrows],
      store: fileStore(dir),
      // Room for one service, so a commit to another pushes the first out.
      memory: { maxBytes: 50, eviction: { policy: "lru" } },
      onUnhandled: () => undefined,
    });
    const api = ekman.entities.services;

    await api.send("api", { type: "set", failures: 3 });
    await vi.waitFor(() => expect(calls).toBe(1));
    // Long enough for the refusal to be recorded, and no commit to this key after it:
    // the match and the snapshot then carry the same sequence.
    await new Promise((resolve) => setImmediate(resolve));
    await api.send("other", { type: "noop" });
    await vi.waitFor(() =>
      expect(ekman.residentKeys).not.toContain("services:api")
    );

    // Still over the threshold, on a record rebuilt from the snapshot.
    await api.send("api", failing);
    await settled(ekman);

    expect(calls).toBe(1);
    expect(await matches(ekman)).toHaveLength(1);
    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays fired when the stream is replayed with no snapshot", async () => {
    const store = memoryStore();
    const declining = services([tooMany], () => "decline");
    const first = new Ekman({ entities: [declining], store });
    await first.entities.services.send("api", { type: "set", failures: 3 });
    await settled(first);

    const second = await restart(first, store, declining);
    await second.entities.services.send("api", failing);
    await settled(second);

    expect(await matches(second)).toHaveLength(1);
    await second.close();
  });

  it("is armed again on load when its condition no longer holds, so the next match proposes", async () => {
    const store = memoryStore();
    const declining = services([tooMany], () => "decline");
    const first = new Ekman({ entities: [declining], store });
    await first.entities.services.send("api", { type: "set", failures: 3 });
    await settled(first);
    // The condition stops holding, which no event records.
    await first.entities.services.send("api", { type: "probe", ok: true });

    const second = await restart(first, store, declining);
    await second.entities.services.send("api", { type: "set", failures: 3 });
    await settled(second);

    expect(await matches(second)).toHaveLength(2);
    await second.close();
  });

  it("does nothing on load for an instance in a state no rule watches", async () => {
    const store = memoryStore();
    const first = new Ekman({ entities: [services()], store });
    await first.entities.services.send("api", { type: "set", failures: 3 });
    await vi.waitFor(() =>
      expect(first.entities.services.inspect("api")?.state).toBe("degraded")
    );

    const second = await restart(first, store);
    await second.entities.services.send("api", { type: "noop" });

    expect(await matches(second)).toHaveLength(1);
    await second.close();
  });
});
