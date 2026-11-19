/**
 * Everything environment-dependent, in one place.
 *
 * Read once at startup rather than per use, so a running process cannot half-change its
 * mind about where its state lives or how long a silence has to be.
 */

import { join } from "node:path";
import { defaultLogDir } from "ekman";

const KB = 1024;

/** An environment variable, or the fallback when it is unset or empty. */
function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function num(name: string, fallback: number): number {
  const raw = str(name, "");
  if (raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `${name} must be a number, received ${JSON.stringify(raw)}`
    );
  }
  return value;
}

export const config = Object.freeze({
  port: num("PORT", 3001),

  /** The interface to listen on. Loopback unless told otherwise. */
  host: str("HOST", "127.0.0.1"),

  /** The largest request body that is read. Anything bigger is a 413 and is not buffered. */
  maxBodyBytes: num("MAX_BODY_BYTES", 16 * KB),

  dataDir: str("DATA_DIR", join(defaultLogDir(), "service-health")),

  /** Resident memory for everything this process remembers about every service. */
  memoryBytes: num("MEMORY_BYTES", 256 * KB),

  /** Failed probes in a row before a service is proposed as degraded. */
  failuresBeforeDegraded: num("FAILURES_BEFORE_DEGRADED", 3),

  /** How long a service may go unheard from before it is proposed as unreachable. */
  quietAfterMs: num("QUIET_AFTER_MS", 60_000),

  /** How often the freshness bound is evaluated. */
  sweepMs: num("SWEEP_MS", 5000),

  /** How often the built-in prober posts a synthetic probe. Zero turns it off. */
  probeMs: num("PROBE_MS", 2000),
});
