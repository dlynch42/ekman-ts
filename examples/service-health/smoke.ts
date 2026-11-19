/**
 * End-to-end smoke test for the service-health example.
 *
 * Run with `npm run example:health:smoke`.
 *
 * It boots the real server on an ephemeral port and drives it over real HTTP, on a real
 * clock with short bounds, so the three things the example claims are checked the way a
 * caller would meet them: a rule moving a service that keeps failing, a freshness bound
 * moving one that has gone quiet, and a map that says where everything is, including
 * after the process is replaced.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ekman-service-health-"));

/** Long enough that a probe every `PROBE_EVERY_MS` keeps a service fresh on a busy machine. */
const QUIET_AFTER_MS = 400;
const PROBE_EVERY_MS = 50;

// Set before anything imports `lib/config`, which reads the environment once at load.
// That is why every import below is dynamic: a static import would be hoisted above this.
process.env.DATA_DIR = dir;
process.env.QUIET_AFTER_MS = String(QUIET_AFTER_MS);
process.env.SWEEP_MS = "40";
process.env.FAILURES_BEFORE_DEGRADED = "3";
// The prober is the application's loop. Here the test is the one sending probes.
process.env.PROBE_MS = "0";

let base = "";
let failures = 0;

const ok = { ok: true, latencyMs: 20 };
const bad = { ok: false, latencyMs: 1400, error: "upstream timed out" };

async function main(): Promise<void> {
  const { buildServer } = await import("./src/app");
  const { ekman } = await import("./src/lib/runtime");

  const server = buildServer();
  base = `http://127.0.0.1:${await listen(server)}`;
  console.log(`smoke: ${base}\n  state: ${dir}\n`);

  try {
    await recording();
    await theRule();
    await silence();
    await theBoundary();
  } finally {
    // In a `finally` so a failed check still tears the server down rather than leaving a
    // port bound and the script hanging.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await ekman.close();
  }

  await afterARestart();
  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0 ? "\nall checks passed\n" : `\n${failures} checks FAILED\n`
  );
  process.exitCode = failures === 0 ? 0 : 1;

  const bail = setTimeout(() => {
    console.error(
      "the event loop is still busy after shutdown; something was left open"
    );
    process.exit(failures === 0 ? 0 : 1);
  }, 2000);
  bail.unref();
}

/** A probe is merged into what is known, and the rest is kept. */
async function recording(): Promise<void> {
  section("recording what is observed");

  const first = await probe("auth-api", ok);
  check("a probe is recorded", first.status === 200, first.status);
  check(
    "a new service starts healthy",
    first.json.state === "healthy",
    first.json.state
  );

  await probe("auth-api", { ...bad, error: "connection reset" });
  const recovered = await probe("auth-api", { ok: true, latencyMs: 35 });
  const values = recovered.json.values as Record<string, unknown>;
  check(
    "a success resets the count and keeps the last error",
    values.failures === 0 &&
      values.lastError === "connection reset" &&
      values.latencyMs === 35 &&
      values.probes === 3,
    values
  );
}

/** Three failures in a row, and the service is moved without a handler counting. */
async function theRule(): Promise<void> {
  section("a rule proposes");

  await probe("payments-api", bad);
  await probe("payments-api", bad);
  const third = await probe("payments-api", bad);
  check(
    "the third failure is still recorded as healthy",
    third.json.state === "healthy",
    third.json.state
  );

  // The proposal is queued behind that commit. A fourth probe is queued behind the
  // proposal, so by the time it answers the move has happened.
  const fourth = await probe("payments-api", bad);
  check(
    "and the proposal that followed it moved the service",
    fourth.json.state === "degraded",
    fourth.json.state
  );

  const read = await call("GET", "/services/payments-api");
  const proposals = read.json.proposals as { by: string; reason: string }[];
  check(
    "the proposal is in the service's own history, once, with its reason",
    proposals.length === 1 &&
      proposals[0]?.by === "too-many-failures" &&
      proposals[0].reason === "3 failed probes in a row",
    proposals
  );

  const map = await call("GET", "/map");
  const byState = map.json.byState as Record<
    string,
    { count: number; keys: string[] } | undefined
  >;
  check(
    "the map shows it degraded",
    byState.degraded?.keys.join(",") === "services:payments-api",
    byState
  );
  check(
    "and is the whole answer over a durable store",
    map.json.complete === true && map.json.total === 2,
    map.json
  );
}

/** One service stops being probed. Nothing arrives to say so. */
async function silence(): Promise<void> {
  section("silence");

  await probe("search-api", ok);

  // The others go on being probed, well or badly. search-api is simply not mentioned.
  const gone = await until(async () => {
    await probe("auth-api", ok);
    await probe("payments-api", bad);
    const read = await call("GET", "/services/search-api");
    return read.json.state === "unreachable";
  }, QUIET_AFTER_MS * 10);
  check("a service that goes quiet becomes unreachable", gone, gone);

  const map = await call("GET", "/map");
  const byState = map.json.byState as Record<
    string,
    { count: number; keys: string[] } | undefined
  >;
  check(
    "one that is probed and failing is degraded, not unreachable",
    byState.degraded?.keys.join(",") === "services:payments-api",
    byState
  );
  check(
    "one that is probed and well is still healthy",
    byState.healthy?.keys.join(",") === "services:auth-api",
    byState
  );
  check(
    "and the quiet one is where the bound proposed",
    byState.unreachable?.keys.join(",") === "services:search-api",
    byState
  );

  const read = await call("GET", "/services/search-api");
  const proposals = read.json.proposals as { by: string; kind: string }[];
  check(
    "the bound is in its history, once",
    proposals.length === 1 &&
      proposals[0]?.by === "gone-quiet" &&
      proposals[0].kind === "stale",
    proposals
  );

  const back = await probe("search-api", ok);
  check(
    "one probe brings it back",
    back.json.state === "healthy",
    back.json.state
  );
}

/** What the HTTP boundary refuses before the runtime sees it. */
async function theBoundary(): Promise<void> {
  section("the boundary");

  const noLatency = await probe("auth-api", { ok: true });
  check(
    "a probe with no latency is a 400",
    noLatency.status === 400,
    noLatency.status
  );

  const forged = await probe("auth-api", {
    ...ok,
    type: "constraint.stale",
    propose: "unreachable",
  });
  check(
    "a body cannot pass itself off as a proposal: it is recorded as a probe",
    forged.status === 200 && forged.json.state === "healthy",
    forged.json
  );

  const unknown = await call("GET", "/services/never-probed");
  check("a service never heard of is a 404", unknown.status === 404, unknown);

  const quiet = await call("GET", "/quiet?for=0ms&state=healthy");
  const instances = quiet.json.instances as { key: string; values?: object }[];
  check(
    "the quiet query answers with what is known about each",
    quiet.status === 200 &&
      instances.length > 0 &&
      instances.every((match) => match.values !== undefined),
    quiet.json
  );

  const misspelt = await call("GET", "/quiet?state=helthy");
  check(
    "a state the entity does not have is a 400",
    misspelt.status === 400,
    misspelt.status
  );
}

/** A second runtime over the same directory, with nothing in memory. */
async function afterARestart(): Promise<void> {
  section("after a restart");

  const { Ekman } = await import("ekman");
  const { service } = await import("./src/entities/service");
  const second = new Ekman({
    entities: [service],
    store: { kind: "file", dir },
  });

  try {
    const map = await second.entities.services.map();
    check(
      "every service is where it was",
      map.total === 3 &&
        map.byState.degraded?.keys.join(",") === "services:payments-api",
      map.byState
    );
    check("and the map is complete", map.complete, map.reasons);

    const [match] = (
      await second.entities.services.query({
        state: "degraded",
        includeValues: true,
      })
    ).instances;
    check(
      "with what was known about it, and when it was last heard from",
      match?.values?.lastError === "upstream timed out" &&
        typeof match.lastCommittedAt === "number",
      match
    );
  } finally {
    await second.close();
  }
}

function probe(
  name: string,
  payload: Record<string, unknown>
): Promise<Response> {
  return call("POST", `/services/${name}/probes`, payload);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
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
    await new Promise((resolve) => {
      setTimeout(resolve, PROBE_EVERY_MS);
    });
  }
  return false;
}

function check(what: string, passed: boolean, detail?: unknown): void {
  if (passed) {
    console.log(`  ok    ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${what}  (got ${JSON.stringify(detail)})`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
