/**
 * A stand-in for whatever really probes your dependencies.
 *
 * It posts a synthetic probe for a few services on an interval, so the example has
 * something to show without anything to connect to. One of them fails every time, one
 * stops being probed after a while, and the rest are fine.
 *
 * This is the application's loop and not a feature of the runtime. Ekman does not probe
 * anything: it remembers what it is told, and notices when it stops being told.
 */

import { services } from "../lib/runtime";

const STEADY = ["auth-api", "catalog-api", "billing-api"];
const FAILING = "payments-api";
const GOES_QUIET = "search-api";
const ROUNDS_BEFORE_QUIET = 5;

/** Start probing. Returns the function that stops it. */
export function startProbing(everyMs: number): () => void {
  let round = 0;

  const timer = setInterval(() => {
    round += 1;
    for (const name of STEADY) {
      services.post(name, {
        type: "probe",
        ok: true,
        latencyMs: 10 + Math.round(Math.random() * 30),
      });
    }
    services.post(FAILING, {
      type: "probe",
      ok: false,
      latencyMs: 1500,
      error: "upstream timed out",
    });
    if (round <= ROUNDS_BEFORE_QUIET) {
      services.post(GOES_QUIET, { type: "probe", ok: true, latencyMs: 25 });
    }
  }, everyMs);

  return () => clearInterval(timer);
}
