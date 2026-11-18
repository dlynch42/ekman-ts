/**
 * The entrypoint.
 *
 * Run with `npm run example:api`.
 *
 * Starts the HTTP API and drains the queue backlog once, both against the single runtime
 * in `lib/runtime.ts`. Stop it and start it again: the deployments are still there, in
 * their exact states, with their histories intact, because the commit authority is a
 * durable store rather than the process.
 */

import { buildServer } from "./app";
import { config } from "./lib/config";
import { ekman } from "./lib/runtime";
import { drainOnce } from "./workers/consumer";

const server = buildServer();

async function main(): Promise<void> {
  await new Promise<void>((resolve) => {
    // The host is named. Leaving it out binds every interface the machine has.
    server.listen(config.port, config.host, resolve);
  });

  console.log(
    `deploy-service listening on http://${config.host}:${config.port}`
  );
  console.log(`state:  ${config.dataDir}`);
  console.log(
    `budget: ${config.memoryBytes} bytes, inbox ${config.inboxCapacity}, stuck after ${config.stuckAfterMs}ms\n`
  );

  console.log("draining the queue backlog:");
  const { lines, committed, refused } = await drainOnce();
  for (const line of lines) {
    console.log(line);
  }
  console.log(`\n  ${committed} committed, ${refused} refused\n`);

  console.log("try:");
  console.log(
    `  curl -XPOST localhost:${config.port}/deployments/billing-api -H 'content-type: application/json' \\\n` +
      `       -d '{"service":"billing-api","region":"us-east-1","version":"1.0.0"}'`
  );
  console.log(`  curl localhost:${config.port}/ops/stuck?olderThan=0ms`);
  console.log(
    `  curl localhost:${config.port}/deployments/checkout-api/history`
  );
  console.log(`  curl localhost:${config.port}/ops/metrics`);
  if (config.opsToken === "") {
    console.log(
      "\n  /ops/prune and /ops/sweep are off. Set OPS_TOKEN to turn them on."
    );
  }
  console.log(
    "\nthen stop this process and start it again: everything is still here.\n"
  );
}

/** How long shutdown waits for handlers that are still running before closing anyway. */
const DRAIN_MS = 10_000;

let stopping = false;

/**
 * Shut down in the order that keeps promises made to callers.
 *
 * The server stops accepting first, so nothing new arrives, and requests already in hand
 * get their answers, which they need the runtime for. Then `ekman.close()` refuses new
 * triggers, lets handlers that are running commit, and closes the stores. It waits at most
 * `DRAIN_MS`, so one handler that never returns cannot hold the process open past the
 * point where whatever sent the signal gives up and kills it.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down`);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await ekman.close({ timeoutMs: DRAIN_MS });
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // A second signal while the first is still draining changes nothing. Closing a server
    // that is already closing is an error, and it would turn a clean exit into a failed one.
    if (stopping) {
      return;
    }
    stopping = true;
    shutdown(signal).catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
