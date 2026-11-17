/**
 * Query: what it costs to ask a file store which instances are in a state.
 *
 * Run with `npm run bench:query`.
 *
 * A fleet of keys is committed to a file store under a memory budget sized for half of
 * them, so half are resident and half are on disk behind a snapshot. Two questions are then
 * timed. One names a state few instances are in, which is the shape of "what is stuck".
 * The other asks for the ten oldest of everything, which is the shape of a dashboard poll.
 *
 * This is the one suite that touches a disk, because the cost being measured is the reads a
 * query makes. The directory is temporary and removed afterwards.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEntity, Ekman, stay, transitionTo } from "ekman";
import {
  check,
  elapsed,
  figure,
  rounds,
  type SuiteResult,
  TIMED_ROUNDS,
} from "./lib";

export const NAME = "query";

const KEYS = 5000;
const EVENTS_PER_KEY = 5;
const RESIDENT = KEYS / 2;
/** A stuck instance is accounted a little smaller than a running one, so the split is near half, not exactly. */
const TOLERANCE = 0.05;
const STUCK_EVERY = 100;
const STUCK = KEYS / STUCK_EVERY;
const LIMIT = 10;
const QUERIES_PER_ROUND = 5;

const jobs = defineEntity("jobs", {
  initial: "running",
  values: { ticks: 0 },
  states: {
    running: (instance, trigger) =>
      trigger.type === "stall"
        ? transitionTo("stuck")
        : stay({ ticks: instance.values.ticks + 1 }),
    stuck: () => stay(),
  },
});

export async function run(): Promise<SuiteResult> {
  const dir = mkdtempSync(join(tmpdir(), "ekman-bench-query-"));
  const ekman = new Ekman({
    entities: [jobs],
    store: { kind: "file", dir },
    memory: { maxBytes: (await bytesPerInstance()) * RESIDENT },
  });

  try {
    await fill((id, type) => ekman.entities.jobs.send(id, { type }));
    const resident = ekman.memoryUsage.instances;
    check(
      Math.abs(resident - RESIDENT) <= RESIDENT * TOLERANCE,
      `${resident} instances resident under a budget for about ${RESIDENT}`
    );

    const byState = await rounds(TIMED_ROUNDS, () =>
      perQuery(async () => {
        const found = await ekman.query({ entity: "jobs", state: "stuck" });
        check(
          found.complete && found.instances.length === STUCK,
          `expected ${STUCK} stuck instances, found ${found.instances.length}`
        );
      })
    );

    const limited = await rounds(TIMED_ROUNDS, () =>
      perQuery(async () => {
        const found = await ekman.query({ entity: "jobs", limit: LIMIT });
        check(
          found.instances.length === LIMIT &&
            found.reasons.includes("limit-reached"),
          `expected the ${LIMIT} oldest and a reported truncation`
        );
      })
    );

    return {
      suite: NAME,
      figures: [
        figure(`by state, ${STUCK} of ${KEYS} match`, "ms", "lower", byState),
        figure(`oldest ${LIMIT} of ${KEYS}`, "ms", "lower", limited),
      ],
      notes: [
        `${resident.toLocaleString("en-US")} of ${KEYS.toLocaleString("en-US")} instances were resident. The rest were answered from disk.`,
      ],
    };
  } finally {
    await ekman.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What one instance is accounted at, measured so the budget tracks the accounting basis. */
async function bytesPerInstance(): Promise<number> {
  const probe = new Ekman({ entities: [jobs], store: "memory" });
  try {
    for (let n = 0; n < EVENTS_PER_KEY; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one key, so its commits are in order by definition
      await probe.entities.jobs.send("k0000", { type: "tick" });
    }
    return probe.memoryUsage.bytes;
  } finally {
    await probe.close();
  }
}

async function fill(
  send: (id: string, type: string) => Promise<unknown>
): Promise<void> {
  for (let n = 0; n < KEYS; n += 1) {
    const id = `k${String(n).padStart(4, "0")}`;
    for (let event = 1; event <= EVENTS_PER_KEY; event += 1) {
      const stalls = event === EVENTS_PER_KEY && n % STUCK_EVERY === 0;
      // biome-ignore lint/performance/noAwaitInLoops: filling in order keeps the eviction order known
      await send(id, stalls ? "stall" : "tick");
    }
  }
}

/** Milliseconds per query, averaged over a few so one slow read does not carry a round. */
async function perQuery(ask: () => Promise<void>): Promise<number> {
  const ms = await elapsed(async () => {
    for (let n = 0; n < QUERIES_PER_ROUND; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one query at a time, so each has the disk to itself
      await ask();
    }
  });
  return ms / QUERIES_PER_ROUND;
}
