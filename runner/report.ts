import type { ScenarioResult } from "./run";
import type { Level } from "./scenario";
import { CLAIMED_LEVELS, LEVELS } from "./scenario";

export interface Report {
  readonly results: readonly ScenarioResult[];
  readonly passed: number;
  readonly failed: number;
  /** True when every scenario at a claimed level passed. */
  readonly conforming: boolean;
}

export function summarize(results: readonly ScenarioResult[]): Report {
  const claimed = results.filter((r) =>
    CLAIMED_LEVELS.includes(r.scenario.level)
  );

  return {
    results,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    conforming: claimed.every((r) => r.status === "passed"),
  };
}

const TICK = "✓";
const CROSS = "✗";

export function format(report: Report): string {
  const lines: string[] = ["", "Ekman conformance", ""];

  for (const level of LEVELS) {
    const results = report.results.filter((r) => r.scenario.level === level);
    const claimed = CLAIMED_LEVELS.includes(level);

    if (results.length === 0) {
      lines.push(
        claimed
          ? `  ${level}: claimed, but no scenarios found`
          : `  ${level}: not claimed (no scenarios yet)`,
        ""
      );
      continue;
    }

    const failed = results.filter((r) => r.status === "failed").length;
    // A level with scenarios is always run and always reported, claimed or not. Building
    // towards a level and not seeing whether you are getting there would be pointless, and
    // a level whose scenarios are green but incomplete should say exactly that.
    lines.push(
      `  ${level}: ${results.length - failed}/${results.length} passing` +
        (claimed ? "" : " (not claimed yet)")
    );

    for (const result of results) {
      const mark = result.status === "passed" ? TICK : CROSS;
      lines.push(`    ${mark} ${result.scenario.id}  ${result.scenario.name}`);
      for (const failure of result.failures) {
        lines.push(`        ${failure}`);
      }
    }
    lines.push("");
  }

  lines.push(
    report.conforming
      ? `Conforming at: ${CLAIMED_LEVELS.join(", ")}`
      : `NOT conforming. ${report.failed} scenario${report.failed === 1 ? "" : "s"} failing.`,
    ""
  );

  return lines.join("\n");
}

export function levelOf(id: string): Level {
  return id.split("/")[0] as Level;
}
