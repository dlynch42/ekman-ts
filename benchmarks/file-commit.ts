/**
 * File commit: what a commit costs once it has to reach a file.
 *
 * Run with `npm run bench:file-commit`.
 *
 * Many keys, each committed to in turn through a file store in a temporary directory. The
 * workload runs twice. Once with the default per-log limit, which nothing here reaches, so
 * the figures are the write path alone. Once with a limit small enough that every log
 * passes it several times, so the figures include compaction, and the p99 shows whether a
 * sender waits for it.
 *
 * Sends are awaited one at a time, and the loop gives the event loop a turn after each
 * pass over the keys, the way a server does between requests. Work a store puts off until
 * the caller is not waiting gets its chance there. The rate is taken over the whole run,
 * turns and shutdown included, so that work is paid for in the figure and not hidden by it.
 *
 * Each sample costs two clock reads, which is a fraction of a percent of a commit that
 * writes to a file, so rate and latency come from one pass.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEntity, Ekman, stay } from "ekman";
import {
  check,
  figure,
  opsPerSec,
  percentile,
  type SuiteResult,
  sortNumeric,
  WARMUP_ROUNDS,
} from "./lib";

export const NAME = "file-commit";

/** Few enough that creating each key's file is under one percent of the commits. */
const KEYS = 100;
const COMMITS = 20_000;
const TIMED = 5;
/** About a kilobyte per event, so a log reaches a small limit within one run. */
const PADDING = "x".repeat(1024);
const SMALL_LOG_BYTES = 16 * 1024;

const records = defineEntity("records", {
  initial: "open",
  values: { n: 0, padding: PADDING },
  states: {
    open: (instance) => stay({ n: instance.values.n + 1, padding: PADDING }),
  },
});

interface Pass {
  readonly rate: number;
  readonly p50: number;
  readonly p99: number;
}

export async function run(): Promise<SuiteResult> {
  const plain = await passes(undefined);
  const compacting = await passes(SMALL_LOG_BYTES);

  return {
    suite: NAME,
    figures: [...figures("", plain), ...figures("compacting: ", compacting)],
    notes: [
      "In the compacting run, p99 close to p50 means no sender waited for a log to be folded.",
    ],
  };
}

function figures(prefix: string, results: readonly Pass[]) {
  return [
    figure(
      `${prefix}commits, ${KEYS} keys`,
      "ops/sec",
      "higher",
      results.map((one) => one.rate)
    ),
    figure(
      `${prefix}send to commit, p50`,
      "ms",
      "lower",
      results.map((one) => one.p50)
    ),
    figure(
      `${prefix}send to commit, p99`,
      "ms",
      "lower",
      results.map((one) => one.p99)
    ),
  ];
}

async function passes(perLogBytes: number | undefined): Promise<Pass[]> {
  const kept: Pass[] = [];
  for (let round = 0; round < WARMUP_ROUNDS + TIMED; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: rounds are sequential, so each has the disk to itself
    const result = await pass(perLogBytes);
    if (round >= WARMUP_ROUNDS) {
      kept.push(result);
    }
  }
  return kept;
}

async function pass(perLogBytes: number | undefined): Promise<Pass> {
  const dir = mkdtempSync(join(tmpdir(), "ekman-bench-file-commit-"));
  const ekman = new Ekman({
    entities: [records],
    store: {
      kind: "file",
      dir,
      ...(perLogBytes === undefined ? {} : { retention: { perLogBytes } }),
    },
  });
  const samples: number[] = [];

  try {
    const started = process.hrtime.bigint();
    for (let n = 0; n < COMMITS; n += 1) {
      const key = n % KEYS;
      if (key === 0) {
        // biome-ignore lint/performance/noAwaitInLoops: the turn between passes is part of the workload
        await new Promise((turn) => setImmediate(turn));
      }
      const sent = process.hrtime.bigint();
      await ekman.entities.records.send(`k${key}`, { type: "tick" });
      samples.push(Number(process.hrtime.bigint() - sent) / 1e6);
    }

    const landed = ekman.entities.records.inspect("k0")?.values.n;
    check(
      landed === COMMITS / KEYS,
      `${String(landed)} commits landed on a key, expected ${COMMITS / KEYS}`
    );
    await ekman.close();

    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const sorted = sortNumeric(samples);
    return {
      rate: opsPerSec(COMMITS, ms),
      p50: percentile(sorted, 50),
      p99: percentile(sorted, 99),
    };
  } finally {
    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
