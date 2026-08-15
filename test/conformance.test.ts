import { describe, expect, it } from "vitest";
import { runScenario } from "../runner/run";
import { CLAIMED_LEVELS, LEVELS, loadScenarios } from "../runner/scenario";

const scenarios = loadScenarios();

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
        const test = claimed ? it : it.skip;
        test(`${scenario.id}: ${scenario.name}`, async () => {
          const result = await runScenario(scenario);
          expect(result.failures).toEqual([]);
          expect(result.status).toBe("passed");
        });
      }
    });
  }
});
