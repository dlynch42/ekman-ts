import { describe, expect, it } from "vitest";
import { runScenario } from "../runner/run";
import type { Scenario } from "../runner/scenario";
import {
  CLAIMED_LEVELS,
  LEVELS,
  loadScenarios,
  RUN_LEVELS,
} from "../runner/scenario";

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
});
