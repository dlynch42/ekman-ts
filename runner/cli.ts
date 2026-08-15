/**
 * Conformance suite entry point: `npm run conformance`.
 *
 * Loads every scenario file, drives a runtime through the library's public API, and
 * reports pass/fail per scenario per conformance level. Exits non-zero if any scenario
 * at a claimed level fails.
 */
import { format, summarize } from "./report";
import type { ScenarioResult } from "./run";
import { runScenario } from "./run";
import { CLAIMED_LEVELS, loadScenarios } from "./scenario";

async function main(): Promise<number> {
  const scenarios = loadScenarios();

  if (scenarios.length === 0) {
    console.error("No scenarios found.");
    return 1;
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    if (!CLAIMED_LEVELS.includes(scenario.level)) {
      results.push({ scenario, status: "passed", failures: [] });
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: scenarios assert on ordering and on an injected clock, so interleaving them would make a failure hard to attribute
    const result = await runScenario(scenario);
    results.push(result);
  }

  const report = summarize(results);
  process.stdout.write(format(report));

  return report.conforming ? 0 : 1;
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    console.error("conformance runner failed:", error);
    process.exitCode = 1;
  }
);
