import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { StaleConstraint, StaleTrigger } from "../src/constraints";
import { DEFAULT_STALE_TRIGGER } from "../src/constraints";
import { Ekman } from "../src/ekman";
import { defineEntity } from "../src/entity";
import type { EkmanEvent } from "../src/events";
import { parseDuration } from "../src/query";
import { patch, stay, transitionTo } from "../src/results";
import type { ScanResult, Store } from "../src/store";
import { replay, scanKeys } from "../src/store";
import { fileStore } from "../src/stores/file";
import { memoryStore } from "../src/stores/memory";
import type { TelemetryEvent } from "../src/telemetry";
import type { Trigger } from "../src/types";

type Health = "healthy" | "unreachable";
interface Known extends Record<string, unknown> {
  failures: number;
  latencyMs: number;
}

const clock = (start = 0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const quiet: StaleConstraint<Health> = {
  name: "gone-quiet",
  after: 1000,
  propose: "unreachable",
};

/** A service that records probes. What it does when told it has gone quiet is the test's to say. */
function services(
  stale: readonly StaleConstraint<Health>[] = [quiet],
  onQuiet: (trigger: Trigger) => "accept" | "decline" | "throw" = () => "accept"
) {
  return defineEntity("services", {
    initial: "healthy",
    values: { failures: 0, latencyMs: 0 } as Known,
    states: {
      healthy: (service, trigger) => {
        if (trigger.type === "probe") {
          return patch({ latencyMs: trigger.latencyMs as number });
        }
        if (trigger.type !== DEFAULT_STALE_TRIGGER) {
          return stay();
        }
        const answer = onQuiet(trigger);
        if (answer === "throw") {
          throw new Error("cannot say");
        }
        return answer === "accept"
          ? transitionTo(trigger.propose as Health, service.values)
          : stay();
      },
      unreachable: (_service, trigger) =>
        trigger.type === "probe" ? transitionTo("healthy") : stay(),
    },
    constraints: { stale },
  });
}

const probe = { type: "probe", latencyMs: 40 };

async function violations(ekman: Ekman, key = "services:api") {
  const { events } = await ekman.history(key);
  return events.filter(
    (event): event is Extract<EkmanEvent, { type: "violation" }> =>
      event.type === "violation" && event.constraint.kind === "stale"
  );
}

function wrap(inner: Store, overrides: Partial<Store>): Store {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    append: inner.append.bind(inner),
    load: inner.load.bind(inner),
    read: inner.read.bind(inner),
    snapshot: inner.snapshot.bind(inner),
    scan: inner.scan.bind(inner),
    ...overrides,
  };
}

describe("patch", () => {
  const counters = defineEntity("counters", {
    initial: "open",
    values: { a: 1, b: 0, nested: { x: 1, y: 2 } },
    states: {
      open: (_counter, trigger) => {
        if (trigger.type === "nest") {
          return patch({ nested: { x: 9 } as { x: number; y: number } });
        }
        return trigger.type === "close"
          ? transitionTo("closed")
          : patch({ b: trigger.b as number });
      },
      closed: () => stay(),
    },
    constraints: {
      invariants: [
        {
          name: "b-small",
          check: (next) => next.values.b < 10 || "b is too large",
        },
      ],
    },
  });

  it("merges into what the instance holds and commits the whole of it", async () => {
    const ekman = new Ekman({ entities: [counters] });

    const committed = await ekman.entities.counters.send("1", {
      type: "set",
      b: 2,
    });

    expect(committed.state).toBe("open");
    expect(committed.values).toEqual({ a: 1, b: 2, nested: { x: 1, y: 2 } });
    // The event carries full values, so nothing that reads the stream sees a delta.
    expect(committed.event.values).toEqual(committed.values);
    expect(Object.isFrozen(committed.values)).toBe(true);
    await ekman.close();
  });

  it("is shallow: a field named replaces the one held, whole", async () => {
    const ekman = new Ekman({ entities: [counters] });

    const committed = await ekman.entities.counters.send("1", { type: "nest" });

    expect(committed.values.nested).toEqual({ x: 9 });
    await ekman.close();
  });

  it("is checked by invariants against the merged values", async () => {
    const ekman = new Ekman({ entities: [counters] });

    await expect(
      ekman.entities.counters.send("1", { type: "set", b: 50 })
    ).rejects.toMatchObject({ code: "CONSTRAINT_VIOLATED" });
    expect(ekman.entities.counters.inspect("1")?.values.b).toBe(0);
    await ekman.close();
  });

  it("replays to the same values it committed", async () => {
    const store = memoryStore();
    const ekman = new Ekman({ entities: [counters], store });
    await ekman.entities.counters.send("1", { type: "set", b: 2 });
    await ekman.entities.counters.send("1", { type: "set", b: 3 });
    await ekman.close();

    const loaded = await store.load("counters:1");
    expect(loaded && replay(loaded)?.values).toEqual({
      a: 1,
      b: 3,
      nested: { x: 1, y: 2 },
    });
  });

  it("is refused by name when a handler returns something that is not a result", async () => {
    const broken = defineEntity("broken", {
      initial: "a",
      states: { a: (() => ({ kind: "merge" })) as never },
    });
    const ekman = new Ekman({ entities: [broken] });

    await expect(ekman.send("broken:1", { type: "t" })).rejects.toThrow(
      "instead of transitionTo(), stay(), patch() or fail()"
    );
    await ekman.close();
  });
});

describe("when an instance last committed", () => {
  it("advances on every commit, where time in state does not", async () => {
    const time = clock(100);
    const ekman = new Ekman({ entities: [services([])], now: time.now });
    const api = ekman.entities.services;

    await api.send("api", probe);
    time.advance(500);
    const committed = await api.send("api", probe);
    expect(committed.state).toBe("healthy");

    expect(api.inspect("api")).toMatchObject({
      enteredAt: 100,
      lastCommittedAt: 600,
    });
    await ekman.close();
  });

  it("is what a handler is handed", async () => {
    const seen: number[] = [];
    const watching = defineEntity("watching", {
      initial: "a",
      states: {
        a: (instance) => {
          seen.push(instance.enteredAt, instance.lastCommittedAt);
          return stay();
        },
      },
    });
    const time = clock(5);
    const ekman = new Ekman({ entities: [watching], now: time.now });

    await ekman.send("watching:1", { type: "t" });
    time.advance(10);
    await ekman.send("watching:1", { type: "t" });

    expect(seen).toEqual([5, 5, 5, 5]);
    time.advance(10);
    await ekman.send("watching:1", { type: "t" });
    expect(seen.slice(4)).toEqual([5, 15]);
    await ekman.close();
  });

  it("survives an eviction and a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ekman-fresh-"));
    const time = clock();
    const first = new Ekman({
      entities: [services([])],
      store: fileStore(dir),
      memory: { maxBytes: 0 },
      now: time.now,
    });
    await first.entities.services.send("api", probe);
    time.advance(700);
    await first.entities.services.send("api", probe);
    await first.close();

    time.advance(5000);
    const second = new Ekman({
      entities: [services([])],
      store: fileStore(dir),
      now: time.now,
    });
    const [match] = (await second.query({ entity: "services" })).instances;

    expect(match).toMatchObject({
      resident: false,
      lastCommittedAt: 700,
      staleMs: 5000,
    });
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts from the load for a snapshot that never recorded it", async () => {
    const store = memoryStore();
    const time = clock();
    const first = new Ekman({ entities: [services([])], store, now: time.now });
    await first.entities.services.send("api", probe);
    await first.close();

    // A snapshot as an earlier version wrote it, with nothing committed after it.
    const load: Store["load"] = async (key) => {
      const loaded = await store.load(key);
      const current = loaded && replay(loaded);
      if (loaded === undefined || !current) {
        return;
      }
      return {
        seq: loaded.seq,
        events: [],
        snapshot: {
          key,
          entity: "services",
          state: current.state,
          values: current.values,
          seq: current.seq,
          enteredAt: current.enteredAt,
          at: 0,
        },
      };
    };
    const legacy = wrap(store, {
      load,
      scan: (criteria) => scanKeys(["services:api"], criteria, load),
    });

    time.advance(9000);
    const second = new Ekman({
      entities: [services([{ ...quiet, policy: "warn" }])],
      store: legacy,
      now: time.now,
    });
    // Unknown is not stale: the store's row does not match, and nothing is raised.
    expect(
      (await second.query({ entity: "services", staleFor: 1 })).instances
    ).toEqual([]);
    expect(await second.sweep()).toBe(0);

    // The row is still an instance: it only has no last commit time to report.
    const [row] = (await second.query({ entity: "services" })).instances;
    expect(row).toMatchObject({ key: "services:api", resident: false });
    expect(row && "staleMs" in row).toBe(false);

    // The same holds when the runtime has to finish the filter for a store that does
    // not apply it: reading the key finds no time either, and the row is left out.
    const unaware = new Ekman({
      entities: [services([])],
      store: wrap(legacy, {
        capabilities: {
          ...store.capabilities,
          scan: { byState: true, olderThan: true },
        },
        scan: ({ staleForMs: _ignored, ...criteria }) =>
          scanKeys(["services:api"], criteria, load),
      }),
      now: time.now,
    });
    expect(
      (await unaware.query({ entity: "services", staleFor: 1 })).instances
    ).toEqual([]);
    await unaware.close();

    await second.entities.services.send("api", { type: "noop" }).catch(() => 0);
    expect(second.entities.services.inspect("api")?.lastCommittedAt).toBe(9000);
    await second.close();
  });
});

describe("a freshness bound", () => {
  it("proposes a move as a trigger once an instance has gone quiet, and the handler decides", async () => {
    const seen: Trigger[] = [];
    const telemetry: TelemetryEvent[] = [];
    const time = clock();
    const ekman = new Ekman({
      entities: [
        services([quiet], (trigger) => {
          seen.push(trigger);
          return "accept";
        }),
      ],
      now: time.now,
      telemetry: { "*": (event) => telemetry.push(event) },
    });
    const api = ekman.entities.services;

    await api.send("api", probe);
    time.advance(999);
    expect(await ekman.sweep()).toBe(0);
    time.advance(501);
    expect(await ekman.sweep()).toBe(1);

    expect(seen).toEqual([
      {
        type: DEFAULT_STALE_TRIGGER,
        id: expect.any(String),
        constraint: "gone-quiet",
        state: "healthy",
        sinceMs: 1500,
        propose: "unreachable",
      },
    ]);
    expect(api.inspect("api")?.state).toBe("unreachable");
    expect(await violations(ekman)).toEqual([
      expect.objectContaining({
        constraint: { kind: "stale", name: "gone-quiet" },
        policy: "reject",
        reason: "has committed nothing for 1500ms, over its bound of 1000ms",
        cause: { type: DEFAULT_STALE_TRIGGER, id: seen[0]?.id },
      }),
    ]);
    expect(
      telemetry.filter((event) => event.type.startsWith("constraint."))
    ).toEqual([
      expect.objectContaining({
        type: "constraint.violated",
        kind: "stale",
        state: "healthy",
      }),
      expect.objectContaining({
        type: "constraint.escalated",
        kind: "stale",
        elapsedMs: 1500,
        escalateTo: "unreachable",
        delivered: true,
      }),
    ]);
    await ekman.close();
  });

  it("is reset by a commit that leaves the state alone, which a time-in-state bound is not", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [services()], now: time.now });
    const api = ekman.entities.services;

    await api.send("api", probe);
    time.advance(800);
    await api.send("api", probe);
    time.advance(800);

    expect(await ekman.sweep()).toBe(0);
    expect(api.inspect("api")?.state).toBe("healthy");
    await ekman.close();
  });

  it("is not repeated when the handler declines, however long the silence goes on", async () => {
    const time = clock();
    const ekman = new Ekman({
      entities: [services([quiet], () => "decline")],
      now: time.now,
    });
    const api = ekman.entities.services;

    await api.send("api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(0);
    time.advance(60_000);
    expect(await ekman.sweep()).toBe(0);

    expect(await violations(ekman)).toHaveLength(1);
    await ekman.close();
  });

  it("is armed again once the instance is heard from, and fires for the next silence", async () => {
    const time = clock();
    const ekman = new Ekman({
      entities: [services([quiet], () => "decline")],
      now: time.now,
    });
    const api = ekman.entities.services;

    await api.send("api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);
    await api.send("api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);

    expect(await violations(ekman)).toHaveLength(2);
    await ekman.close();
  });

  it("is armed again by a probe that lands while its trigger is still queued", async () => {
    // A probe is already running when the sweep finds the instance quiet. The sweep's
    // trigger queues behind it. The probe then commits, so the instance has been heard
    // from and the silence is over, and the trigger that follows is answering nothing.
    let hold: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      hold = resolve;
    });
    const slow = defineEntity("services", {
      initial: "healthy",
      states: {
        healthy: (_service, trigger) =>
          trigger.type === "slow-probe" ? held.then(() => stay()) : stay(),
      },
      constraints: { stale: [{ name: "gone-quiet", after: 1000 }] },
    });
    const time = clock();
    const ekman = new Ekman({ entities: [slow], now: time.now });

    await ekman.send("services:api", probe);
    time.advance(1500);
    const running = ekman.send("services:api", { type: "slow-probe" });
    const sweeping = ekman.sweep();
    await vi.waitFor(async () =>
      expect(await violations(ekman)).toHaveLength(1)
    );
    hold();
    await running;
    expect(await sweeping).toBe(1);

    // Heard from again, and then quiet again: the bound has to be free to say so.
    await ekman.send("services:api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);
    expect(await violations(ekman)).toHaveLength(2);
    await ekman.close();
  });

  it("stays said after its own trigger moved the instance", async () => {
    const elsewhere: StaleConstraint<Health> = {
      name: "anywhere",
      after: 1000,
    };
    const time = clock();
    const ekman = new Ekman({
      entities: [
        defineEntity("services", {
          initial: "healthy",
          states: {
            healthy: (_s, trigger) =>
              trigger.type === DEFAULT_STALE_TRIGGER
                ? transitionTo("unreachable")
                : stay(),
            unreachable: () => stay(),
          },
          constraints: { stale: [elsewhere] },
        }),
      ],
      now: time.now,
    });

    await ekman.send("services:api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);
    expect(ekman.inspect("services:api")?.state).toBe("unreachable");
    // Watched in `unreachable` too, and still quiet. The move was its own answer.
    time.advance(5000);
    expect(await ekman.sweep()).toBe(0);
    await ekman.close();
  });

  it("is not asked in the state it proposes", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [services()], now: time.now });

    await ekman.entities.services.send("api", probe);
    time.advance(1500);
    await ekman.sweep();
    await ekman.entities.services.send("api", { type: "noop" });
    time.advance(5000);

    expect(await ekman.sweep()).toBe(0);
    expect(await violations(ekman)).toHaveLength(1);
    await ekman.close();
  });

  it("watches only the states it names", async () => {
    const scoped = defineEntity("services", {
      initial: "healthy",
      states: {
        healthy: (_s, trigger) =>
          trigger.type === "lose" ? transitionTo("unreachable") : stay(),
        unreachable: () => stay(),
      },
      constraints: {
        stale: [{ in: ["healthy"], after: 1000, policy: "warn" }],
      },
    });
    const time = clock();
    const ekman = new Ekman({ entities: [scoped], now: time.now });

    await ekman.send("services:a", { type: "probe" });
    await ekman.send("services:b", { type: "lose" });
    time.advance(5000);

    expect(await ekman.sweep()).toBe(1);
    expect(await violations(ekman, "services:a")).toHaveLength(1);
    expect(await violations(ekman, "services:b")).toHaveLength(0);
    await ekman.close();
  });

  it("records and delivers nothing under warn, and says so again after the next commit", async () => {
    const onQuiet = vi.fn(() => "accept" as const);
    const time = clock();
    const ekman = new Ekman({
      entities: [services([{ ...quiet, policy: "warn" }], onQuiet)],
      now: time.now,
    });
    const api = ekman.entities.services;

    await api.send("api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);
    expect(await ekman.sweep()).toBe(0);
    await api.send("api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);

    expect(onQuiet).not.toHaveBeenCalled();
    expect((await violations(ekman)).map((v) => v.policy)).toEqual([
      "warn",
      "warn",
    ]);
    await ekman.close();
  });

  it("is done for this silence when the handler fails on it", async () => {
    const onUnhandled = vi.fn();
    const time = clock();
    const ekman = new Ekman({
      entities: [services([quiet], () => "throw")],
      now: time.now,
      onUnhandled,
    });

    await ekman.entities.services.send("api", probe);
    time.advance(1500);
    expect(await ekman.sweep()).toBe(1);
    expect(await ekman.sweep()).toBe(0);

    expect(onUnhandled.mock.calls[0]?.[1]).toEqual({
      source: "escalation",
      key: "services:api",
    });
    await ekman.close();
  });

  it("runs beside a time-in-state bound on the same state, each on its own clock", async () => {
    const both = defineEntity("services", {
      initial: "healthy",
      states: { healthy: () => stay() },
      constraints: {
        temporal: [{ in: "healthy", within: 3000, policy: "warn" }],
        stale: [{ after: 1000, policy: "warn" }],
      },
    });
    const time = clock();
    const ekman = new Ekman({ entities: [both], now: time.now });

    await ekman.send("services:api", probe);
    time.advance(2000);
    await ekman.send("services:api", probe);
    time.advance(1500);

    // In the state for 3500ms, quiet for 1500ms: both are past.
    expect(await ekman.sweep()).toBe(2);
    const { events } = await ekman.history("services:api");
    expect(
      events.flatMap((e) => (e.type === "violation" ? [e.constraint.kind] : []))
    ).toEqual(["temporal", "stale"]);
    await ekman.close();
  });

  describe("for an instance that is not resident", () => {
    it("loads it from the store, asks, and does not ask again while it stays quiet", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ekman-stale-"));
      const time = clock();
      // The second bound is nowhere near due, so the sweep has to work out when it
      // next could be before it lets the instance go.
      const declining = services(
        [quiet, { name: "long-gone", after: 3_600_000, policy: "warn" }],
        () => "decline"
      );
      const first = new Ekman({
        entities: [declining],
        store: fileStore(dir),
        now: time.now,
      });
      await first.entities.services.send("api", probe);
      await first.entities.services.send("fresh", probe);
      await first.close();

      time.advance(1500);
      const second = new Ekman({
        entities: [declining],
        store: fileStore(dir),
        memory: { maxBytes: 0 },
        now: time.now,
      });
      await second.entities.services.send("fresh", probe);

      expect(await second.sweep()).toBe(1);
      expect(second.residentKeys).toEqual([]);
      time.advance(1500);
      // The answer was a commit, and it does not arm the bound again. `fresh` is now
      // quiet for long enough as well.
      expect(await second.sweep()).toBe(1);
      time.advance(1500);
      expect(await second.sweep()).toBe(0);

      expect(await violations(second)).toHaveLength(1);
      expect(await violations(second, "services:fresh")).toHaveLength(1);
      await second.close();

      // A third runtime, with nothing resident and no memory of what was said.
      const third = new Ekman({
        entities: [declining],
        store: fileStore(dir),
        now: time.now,
      });
      time.advance(1500);
      expect(await third.sweep()).toBe(0);
      await third.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("finishes the filter itself for a store that cannot apply it", async () => {
      const inner = memoryStore();
      const time = clock();
      const first = new Ekman({
        entities: [services([{ ...quiet, policy: "warn" }])],
        store: inner,
        now: time.now,
      });
      await first.entities.services.send("old", probe);
      time.advance(1500);
      await first.entities.services.send("new", probe);
      await first.close();

      // Knows nothing of the criterion or of when anything last committed.
      const loads: string[] = [];
      const unaware = wrap(inner, {
        capabilities: {
          ...inner.capabilities,
          scan: { byState: true, olderThan: true },
        },
        load: (key) => {
          loads.push(key);
          return inner.load(key);
        },
        scan: async ({ staleForMs: _ignored, ...criteria }) => {
          const found = await inner.scan(criteria);
          return {
            ...found,
            matches: found.matches.map(
              ({ lastCommittedAt: _unknown, ...match }) => match
            ),
          };
        },
      });
      const second = new Ekman({
        entities: [services([{ ...quiet, policy: "warn" }])],
        store: unaware,
        now: time.now,
      });

      const asked = await second.query({ entity: "services", staleFor: "1s" });
      expect(asked.instances.map((m) => [m.key, m.staleMs])).toEqual([
        ["services:old", 1500],
      ]);
      expect(asked.reasons).toContain("unsupported-criteria");
      expect([...loads].sort()).toEqual(["services:new", "services:old"]);

      expect(await second.sweep()).toBe(1);
      expect(await violations(second, "services:old")).toHaveLength(1);
      await second.close();
    });

    it("reports a store that answered a scan in part, and one that cannot be scanned", async () => {
      const inner = memoryStore();
      const onUnhandled = vi.fn();
      const answer: { fail: boolean } = { fail: false };
      const partial = wrap(inner, {
        scan: async (criteria): Promise<ScanResult> => {
          if (answer.fail) {
            throw new Error("the store is away");
          }
          return { ...(await inner.scan(criteria)), complete: false };
        },
      });
      const ekman = new Ekman({
        entities: [services([{ ...quiet, policy: "warn" }])],
        store: partial,
        onUnhandled,
      });

      expect(await ekman.sweep()).toBe(0);
      expect(onUnhandled.mock.calls[0]?.[0]).toMatchObject({
        code: "NOT_IMPLEMENTED",
      });

      answer.fail = true;
      expect(await ekman.sweep()).toBe(0);
      expect(onUnhandled.mock.calls[1]).toEqual([
        expect.objectContaining({ message: "the store is away" }),
        { source: "sweep" },
      ]);
      await ekman.close();
    });
  });

  describe("at definition", () => {
    const define = (stale: readonly object[], extra: object = {}) =>
      defineEntity("services", {
        initial: "healthy",
        states: { healthy: () => stay(), unreachable: () => stay() },
        constraints: { stale: stale as never, ...extra },
      });

    it("names itself after what it watches and how long it allows", () => {
      const ekman = new Ekman({
        entities: [
          define([
            { after: 1000, policy: "warn" },
            { in: "healthy", after: 500, policy: "warn" },
            { after: 1, policy: "off" },
          ]),
        ],
      });
      expect(ekman.entityNames).toEqual(["services"]);
    });

    it.each<[string, object]>([
      ["a state it watches that does not exist", { in: "nowhere", after: 1 }],
      ["a state it proposes that does not exist", { after: 1, propose: "x" }],
      ["no time at all", { after: 0 }],
      ["a time that is not a number", { after: "5m" }],
      ["a policy that is not one", { after: 1, policy: "loud" }],
      ["an option it does not have", { after: 1, within: 5 }],
    ])("refuses a bound with %s", (_what, bound) => {
      expect(() => define([bound])).toThrow(
        expect.objectContaining({ code: "INVALID_CONFIG" })
      );
    });

    it("refuses a proposal the declared transitions do not allow from a watched state", () => {
      expect(() =>
        define([{ in: "healthy", after: 1, propose: "unreachable" }], {
          transitions: { allow: { unreachable: ["healthy"] } },
        })
      ).toThrow('stale constraint on "healthy" asks for "unreachable"');
    });

    it("refuses a name shared with a time-in-state bound, and a trigger the entity does not declare", () => {
      expect(() =>
        define([{ name: "watch", after: 1 }], {
          temporal: [{ name: "watch", in: "healthy", within: 1 }],
        })
      ).toThrow('share the name "watch"');

      expect(() =>
        defineEntity("strict", {
          initial: "a",
          triggers: ["t"],
          states: { a: () => stay() },
          constraints: { stale: [{ name: "q", after: 1 }] },
        })
      ).toThrow(
        'stale constraint "q" delivers trigger type "constraint.stale", which is not in the declared triggers list'
      );
    });

    it("types the trigger it delivers, for a union to include", () => {
      interface Probe {
        type: "probe";
        ok: boolean;
      }
      const typed = defineEntity.withTriggers<Probe | StaleTrigger<Health>>()(
        "typed",
        {
          initial: "healthy",
          triggers: ["probe", DEFAULT_STALE_TRIGGER],
          states: {
            healthy: (_service, trigger) => {
              if (trigger.type === DEFAULT_STALE_TRIGGER) {
                expectTypeOf(trigger.propose).toEqualTypeOf<
                  Health | undefined
                >();
                expectTypeOf(trigger.sinceMs).toBeNumber();
                return transitionTo(trigger.propose ?? "unreachable");
              }
              return stay();
            },
            unreachable: () => stay(),
          },
          constraints: { stale: [{ after: 60_000, propose: "unreachable" }] },
        }
      );

      expect(typed.name).toBe("typed");
    });
  });
});

describe("querying by time since the last commit", () => {
  it("finds what has gone quiet, resident or stored, and says for how long", async () => {
    const store = memoryStore();
    const time = clock();
    const first = new Ekman({ entities: [services([])], store, now: time.now });
    await first.entities.services.send("stored", probe);
    await first.close();

    time.advance(4000);
    const ekman = new Ekman({ entities: [services([])], store, now: time.now });
    await ekman.entities.services.send("quiet", probe);
    time.advance(2000);
    await ekman.entities.services.send("chatty", probe);
    time.advance(500);

    const result = await ekman.entities.services.query({ staleFor: "2s" });
    expect(
      result.instances.map((m) => [
        m.key,
        m.resident,
        m.lastCommittedAt,
        m.staleMs,
      ])
    ).toEqual([
      ["services:stored", false, 0, 6500],
      ["services:quiet", true, 4000, 2500],
    ]);

    // Inclusive at the bound, like time in state.
    expect(
      (await ekman.query({ entity: "services", staleFor: 2500 })).instances
    ).toHaveLength(2);
    expect(
      (await ekman.query({ entity: "services", staleFor: 2501 })).instances
    ).toHaveLength(1);
    await ekman.close();
  });

  it("does not drop an instance from a query that set no such filter, when the clock steps back", async () => {
    const time = clock(0);
    const ekman = new Ekman({ entities: [services([])], now: time.now });
    await ekman.entities.services.send("api", probe);
    time.advance(200);
    await ekman.entities.services.send("api", probe);
    // The clock is corrected backwards, to before that last commit.
    time.advance(-100);

    const { instances } = await ekman.query({ entity: "services" });
    expect(instances.map((m) => [m.key, m.ageMs, m.staleMs])).toEqual([
      ["services:api", 100, -100],
    ]);
    await ekman.close();
  });

  it("holds a row read late to the silence that was asked for", async () => {
    // The store applies the filter and leaves values out. By the time the runtime reads
    // them the instance has committed, so it is no longer quiet and is no longer a match.
    const inner = memoryStore();
    const time = clock();
    const first = new Ekman({
      entities: [services([])],
      store: inner,
      now: time.now,
    });
    await first.entities.services.send("api", probe);
    await first.close();
    time.advance(5000);

    const racing = wrap(inner, {
      scan: async ({ includeValues: _ignored, ...criteria }) => {
        const found = await inner.scan(criteria);
        const other = new Ekman({
          entities: [services([])],
          store: inner,
          now: time.now,
        });
        await other.entities.services.send("api", probe);
        await other.close();
        return found;
      },
    });
    const ekman = new Ekman({
      entities: [services([])],
      store: racing,
      now: time.now,
    });

    const { instances } = await ekman.query({
      entity: "services",
      staleFor: 1000,
      includeValues: true,
    });
    expect(instances).toEqual([]);
    await ekman.close();
  });

  it("settles what a row already says before loading anything for it", async () => {
    // A store that hands back every instance, with no values and no filtering. Reading
    // values for rows the state already rules out would replay the whole entity.
    const inner = memoryStore();
    const first = new Ekman({ entities: [services([])], store: inner });
    for (const name of ["a", "b", "c", "d"]) {
      // biome-ignore lint/performance/noAwaitInLoops: four commits, in order
      await first.entities.services.send(name, probe);
    }
    await first.entities.services.send("d", {
      type: DEFAULT_STALE_TRIGGER,
      propose: "unreachable",
    });
    await first.close();

    const loads: string[] = [];
    const blunt = wrap(inner, {
      capabilities: {
        ...inner.capabilities,
        scan: { byState: false, olderThan: false },
      },
      load: (key) => {
        loads.push(key);
        return inner.load(key);
      },
      scan: ({ state: _s, includeValues: _v, ...criteria }) =>
        inner.scan(criteria),
    });
    const ekman = new Ekman({ entities: [services([])], store: blunt });

    const result = await ekman.query({
      entity: "services",
      state: "unreachable",
      includeValues: true,
    });
    expect(result.instances.map((m) => m.key)).toEqual(["services:d"]);
    expect(loads).toEqual(["services:d"]);
    await ekman.close();
  });

  it("is a different clock from time in state", async () => {
    const time = clock();
    const ekman = new Ekman({ entities: [services([])], now: time.now });
    await ekman.entities.services.send("api", probe);
    time.advance(5000);
    await ekman.entities.services.send("api", probe);

    const [match] = (await ekman.query({ entity: "services" })).instances;
    expect(match).toMatchObject({ ageMs: 5000, staleMs: 0 });
    expect(
      (await ekman.query({ entity: "services", olderThan: 5000, staleFor: 1 }))
        .instances
    ).toEqual([]);
    await ekman.close();
  });

  it("refuses a time that is not a duration, by its own name", async () => {
    const ekman = new Ekman({ entities: [services([])] });

    await expect(
      ekman.query({ entity: "services", staleFor: "soon" })
    ).rejects.toThrow('staleFor "soon" is not a duration');
    expect(() => parseDuration(-1, "staleFor")).toThrow(
      "staleFor must be a non-negative number of milliseconds"
    );
    await ekman.close();
  });
});
