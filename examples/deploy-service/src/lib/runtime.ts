/**
 * The runtime, constructed once for the process.
 *
 * Both entrypoints, the HTTP API and the queue consumer, import this same object. There is
 * no second runtime and no per-request setup: a deployment is the same instance whichever
 * door its trigger came through, and the per-key inbox is what keeps those two doors from
 * racing each other.
 *
 * This whole file is the configuration surface. Everything in it is a decision somebody
 * would otherwise be making implicitly, over and over, in application code.
 */

import { Ekman } from "ekman";
import { deployment } from "../entities/deployment";
import { incident } from "../entities/incident";
import { auditLog } from "./audit-log";
import { config } from "./config";
import { telemetry } from "./metrics";
import { incidentOpener } from "./reactions";

export const ekman = new Ekman({
  entities: [deployment, incident],

  // Fastest first. The file store is the last durable layer, so it is the commit
  // authority and owns the truth; the memory layer in front of it is a cache. A commit
  // that resolves has already reached the file store, so a crash a microsecond later
  // loses nothing.
  store: [
    "memory",
    {
      kind: "file",
      dir: config.dataDir,
      // Enforced rather than merely measured, because a service that fills its disk takes
      // the host down with it. Refusing new deployments is recoverable; that is not.
      retention: { totalBytes: config.storageBytes, policy: "reject" },
    },
  ],

  // A budget, not a hope. Cold deployments are snapshotted out and reloaded transparently
  // when a trigger arrives for them; nothing below this line is aware that happens.
  memory: {
    maxBytes: config.memoryBytes,
    eviction: { policy: "lru", snapshotOnEvict: true },
  },

  // Bounded in triggers, not bytes. When it fills, the sender is told, which is how
  // overload becomes backpressure the caller can act on rather than latency it cannot see.
  inbox: { capacity: config.inboxCapacity, overflow: "reject" },

  // The default for every handler. `deployments.deploying` overrides attempts and timeout
  // because it is the one that talks to an external API; everything else inherits this.
  execution: {
    maxAttempts: 2,
    timeoutMs: 10_000,
    backoff: { kind: "exponential", baseMs: 50 },
  },

  // How often time-in-state bounds are evaluated. `deployments` declares one; without a
  // sweep interval it would only be checked when something called `ekman.sweep()`.
  temporal: { sweepMs: config.sweepMs },

  // Copies of committed events, out of band. Neither of these can veto or delay a commit.
  audit: [auditLog, incidentOpener((key, trigger) => ekman.post(key, trigger))],

  telemetry,

  // Nothing here should ever fire. It exists so that if something does, it is visible
  // rather than becoming an unhandled rejection with no context.
  onUnhandled: (error) => {
    console.error("[ekman] unhandled", error);
  },
});

/**
 * Typed handles, so callers address instances by id rather than building key strings.
 *
 * Each one carries its entity's own state, values and trigger types, so a typo'd state
 * name or a missing value field is a compile error at the call site rather than a
 * refusal at runtime.
 */
export const { deployments, incidents } = ekman.entities;
