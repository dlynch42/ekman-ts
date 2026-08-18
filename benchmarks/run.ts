/**
 * The benchmark entry point.
 *
 * ```
 * npm run bench                     every suite, compared against the committed baseline
 * npm run bench -- commit-rate      one suite
 * npm run bench -- --save           run, then record what ran as the new baseline
 * ```
 *
 * Comparison is the point of running these, so a run with no baseline says so rather than
 * printing figures that look like they mean something on their own.
 */

import { NAME as COMMIT_RATE, run as commitRate } from "./commit-rate";
import { NAME as CONSTRAINTS, run as constraints } from "./constraints";
import { NAME as EDGE_CHECK, run as edgeCheck } from "./edge-check";
import { NAME as FAN_OUT, run as fanOut } from "./fan-out";
import {
  BASELINE_PATH,
  banner,
  compare,
  currentEnv,
  note,
  printFigure,
  readBaseline,
  type SuiteResult,
  sameMachine,
  writeBaseline,
} from "./lib";
import { NAME as OVERFLOW, run as overflow } from "./overflow";

const SUITES: ReadonlyMap<string, () => Promise<SuiteResult>> = new Map([
  [COMMIT_RATE, commitRate],
  [CONSTRAINTS, constraints],
  [EDGE_CHECK, edgeCheck],
  [FAN_OUT, fanOut],
  [OVERFLOW, overflow],
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const save = args.includes("--save");
  const asked = args.filter((arg) => !arg.startsWith("--"));

  for (const name of asked) {
    if (!SUITES.has(name)) {
      throw new Error(
        `unknown suite "${name}". Known suites: ${[...SUITES.keys()].join(", ")}`
      );
    }
  }

  const selected = asked.length === 0 ? [...SUITES.keys()] : asked;
  const env = currentEnv();
  const baseline = readBaseline();
  const comparable =
    baseline !== undefined && sameMachine(baseline.env, env)
      ? baseline
      : undefined;

  banner("Ekman benchmarks");
  note(`node ${env.node} on ${env.platform}/${env.arch}`);
  note(`${env.cpu}, ${env.cores} cores`);
  reportBaselineState(baseline, comparable);

  const results: SuiteResult[] = [];
  for (const name of selected) {
    const suite = SUITES.get(name);
    if (suite === undefined) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: suites run one at a time so each has the machine to itself
    const result = await suite();
    results.push(result);
    print(result, comparable?.suites[name]);
  }

  if (save) {
    const { merged } = writeBaseline(results);
    console.log(
      `\n  baseline ${merged ? "updated" : "written"}: ${BASELINE_PATH}`
    );
    if (!merged && baseline !== undefined) {
      note(
        "the previous baseline came from different hardware and was replaced rather than merged"
      );
    }
  }
}

function reportBaselineState(
  baseline: ReturnType<typeof readBaseline>,
  comparable: ReturnType<typeof readBaseline>
): void {
  if (baseline === undefined) {
    note("no baseline recorded. Run with --save to record one.");
    return;
  }
  if (comparable === undefined) {
    note(
      `baseline captured on ${baseline.env.cpu} (${baseline.env.platform}/${baseline.env.arch}), which is not this machine.`
    );
    note(
      "figures are reported without comparison. Cross-machine deltas are not evidence."
    );
    return;
  }
  note(`compared against the baseline captured ${baseline.capturedAt}`);
  if (baseline.env.node !== currentEnv().node) {
    note(
      `baseline ran on node ${baseline.env.node}, this run on ${currentEnv().node}. Same machine, different runtime.`
    );
  }
}

function print(
  result: SuiteResult,
  stored:
    | Record<string, { unit: string; value: number; spread: number }>
    | undefined
): void {
  banner(result.suite);
  for (const found of result.figures) {
    const previous = stored?.[found.name];
    const against =
      previous === undefined || previous.unit !== found.unit
        ? undefined
        : compare(found, {
            unit: found.unit,
            better: found.better,
            value: previous.value,
            spread: previous.spread,
          });
    printFigure(found, against);
  }
  for (const line of result.notes ?? []) {
    console.log(`\n  ${line}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
