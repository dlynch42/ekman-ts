/**
 * End-to-end smoke test for the example service.
 *
 * Run with `npm run example:smoke`.
 *
 * This exists so the example cannot rot. It boots the real server on an ephemeral port,
 * drives it over real HTTP, and asserts, so a change to the library that breaks the way a
 * service is meant to use it fails here rather than in somebody's editor three months
 * later.
 *
 * It also covers the parts of the example a `curl` session would not reach on its own:
 * the time-in-state escalation, the incident that opens as a reaction to it, and the fact
 * that a second runtime over the same directory sees everything the first one committed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ekman-deploy-service-"));

// Set before anything imports `lib/config`, which reads the environment once at load.
// That is why every import below is dynamic: a static import would be hoisted above this.
process.env.DATA_DIR = dir;
process.env.STUCK_AFTER_MS = "120";
process.env.SWEEP_MS = "10000";
process.env.MEMORY_BYTES = "65536";

let base = "";
let failures = 0;

async function main(): Promise<void> {
  const { buildServer } = await import("./src/app");
  const { ekman } = await import("./src/lib/runtime");
  const { drainOnce } = await import("./src/workers/consumer");

  const server = buildServer();
  base = `http://localhost:${await listen(server)}`;
  console.log(`smoke: ${base}\n  state: ${dir}\n`);

  try {
    await theHappyPath();
    await theRefusals();
    await theQueueConsumer(drainOnce);
    await theTimeBound(ekman);
    await theOpsEndpoints();
    await durability(dir);
  } finally {
    // In a `finally` so a failed check still tears the server down rather than leaving a
    // port bound and the script hanging.
    await shutdown(server, ekman);
  }

  console.log(
    failures === 0 ? "\nall checks passed\n" : `\n${failures} checks FAILED\n`
  );
  process.exitCode = failures === 0 ? 0 : 1;

  // Belt and braces. `shutdown` should have released everything, and if it did, node exits
  // here and this timer never fires because `unref` means it is not itself a reason to
  // stay alive. If something *is* still holding the loop open, a script that hangs forever
  // in CI is worse than one that says so and leaves.
  const bail = setTimeout(() => {
    console.error(
      "the event loop is still busy after shutdown; something was left open"
    );
    process.exit(failures === 0 ? 0 : 1);
  }, 2000);
  bail.unref();
}

/**
 * Stop the server and release the runtime, so the process can exit on its own.
 *
 * `closeAllConnections` is the part that is easy to miss: `fetch` uses keep-alive, so the
 * sockets from the checks above outlive their responses and `server.close()` would sit
 * waiting for them to time out.
 */
async function shutdown(
  server: Server,
  ekman: { close: () => Promise<void> }
): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // Clears the sweep interval and releases the stores. The sweep timer is unref'd by the
  // runtime, so it would not hold the process open on its own, but a store may be holding
  // a real handle and closing is what a service does on shutdown.
  await ekman.close();
}

/** Deploy, succeed, roll back. */
async function theHappyPath(): Promise<void> {
  section("the happy path");

  const created = await call("POST", "/deployments/checkout-api", {
    service: "checkout-api",
    region: "us-west-2",
    version: "2.4.1",
  });
  check("create returns 201", created.status === 201, created.status);
  check(
    "and lands in deploying",
    body(created).state === "deploying",
    body(created).state
  );

  const live = await call("POST", "/deployments/checkout-api/events", {
    type: "succeeded",
  });
  check("succeeded returns 200", live.status === 200, live.status);
  check("and lands in live", body(live).state === "live", body(live).state);

  const read = await call("GET", "/deployments/checkout-api");
  check("read returns 200", read.status === 200, read.status);
  check("with seq 2", body(read).seq === 2, body(read).seq);

  const rolled = await call("POST", "/deployments/checkout-api/events", {
    type: "rollback",
    reason: "latency regression",
  });
  check(
    "rollback lands in rolled-back",
    body(rolled).state === "rolled-back",
    body(rolled).state
  );
}

/** Everything the service refuses, and the status code it refuses with. */
async function theRefusals(): Promise<void> {
  section("refusals");

  const missing = await call("POST", "/deployments/no-region", {
    service: "x",
    version: "1",
  });
  check("a missing field is 400", missing.status === 400, missing.status);

  const typo = await call("POST", "/deployments/checkout-api/events", {
    type: "succeded",
  });
  check("an undeclared trigger is 422", typo.status === 422, typo.status);
  check(
    "and says UNKNOWN_TRIGGER",
    body(typo).error === "UNKNOWN_TRIGGER",
    body(typo).error
  );

  // The transition graph, not the handler. The handler tried; the runtime refused.
  const redeploy = await call("POST", "/deployments/checkout-api", {
    service: "checkout-api",
    region: "us-west-2",
    version: "2.4.2",
  });
  check(
    "redeploying a rolled-back deployment is 409",
    redeploy.status === 409,
    redeploy.status
  );
  check(
    "and says CONSTRAINT_VIOLATED",
    body(redeploy).error === "CONSTRAINT_VIOLATED",
    body(redeploy).error
  );

  const gone = await call("GET", "/deployments/never-existed");
  check("an unknown deployment is 404", gone.status === 404, gone.status);

  // Both refusals are on the deployment's own record, in the same stream as its
  // transitions, at the sequence they were refused at.
  const history = await call("GET", "/deployments/checkout-api/history");
  const events = (body(history).events as { type: string }[] | undefined) ?? [];
  const rejected = events.filter((event) => event.type === "rejected");
  const violations = events.filter((event) => event.type === "violation");
  check(
    "history records the refused trigger",
    rejected.length === 1,
    rejected.length
  );
  check(
    "history records the violation",
    violations.length === 1,
    violations.length
  );
  check(
    "and the history is complete",
    body(history).complete === true,
    body(history).complete
  );
}

/** The same runtime, driven by something that is not HTTP. */
async function theQueueConsumer(
  drainOnce: () => Promise<{
    committed: number;
    refused: number;
    lines: readonly string[];
  }>
): Promise<void> {
  section("the queue consumer");

  const { committed, refused, lines } = await drainOnce();
  for (const line of lines) {
    console.log(`  ${line.trim()}`);
  }

  // Six messages: four legitimate, one redelivery that the graph refuses, one typo.
  check("four messages committed", committed === 4, committed);
  check("two were refused", refused === 2, refused);
}

/** Time in state, escalated as a trigger, and the incident that follows. */
async function theTimeBound(ekman: {
  sweep: () => Promise<number>;
}): Promise<void> {
  section("the time bound");

  await call("POST", "/deployments/wedged-api", {
    service: "wedged-api",
    region: "us-east-1",
    version: "0.1.0",
  });

  const stuckNow = await call(
    "GET",
    "/ops/stuck?state=deploying&olderThan=0ms"
  );
  check(
    "the new deployment shows as deploying",
    (body(stuckNow).count as number) >= 1,
    body(stuckNow).count
  );

  // Wait past the bound, then sweep by hand rather than waiting for the interval.
  await delay(200);
  const escalated = await ekman.sweep();
  check("the sweep escalated it", escalated >= 1, escalated);

  const after = await call("GET", "/deployments/wedged-api");
  check(
    "and the handler moved it to failed",
    body(after).state === "failed",
    body(after).state
  );

  // The escalation did not write that state. It arrived as a trigger, the handler in
  // `entities/deployment.ts` decided, and this is the result of that decision.
  const stuckAfter = await call(
    "GET",
    "/ops/stuck?state=deploying&olderThan=0ms"
  );
  check(
    "and it is no longer stuck",
    !JSON.stringify(body(stuckAfter).instances).includes("wedged-api"),
    body(stuckAfter).count
  );

  // The incident is opened by an audit sink, which is out of band, so it may not be there
  // the instant the commit resolves. That is the trade, and it is why this polls.
  const opened = await until(async () => {
    const incidents = await call("GET", "/ops/incidents");
    return (body(incidents).count as number) >= 1;
  }, 2000);
  check("an incident was opened in reaction", opened, opened);
}

async function theOpsEndpoints(): Promise<void> {
  section("the ops endpoints");

  const metrics = await call("GET", "/ops/metrics");
  check("metrics returns 200", metrics.status === 200, metrics.status);

  const counters = body(metrics).counters as Record<string, number | undefined>;
  check(
    "telemetry counted committed handlers",
    (counters["handler.settled.committed"] ?? 0) > 0,
    counters["handler.settled.committed"]
  );
  check(
    "and counted the constraint violation",
    (counters["constraint.violated"] ?? 0) > 0,
    counters["constraint.violated"]
  );
  check(
    "and counted the escalation",
    (counters["constraint.escalated"] ?? 0) > 0,
    counters["constraint.escalated"]
  );

  const health = await call("GET", "/health");
  check("health returns 200", health.status === 200, health.status);
}

/** A second runtime over the same directory sees everything the first one committed. */
async function durability(dataDir: string): Promise<void> {
  section("durability");

  const { Ekman, fileStore } = await import("ekman");
  const { deployment } = await import("./src/entities/deployment");

  const fresh = new Ekman({
    entities: [deployment],
    store: fileStore(dataDir),
  });

  const result = await fresh.entities.deployments.query({});
  const keys = result.instances.map((match) => match.key);

  console.log(
    `  a fresh runtime sees ${keys.length} deployments: ${keys.join(", ")}`
  );

  check(
    "it sees the rolled-back deployment",
    keys.includes("deployments:checkout-api"),
    keys
  );
  check("and the answer is complete", result.complete, result.reasons);

  const history = await fresh.entities.deployments.history("checkout-api");
  check(
    "and can read its full history",
    history.events.length >= 4,
    history.events.length
  );

  await fresh.close();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind to a port");
  }
  return address.port;
}

interface Response {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  payload?: Record<string, unknown>
): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json: parsed };
}

function body(response: Response): Record<string, unknown> {
  return response.json;
}

/** Poll until a condition holds, or give up. */
async function until(
  condition: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by definition
    if (await condition()) {
      return true;
    }
    await delay(10);
  }
  return false;
}

function check(what: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok    ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${what}  (got ${JSON.stringify(detail)})`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
