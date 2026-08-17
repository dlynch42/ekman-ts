/**
 * Recovery: kill a service mid-workflow, restart it, watch every instance resume.
 *
 * Run with `npm run demo:recovery`.
 *
 * The first runtime commits a few hundred deployments, each at a different point in its
 * lifecycle, and is then thrown away without ceremony, exactly as a crash would. The second
 * runtime is built from nothing but the same directory on disk. Nothing is resident, and
 * every instance comes back on its next trigger in its exact state, with its values and its
 * sequence, without the caller doing anything to ask for it.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { defaultLogDir, defineEntity, Ekman, stay, transitionTo } from "ekman";
import { banner, check, row, stream } from "./lib";

interface Values extends Record<string, unknown> {
  region: string;
  attempt: number;
}

const deployments = defineEntity("deployments", {
  initial: "pending",
  values: { region: "", attempt: 0 } as Values,
  states: {
    pending: (deployment, trigger) =>
      transitionTo("deploying", {
        ...deployment.values,
        region: trigger.region as string,
        attempt: 1,
      }),
    deploying: (deployment, trigger) =>
      trigger.type === "succeeded"
        ? transitionTo("live", deployment.values)
        : transitionTo("failed", deployment.values),
    live: (deployment) => stay(deployment.values),
    failed: (deployment) => stay(deployment.values),
  },
});

// A named directory rather than a temporary one, cleared on the way in rather than out, so
// the log this demo wrote is still there to read when it finishes. Its own subdirectory, so
// clearing it can never reach anything another demo or the example app put there.
const dir = join(defaultLogDir(), "demos", "recovery");
rmSync(dir, { recursive: true, force: true });

const INSTANCES = 300;
const ids = Array.from({ length: INSTANCES }, (_, i) => `d${i}`);
/** A third get all the way to live, a third fail, a third are caught mid-deploy. */
const finished = ids.filter((_, i) => i % 3 === 0);
const failed = ids.filter((_, i) => i % 3 === 1);
const midFlight = ids.filter((_, i) => i % 3 === 2);

async function main(): Promise<void> {
  console.log(`store: ${dir}\n`);
  const before = await theServiceRunning();
  await theRestart(before);

  console.log(
    `\n${"=".repeat(78)}\n` +
      "Nothing above asked for any of this. There is no load step, no cache warm, no\n" +
      "rehydrate call: a trigger arrives for a key this process has never seen, and the\n" +
      "instance is there by the time the handler runs. The only thing the application\n" +
      "chose was to configure a durable store.\n"
  );
}

interface Before {
  commits: number;
  bytes: number;
}

/** The service, doing its job, until it does not. */
async function theServiceRunning(): Promise<Before> {
  banner(`1. A service with ${INSTANCES} deployments in flight`);

  const first = new Ekman({
    entities: [deployments],
    store: { kind: "file", dir },
  });

  let commits = 0;
  for (const id of ids) {
    // biome-ignore lint/performance/noAwaitInLoops: each has to land before the next, which is what makes the counts exact
    await first.entities.deployments.send(id, {
      type: "start",
      region: "us-west-2",
    });
    commits += 1;
  }
  for (const id of finished) {
    // biome-ignore lint/performance/noAwaitInLoops: same
    await first.entities.deployments.send(id, { type: "succeeded" });
    commits += 1;
  }
  for (const id of failed) {
    // biome-ignore lint/performance/noAwaitInLoops: same
    await first.entities.deployments.send(id, { type: "failed" });
    commits += 1;
  }

  const { bytes } = first.storageUsage;
  row("instances", INSTANCES);
  row("commits", commits, "counting initialization");
  row("resident", first.residentKeys.length);
  row("on disk", `${bytes.toLocaleString()} bytes`);
  row(
    "live/failed/deploying",
    `${finished.length}/${failed.length}/${midFlight.length}`
  );

  // No graceful shutdown, no flush, no drain. Every commit above already reached the
  // authority before its sender was told it had, which is the entire claim.
  await first.close();
  console.log("\n  ...process gone, without warning...");

  return { commits, bytes };
}

/** A new process over the same bytes, and what it costs to get everything back. */
async function theRestart(before: Before): Promise<void> {
  banner("2. A new process, built from the directory alone");

  let restored = 0;
  let replayed = 0;
  const second = new Ekman({
    entities: [deployments],
    store: { kind: "file", dir },
    telemetry: {
      "instance.restored": (event) => {
        restored += 1;
        replayed += event.replayed;
      },
    },
  });

  row(
    "resident at startup",
    second.residentKeys.length,
    "it has seen nothing yet"
  );

  // Every one of these is a key this process has never heard of. None of them is loaded
  // first: the trigger arrives, and the instance is simply there.
  const started = Date.now();
  for (const id of midFlight) {
    // biome-ignore lint/performance/noAwaitInLoops: each restore is meant to be attributable to its own trigger
    await second.entities.deployments.send(id, { type: "succeeded" });
  }
  const elapsed = Date.now() - started;

  row("triggers sent", midFlight.length, "to keys never seen by this process");
  row("instances restored", restored);
  row("events replayed", replayed, "to rebuild them");
  row(
    "elapsed",
    `${elapsed}ms`,
    `${Math.round((elapsed / midFlight.length) * 1000)}µs per instance`
  );

  check(
    restored === midFlight.length,
    `expected ${midFlight.length} restores, saw ${restored}`
  );

  // The query reads through the store, so it answers about instances this process has
  // still never touched.
  const stuck = await second.entities.deployments.query({ state: "failed" });
  const live = await second.entities.deployments.query({ state: "live" });
  console.log("");
  row("resident now", second.residentKeys.length, "only what was triggered");
  row("query: failed", stuck.instances.length, "answered from the store");
  row("query: live", live.instances.length);

  check(
    stuck.instances.length === failed.length,
    `expected ${failed.length} failed, found ${stuck.instances.length}`
  );
  check(
    live.instances.length === finished.length + midFlight.length,
    `expected ${finished.length + midFlight.length} live, found ${live.instances.length}`
  );

  // One instance's whole life, across the crash. The first two events were written by a
  // process that no longer exists; the restore is where this one picked it up.
  const id = midFlight[0] as string;
  const { events, complete } = await second.entities.deployments.history(id);
  console.log("\n  one instance, from before the crash to now:\n");
  stream(`deployments:${id}`, events);
  row("complete", String(complete));

  check(
    events.some((event) => event.type === "restored"),
    "the stream does not record where this process picked the instance up"
  );
  check(
    before.commits > 0 && before.bytes > 0,
    "nothing was written before the crash, so nothing was recovered"
  );

  await second.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
