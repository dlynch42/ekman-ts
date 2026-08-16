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
    server.listen(config.port, resolve);
  });

  console.log(`deploy-service listening on http://localhost:${config.port}`);
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
  console.log(
    "\nthen stop this process and start it again: everything is still here.\n"
  );
}

/**
 * Shut down in the order that keeps promises made to callers.
 *
 * The server stops accepting first, so nothing new arrives. `ekman.close()` releases the
 * stores. Anything already committed is already durable, so there is nothing to flush.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down`);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await ekman.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
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
