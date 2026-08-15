/**
 * Memory bound: thousands of instances, a small budget, and a process that stays inside it.
 *
 * Run with `npm run demo:memory-bound`.
 *
 * Cold instances are evicted, snapshotted on the way out, and reloaded transparently when
 * a trigger arrives for them. The application code below never mentions any of that: it
 * sends triggers and reads results, exactly as it would with an unlimited budget.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEntity, Ekman, fileStore, stay } from "../src/index";

const INSTANCES = 5000;
const BUDGET = 64 * 1024;

const sessions = defineEntity("sessions", {
  initial: "active",
  values: { hits: 0, payload: "" },
  states: {
    active: (session) =>
      stay({
        hits: session.values.hits + 1,
        // Enough per instance that a few thousand of them will not fit in the budget.
        payload: "x".repeat(64),
      }),
  },
});

const dir = mkdtempSync(join(tmpdir(), "ekman-memory-"));

async function main(): Promise<void> {
  let evicted = 0;
  let restored = 0;
  let peakAtCommit = 0;
  let largestInstance = 0;

  const ekman = new Ekman({
    entities: [sessions],
    store: fileStore(dir),
    memory: {
      maxBytes: BUDGET,
      eviction: { policy: "lru", snapshotOnEvict: true },
    },
    telemetry: {
      "instance.evicted": () => {
        evicted += 1;
      },
      "instance.restored": () => {
        restored += 1;
      },
      "memory.accounted": (event) => {
        peakAtCommit = Math.max(peakAtCommit, event.residentBytes);
        largestInstance = Math.max(largestInstance, event.bytes);
      },
    },
  });

  console.log(
    `budget: ${BUDGET} bytes, instances: ${INSTANCES}\n` +
      "accounting basis: UTF-8 bytes of key + state + serialized values, at commit\n"
  );

  // A first pass over every key. Long before the end, the earliest ones have been evicted.
  for (let i = 0; i < INSTANCES; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sending them all at once would put 5000 triggers in flight, which measures the inbox rather than the budget
    await ekman.entities.sessions.send(`s${i}`, { type: "hit" });
  }

  const afterFirstPass = ekman.memoryUsage;
  console.log("after one pass over every key:");
  console.log(
    `  resident   ${afterFirstPass.instances} instances, ${afterFirstPass.bytes} bytes`
  );
  console.log(`  evicted    ${evicted}`);

  // Now go back to the coldest keys. Every one of these has been evicted and has to come
  // back from the store, and the caller cannot tell.
  const revisited = 200;
  for (let i = 0; i < revisited; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each reload is meant to happen on its own, so the eviction it triggers is attributable
    const result = await ekman.entities.sessions.send(`s${i}`, { type: "hit" });
    if (result.values.hits !== 2) {
      throw new Error(
        `s${i} came back with hits=${result.values.hits}, so its state did not survive`
      );
    }
  }

  const end = ekman.memoryUsage;
  console.log(`\nafter revisiting the ${revisited} coldest keys:`);
  console.log(`  resident   ${end.instances} instances, ${end.bytes} bytes`);
  console.log(`  restored   ${restored}`);
  console.log(
    "  every one came back with hits=2, so nothing was lost on the way out"
  );

  // Eviction runs when a key goes idle, never mid-handler, so the resident set can sit
  // above the budget by at most the one instance that is currently committing. Stating
  // the bound is more useful than pretending it is zero.
  const overshoot = peakAtCommit - BUDGET;
  console.log("\nbudget:");
  console.log(`  settled       ${end.bytes} bytes, at or under ${BUDGET}`);
  console.log(
    `  peak at commit ${peakAtCommit} bytes, ${overshoot > 0 ? `${overshoot} over` : "under"}`
  );
  console.log(
    `  largest single instance ${largestInstance} bytes, which is the bound on that overshoot`
  );

  if (end.bytes > BUDGET || overshoot > largestInstance) {
    throw new Error(
      `the budget was not held: settled at ${end.bytes}, peaked ${overshoot} over`
    );
  }
  console.log(
    `\nthe resident set stayed inside its ${BUDGET} byte allowance throughout.`
  );

  await ekman.close();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
