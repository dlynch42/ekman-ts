/**
 * The entrypoint.
 *
 * Run with `npm run example:health`.
 *
 * Starts the HTTP API and a prober that feeds it synthetic results. Leave it running for
 * a minute and watch `/map`: one service becomes `degraded` because a rule said so, and
 * one becomes `unreachable` because nothing was heard from it. Stop the process and start
 * it again, and every service is where it was.
 */

import { buildServer } from "./app";
import { config } from "./lib/config";
import { ekman } from "./lib/runtime";
import { startProbing } from "./workers/prober";

const server = buildServer();
let stopProbing = (): void => undefined;

async function main(): Promise<void> {
  await new Promise<void>((resolve) => {
    // The host is named. Leaving it out binds every interface the machine has.
    server.listen(config.port, config.host, resolve);
  });

  if (config.probeMs > 0) {
    stopProbing = startProbing(config.probeMs);
  }

  console.log(
    `service-health listening on http://${config.host}:${config.port}`
  );
  console.log(`state:  ${config.dataDir}`);
  console.log(
    `degraded after ${config.failuresBeforeDegraded} failed probes in a row, ` +
      `unreachable after ${config.quietAfterMs}ms of silence\n`
  );
  console.log("try:");
  console.log(`  curl localhost:${config.port}/map`);
  console.log(`  curl localhost:${config.port}/services/payments-api`);
  console.log(`  curl 'localhost:${config.port}/quiet?for=10s'`);
  console.log(
    `  curl -XPOST localhost:${config.port}/services/my-api/probes -H 'content-type: application/json' \\\n` +
      `       -d '{"ok":false,"latencyMs":900,"error":"connection refused"}'\n`
  );
}

/** How long shutdown may take in all, from the signal to the stores being closed. */
const DRAIN_MS = 10_000;

let stopping = false;

/**
 * Stop probing, stop accepting, answer what is in hand, then close the runtime.
 *
 * One deadline covers all of it, started at the signal, so a request that never finishes
 * cannot keep the stores from being closed.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down`);
  const deadline = Date.now() + DRAIN_MS;
  stopProbing();

  const cutOff = setTimeout(() => server.closeAllConnections(), DRAIN_MS);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  clearTimeout(cutOff);

  await ekman.close({ timeoutMs: Math.max(1, deadline - Date.now()) });
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
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
