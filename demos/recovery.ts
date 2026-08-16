/**
 * Recovery: kill a service mid-workflow, restart it, watch every instance resume.
 *
 * Run with `npm run demo:recovery`.
 *
 * The first runtime commits some work and is then thrown away without ceremony, exactly as
 * a crash would. The second runtime is built from nothing but the same directory on disk,
 * and every instance comes back in its exact state, with its values and its sequence.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineEntity,
  Ekman,
  fileStore,
  stay,
  transitionTo,
} from "ekman";

type State = "pending" | "deploying" | "live" | "failed";
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

const dir = mkdtempSync(join(tmpdir(), "ekman-recovery-"));
const keys = ["alpha", "bravo", "charlie"];

async function main(): Promise<void> {
  console.log(`store: ${dir}\n`);

  // ---- the service, first run --------------------------------------------------
  const first = new Ekman({
    entities: [deployments],
    store: fileStore(dir),
  });

  for (const id of keys) {
    // biome-ignore lint/performance/noAwaitInLoops: a demo reads best as the sequence of events it is describing
    await first.entities.deployments.send(id, {
      type: "start",
      region: "us-west-2",
    });
  }
  // One of them gets further than the others before the lights go out.
  await first.entities.deployments.send("alpha", { type: "succeeded" });

  console.log("before the crash:");
  report(first);

  // ---- the crash ---------------------------------------------------------------
  // No graceful shutdown, no flush, no drain. Every commit above already reached the
  // authority before its sender was told it had, which is the entire claim.
  await first.close();

  // ---- the service, restarted --------------------------------------------------
  const second = new Ekman({
    entities: [deployments],
    store: fileStore(dir),
  });

  // Nothing is resident yet: this runtime has never seen these keys.
  console.log(`\nafter the restart, resident: ${second.residentKeys.length}`);

  // Instances come back on their next trigger, and the caller cannot tell.
  await second.entities.deployments.send("bravo", { type: "succeeded" });
  await second.entities.deployments.send("charlie", { type: "failed" });
  await second.entities.deployments.send("alpha", { type: "poke" });

  console.log("\nafter the restart:");
  report(second);

  // The whole life of the instance, read back through the store: what the first runtime
  // wrote, the point this one picked it up, and what it has done since.
  console.log("\nalpha's stream, from before the crash to now:");
  const { events, complete } =
    await second.entities.deployments.history("alpha");
  for (const event of events) {
    console.log(`  ${describe(event)}`);
  }
  console.log(`  (complete: ${complete})`);

  // What is stuck, and for how long: the question the whole operational layer exists for.
  const stuck = await second.entities.deployments.query({ state: "failed" });
  console.log("\nanything left failed:");
  for (const instance of stuck.instances) {
    console.log(
      `  ${instance.key}  ${instance.state}  age=${instance.ageMs}ms`
    );
  }

  await second.close();
}

function report(ekman: Ekman<readonly [typeof deployments]>): void {
  for (const id of keys) {
    const instance = ekman.entities.deployments.inspect(id);
    if (instance === undefined) {
      console.log(`  ${id.padEnd(8)} not resident`);
      continue;
    }
    console.log(
      `  ${id.padEnd(8)} ${(instance.state as State).padEnd(10)} seq=${instance.seq}  ` +
        `region=${instance.values.region} attempt=${instance.values.attempt}`
    );
  }
}

function describe(event: { type: string; seq: number }): string {
  if (event.type === "transition") {
    const transition = event as unknown as { from: string | null; to: string };
    return `${event.type}  ${transition.from ?? "(new)"} -> ${transition.to}  seq=${event.seq}`;
  }
  return `${event.type}  seq=${event.seq}`;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
