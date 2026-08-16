/**
 * Everything environment-dependent, in one place.
 *
 * Read once at startup rather than per use, so a running process cannot half-change its
 * mind about where its state lives.
 */

import { join } from "node:path";

const KB = 1024;
const MINUTE_MS = 60_000;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
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
  port: num("PORT", 3000),

  /** Where the transition log lives. Gitignored; delete it to start clean. */
  dataDir:
    process.env.DATA_DIR ?? join(process.cwd(), "examples/deploy-service/data"),

  /** Resident memory allowance. Small here so eviction is observable in a demo. */
  memoryBytes: num("MEMORY_BYTES", 256 * KB),

  /** Triggers that may wait behind the one being handled, per deployment. */
  inboxCapacity: num("INBOX_CAPACITY", 32),

  /** How long a deployment may sit in `deploying` before it is escalated. */
  stuckAfterMs: num("STUCK_AFTER_MS", 5 * MINUTE_MS),

  /** How often time-in-state bounds are checked. */
  sweepMs: num("SWEEP_MS", 1000),

  /** Attempts and per-attempt timeout for the state that talks to the deploy API. */
  deployMaxAttempts: num("DEPLOY_MAX_ATTEMPTS", 4),
  deployTimeoutMs: num("DEPLOY_TIMEOUT_MS", 5000),
});
