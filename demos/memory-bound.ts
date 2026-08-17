/**
 * Memory bound: thousands of instances, a small budget, and a process that stays inside it.
 *
 * Run with `npm run demo:memory-bound`.
 *
 * Cold instances are evicted, snapshotted on the way out, and reloaded transparently when
 * a trigger arrives for them. The application code below never mentions any of that: it
 * sends triggers and reads results, exactly as it would with an unlimited budget.
 *
 * Alone among the demos, this one deletes its store directory when it finishes. The others
 * keep theirs because a JSONL log is something you can read with `cat` during an incident,
 * and that argument does not reach five thousand of them. What those files would have told
 * you is printed instead, on the way out.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { defaultLogDir, defineEntity, Ekman, stay } from "ekman";

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

// A named directory rather than a temporary one, cleared on the way in so a run that died
// partway leaves the next one a clean start, and removed again at the end because this demo
// alone writes a log and a snapshot per instance. Its own subdirectory, so clearing it can
// never reach anything another demo or the example app put there.
const dir = join(defaultLogDir(), "demos", "memory-bound");
rmSync(dir, { recursive: true, force: true });

async function main(): Promise<void> {
  console.log(`store: ${dir}\n`);
  let evicted = 0;
  let restored = 0;
  let peakAtCommit = 0;
  let largestInstance = 0;

  const ekman = new Ekman({
    entities: [sessions],
    store: { kind: "file", dir },
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

  // The other axis, and the one a memory budget says nothing about. Every eviction wrote a
  // snapshot and every log outlived the instance that was released, so the bytes below kept
  // growing the whole time the resident number sat still.
  const stored = ekman.storageUsage;
  console.log("\non disk:");
  console.log(`  ${stored.bytes} bytes across ${stored.logs} logs`);
  console.log(
    `  ${Math.round(stored.bytes / BUDGET)}x the resident budget, which is the part bounding RAM does not bound.\n` +
      "  `npm run demo:retention` is that axis."
  );

  await ekman.close();

  // Removed rather than kept, which is this demo's one departure from the others. A run
  // that failed above never reaches here, so a failure still leaves its files to look at.
  rmSync(dir, { recursive: true, force: true });
  console.log(
    `\nremoved ${dir}\n` +
      `  ${stored.logs} logs and a snapshot beside most of them: a file count no one reads,\n` +
      "  and the only thing worth taking off them is printed above."
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
