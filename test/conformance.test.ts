import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../runner/run";
import type { Scenario } from "../runner/scenario";
import {
  CLAIMED_LEVELS,
  LEVELS,
  loadScenarios,
  RUN_LEVELS,
} from "../runner/scenario";
import { Ekman, SPEC_VERSION } from "../src/index";

const scenarios = loadScenarios();

function load(id: string): Scenario {
  const found = scenarios.find((scenario) => scenario.id === id);
  if (found === undefined) {
    throw new Error(`no scenario ${id}`);
  }
  return found;
}

/**
 * A mutable deep copy, so corrupting a scenario cannot leak into the real suite.
 *
 * `damage` takes `any` deliberately: its whole job is to reach into an expectation and
 * break it, which is precisely what the readonly scenario types exist to stop.
 */
function corrupt(id: string, damage: (scenario: any) => void): Scenario {
  const copy = structuredClone(load(id)) as Scenario;
  damage(copy);
  return copy;
}

describe("the contract version", () => {
  it("is the one the README says this package targets", () => {
    const readme = readFileSync(
      fileURLToPath(new URL("../README.md", import.meta.url)),
      "utf8"
    );

    expect(SPEC_VERSION).toBe("0.1");
    expect(readme).toContain(`spec ${SPEC_VERSION}**`);
    expect(readme).toContain("`SPEC_VERSION`");
  });
});

describe("conformance suite", () => {
  it("finds scenarios", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const level of LEVELS) {
    const atLevel = scenarios.filter((s) => s.level === level);
    const claimed = CLAIMED_LEVELS.includes(level);

    describe(`${level} (${claimed ? "claimed" : "not claimed"})`, () => {
      if (atLevel.length === 0) {
        it.skip("no scenarios yet", () => undefined);
        return;
      }

      for (const scenario of atLevel) {
        // Run whether or not the level is claimed. A scenario written for a level still
        // being built is the thing telling you whether you are getting there.
        const test = RUN_LEVELS.includes(level) ? it : it.skip;
        test(`${scenario.id}: ${scenario.name}`, async () => {
          const result = await runScenario(scenario);
          expect(result.failures).toEqual([]);
          expect(result.status).toBe("passed");
        });
      }
    });
  }
});

/**
 * A suite that cannot go red proves nothing.
 *
 * Each case takes a real scenario, breaks exactly one expectation, and asserts the runner
 * both notices and says precisely where. Previous phases did this by hand and reverted;
 * doing it here means a future change that quietly stops asserting something gets caught.
 */
describe("detecting a broken expectation", () => {
  it("names the field path of a wrong violation event", async () => {
    const result = await runScenario(
      corrupt("core/121-transition-graph-rejects", (scenario) => {
        scenario.then.events["orders:1"][1].policy = "warn";
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain(
      'events["orders:1"][1].policy: expected "warn", got "reject"'
    );
  });

  it("notices a guard that should have refused an entry", async () => {
    const result = await runScenario(
      corrupt("core/130-guard-rejects-entry", (scenario) => {
        scenario.then.sends[0] = { outcome: "committed", state: "deploying" };
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures[0]).toContain(
      "sends[0]: expected committed, got rejected (CONSTRAINT_VIOLATED)"
    );
  });

  it("notices a temporal escalation that never landed", async () => {
    const result = await runScenario(
      corrupt("core/140-temporal-escalates-as-a-trigger", (scenario) => {
        scenario.then.state["deployments:a"].state = "deploying";
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain(
      'state["deployments:a"].state: expected deploying, got stalled'
    );
  });

  it("notices a rule recorded under another policy", async () => {
    const result = await runScenario(
      corrupt(
        "core/172-a-rule-under-warn-records-without-delivering",
        (scenario) => {
          scenario.then.events["services:api"][2].policy = "reject";
        }
      )
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      'events["services:api"][2].policy: expected "reject", got "warn"',
    ]);
  });

  it("notices a rule whose condition is broken, which matches with what it threw", async () => {
    const result = await runScenario(
      corrupt("core/171-a-rule-fires-once-per-edge", (scenario) => {
        scenario.given.entities[0].constraints.rules[0].when = {
          throw: "no such field",
        };
        // One probe, then the trigger that waits for the proposal to be answered.
        scenario.when = [scenario.when[0], scenario.when.at(-1)];
        scenario.then.events["services:api"] = [
          ...scenario.then.events["services:api"].slice(0, 4),
          { type: "transition", seq: 3 },
        ];
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      'events["services:api"][2].reason: expected "three failed probes or more", got "the condition threw: no such field"',
    ]);
  });

  it("reads nothing from a trigger in a rule's condition, since a rule has none", async () => {
    const result = await runScenario(
      corrupt("core/171-a-rule-fires-once-per-edge", (scenario) => {
        // Every trigger has a type, so this would hold for any trigger at all.
        scenario.given.entities[0].constraints.rules[0].when = {
          trigger: "type",
          exists: true,
        };
      })
    );

    // The rule never matches, so both of the scenario's violations are missing.
    expect(result.status).toBe("failed");
    expect(result.failures[0]).toContain(
      'events["services:api"]: expected 11 events, got 7'
    );
  });

  it("notices telemetry that was never emitted", async () => {
    const result = await runScenario(
      corrupt("core/140-temporal-escalates-as-a-trigger", (scenario) => {
        scenario.then.telemetry[1].delivered = false;
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures[0]).toContain(
      "telemetry[1]: no constraint.escalated"
    );
  });

  it("notices fields where an empty object was expected", async () => {
    const result = await runScenario(
      corrupt("core/010-initialization", (scenario) => {
        // The entity now starts with a value, so the asserted `{}` no longer holds.
        scenario.given.entities[0].values = { stray: 1 };
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain(
      "sends[0].values.seen: expected an empty object, got keys stray"
    );
  });

  it("counts a value named like an ignored event field as a value", async () => {
    const result = await runScenario(
      corrupt("core/010-initialization", (scenario) => {
        scenario.given.entities[0].values = { at: 1 };
      })
    );

    expect(result.failures).toContain(
      'events["orders:1"][0].values: expected an empty object, got keys at'
    );
  });

  it("notices a forget that should have been refused", async () => {
    const result = await runScenario(
      corrupt("durable/060-forget-removes-the-stream", (scenario) => {
        scenario.then.forgets[0] = { outcome: "refused", code: "KEY_BUSY" };
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain("forgets[0]: expected refused, got ok");
  });

  it("notices a key that is not resident", async () => {
    const result = await runScenario(
      corrupt("core/150-memory-accounted-at-commit", (scenario) => {
        scenario.then.resident = ["orders:1"];
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain(
      "resident: expected [orders:1], got [orders:1, orders:2]"
    );
  });

  it("notices a wrong resident instance count", async () => {
    const result = await runScenario(
      corrupt("core/150-memory-accounted-at-commit", (scenario) => {
        scenario.then.memory.instances = 3;
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain("memory.instances: expected 3, got 2");
  });

  it("notices a budget that was exceeded", async () => {
    const result = await runScenario(
      corrupt("core/150-memory-accounted-at-commit", (scenario) => {
        scenario.then.memory.withinBytes = 1;
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures.join("\n")).toContain(
      "memory.withinBytes: expected at most 1 resident bytes"
    );
  });

  it("notices an audit sink that received something else", async () => {
    const result = await runScenario(
      corrupt("durable/030-audit-receives-every-commit", (scenario) => {
        scenario.then.audit.ok = ["transition@0"];
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain(
      'audit["ok"]: expected [transition@0], got [transition@0, transition@1, transition@2]'
    );
  });

  it("notices an audit sink that was never configured", async () => {
    const result = await runScenario(
      corrupt("durable/030-audit-receives-every-commit", (scenario) => {
        scenario.then.audit.missing = [];
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toContain(
      'audit["missing"]: no such sink is configured'
    );
  });

  it("notices a query that returned other keys", async () => {
    const result = await runScenario(
      corrupt("durable/040-query-by-state-and-age", (scenario) => {
        scenario.then.queries[5].keys = [];
        scenario.then.queries[0].complete = false;
        scenario.then.queries[0].reasons = ["limit-reached"];
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      "queries[0].complete: expected false, got true",
      "queries[0].reasons: expected [limit-reached], got []",
      "queries[5].keys: expected [], got [deployments:done]",
    ]);
  });

  it("notices a query whose matches carry other values", async () => {
    const result = await runScenario(
      corrupt("durable/042-a-query-can-return-values", (scenario) => {
        scenario.then.queries[0].values["orders:1"].who = "z";
        scenario.then.queries[0].values["orders:9"] = { who: "nobody" };
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      'queries[0].values["orders:1"].who: expected "z", got "a"',
      'queries[0].values["orders:9"]: expected an object, got undefined',
    ]);
  });

  it("notices values carried by a query that did not ask for them", async () => {
    // An implementation that always carries values, which the second query never asked for.
    const { query } = Ekman.prototype;
    const eager = vi
      .spyOn(Ekman.prototype, "query")
      .mockImplementation(function always(this: Ekman, criteria) {
        return query.call(this, { ...criteria, includeValues: true });
      });

    const result = await runScenario(
      load("durable/042-a-query-can-return-values")
    );
    eager.mockRestore();

    expect(result.status).toBe("failed");
    expect(result.failures).toContain(
      'queries[1].values["orders:1"]: carried values without includeValues'
    );
  });

  it("notices a state map that groups differently", async () => {
    const result = await runScenario(
      corrupt(
        "core/163-the-state-map-counts-resident-instances-per-state",
        (scenario) => {
          const [whole, limited] = scenario.then.maps;
          whole.byState.healthy = ["services:c", "services:a"];
          whole.byState.retired = ["services:z"];
          whole.byState.unreachable = undefined;
          whole.total = 6;
          whole.complete = true;
          limited.reasons = ["limit-reached"];
        }
      )
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      'maps[0].byState["healthy"]: expected [services:c, services:a], got [services:a, services:c]',
      'maps[0].byState["retired"]: expected [services:z], got no such state',
      'maps[0].byState["unreachable"]: expected no such state, got [services:d]',
      "maps[0].total: expected 6, got 5",
      "maps[0].complete: expected true, got false",
      "maps[1].reasons: expected [limit-reached], got [no-durable-store, limit-reached]",
    ]);
  });

  it("notices a state that is missing or extra when a limit of zero lists no keys at all", async () => {
    const result = await runScenario(
      corrupt(
        "core/163-the-state-map-counts-resident-instances-per-state",
        (scenario) => {
          const [, limited] = scenario.then.maps;
          limited.limitPerState = 0;
          // Every state lists nothing now. One is left out and one is invented.
          limited.byState = { healthy: [], degraded: [], retired: [] };
        }
      )
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      'maps[1].byState["retired"]: expected [], got no such state',
      'maps[1].byState["unreachable"]: expected no such state, got []',
    ]);
  });

  it("compares a state's keys one by one, not as joined text", async () => {
    const result = await runScenario(
      corrupt(
        "core/163-the-state-map-counts-resident-instances-per-state",
        (scenario) => {
          scenario.then.maps[0].byState.healthy = ["services:a, services:c"];
        }
      )
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      'maps[0].byState["healthy"]: expected [services:a, services:c], got [services:a, services:c]',
    ]);
  });

  it("notices a history that reads differently", async () => {
    const result = await runScenario(
      corrupt("durable/050-history-is-the-whole-stream", (scenario) => {
        const history = scenario.then.history["orders:1"];
        history.events = ["transition@0"];
        history.complete = false;
        history.reasons = ["compacted"];
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      'history["orders:1"].events: expected [transition@0], got [transition@0, transition@1, rejected@1, violation@1, transition@2, restored@2, transition@3]',
      'history["orders:1"].complete: expected false, got true',
      'history["orders:1"].reasons: expected [compacted], got []',
    ]);
  });

  it("notices a build that was refused for another reason", async () => {
    const result = await runScenario(
      corrupt("core/070-initial-state-without-handler", (scenario) => {
        scenario.then.buildError.code = "INVALID_CONFIG";
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures[0]).toContain(
      "expected build error INVALID_CONFIG, got INITIAL_STATE_NOT_IN_STATES"
    );
  });

  it("notices a build that should have been refused", async () => {
    const result = await runScenario(
      corrupt("core/010-initialization", (scenario) => {
        scenario.then.buildError = { code: "INVALID_CONFIG" };
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      "expected building to fail with INVALID_CONFIG, but it succeeded",
    ]);
  });

  it("notices telemetry that must not appear", async () => {
    const result = await runScenario(
      corrupt("core/060-per-key-fifo", (scenario) => {
        scenario.then.telemetryAbsent = [{ type: "inbox.enqueued" }];
      })
    );

    expect(result.status).toBe("failed");
    expect(result.failures[0]).toContain(
      'telemetryAbsent[0]: found inbox.enqueued matching {"type":"inbox.enqueued"}'
    );
  });

  it("accepts absent telemetry that never appeared", async () => {
    const result = await runScenario(
      corrupt("core/060-per-key-fifo", (scenario) => {
        scenario.then.telemetryAbsent = [{ type: "commit.fenced" }];
      })
    );

    expect(result.failures).toEqual([]);
  });

  describe("a key that is in the store and not in memory", () => {
    const stored = "durable/064-forgotten-stays-forgotten";

    it("notices its state is not the one expected", async () => {
      const result = await runScenario(
        corrupt(stored, (scenario) => {
          scenario.then.state["deployments:kept"] = { state: "pending" };
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failures).toEqual([
        'state["deployments:kept"].state: expected pending, got deploying',
      ]);
    });

    it("notices its sequence and values are not the ones expected", async () => {
      const result = await runScenario(
        corrupt(stored, (scenario) => {
          scenario.then.state["deployments:kept"] = {
            seq: 4,
            values: { region: "us-west-2" },
          };
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failures).toEqual([
        'state["deployments:kept"].seq: expected 4, got 1',
        'state["deployments:kept"].values.region: expected "us-west-2", got "eu-west-1"',
      ]);
    });

    it("does not take absence from memory for absence", async () => {
      const result = await runScenario(
        corrupt(stored, (scenario) => {
          scenario.then.state["deployments:kept"] = null;
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failures).toEqual([
        'state["deployments:kept"]: expected no instance, got deploying',
      ]);
    });

    it("notices a key that exists nowhere", async () => {
      const result = await runScenario(
        corrupt(stored, (scenario) => {
          scenario.then.state["deployments:gone"] = { state: "deploying" };
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failures).toEqual([
        'state["deployments:gone"]: expected an instance, found none',
      ]);
    });
  });
});

/**
 * A scenario the runner cannot read is a broken suite, not a failing implementation, so it
 * is thrown rather than reported as a failure an implementer would go looking for.
 */
describe("refusing a malformed scenario", () => {
  it("refuses an unknown then key", async () => {
    await expect(
      runScenario(
        corrupt("core/010-initialization", (scenario) => {
          scenario.then.histroy = {};
        })
      )
    ).rejects.toThrow(
      'scenario core/010-initialization: unknown then key "histroy"'
    );
  });

  it("refuses an unknown key inside a query or a map", async () => {
    await expect(
      runScenario(
        corrupt("durable/042-a-query-can-return-values", (scenario) => {
          scenario.then.queries[0].includeValue = true;
        })
      )
    ).rejects.toThrow(
      'scenario durable/042-a-query-can-return-values: unknown key "includeValue" in then.queries[0]'
    );

    await expect(
      runScenario(
        corrupt(
          "core/163-the-state-map-counts-resident-instances-per-state",
          (scenario) => {
            scenario.then.maps[1].limit = 1;
          }
        )
      )
    ).rejects.toThrow('unknown key "limit" in then.maps[1]');
  });

  it("refuses an unknown step", async () => {
    await expect(
      runScenario(
        corrupt("core/010-initialization", (scenario) => {
          scenario.when.push({ drian: true });
        })
      )
    ).rejects.toThrow(
      'scenario core/010-initialization: unknown step {"drian":true}'
    );
  });

  it.each([
    ["a flag set to false", { drain: false }],
    ["a sweep set to false", { sweep: false }],
    ["a restart set to false", { restart: false }],
    ["two kinds at once", { drain: true, restart: true }],
    ["a wait that is not a number", { wait: "soon" }],
    ["a send with no trigger", { send: { key: "orders:1" } }],
    [
      "a send whose trigger has no type",
      { send: { key: "orders:1", trigger: {} } },
    ],
    [
      "a send whose trigger type is not a string",
      { send: { key: "orders:1", trigger: { type: 1 } } },
    ],
    ["a forget with no key", { forget: {} }],
    ["await on something other than a send", { drain: true, await: false }],
  ])("refuses a step with %s", async (_what, step) => {
    await expect(
      runScenario(
        corrupt("core/010-initialization", (scenario) => {
          scenario.when.push(step);
        })
      )
    ).rejects.toThrow("unknown step");
  });

  it.each([
    ["telemetry", "inbox.enquued"],
    ["telemetryAbsent", "inbox.enquued"],
    ["telemetryAbsent", undefined],
  ])("refuses a %s matcher whose type is %s", async (where, type) => {
    await expect(
      runScenario(
        corrupt("core/060-per-key-fifo", (scenario) => {
          scenario.then[where] = [{ type }];
        })
      )
    ).rejects.toThrow(`then.${where}[0] names no known telemetry event`);
  });
});
