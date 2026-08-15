import { EkmanError } from "./errors";
import type { TelemetrySink } from "./telemetry";
import type { InboxConfig, OverflowPolicy } from "./types";

/**
 * Runtime configuration, resolved once at construction.
 *
 * User config is optional and partial; everything downstream wants it whole. Resolving
 * in one place means defaults are stated once and an unsatisfiable configuration is
 * refused at startup rather than discovered under load.
 */

/** Triggers, not bytes. Matches the runtime config example in the README. */
export const DEFAULT_MAX_QUEUED = 128;

export const OVERFLOW_POLICIES: readonly OverflowPolicy[] = [
  "reject",
  "drop-newest",
  "drop-oldest",
];

export interface ResolvedInboxConfig {
  readonly maxQueued: number;
  readonly overflow: OverflowPolicy;
  readonly recordOverflow: boolean;
}

/** Everything the instances and their inboxes need from the runtime that owns them. */
export interface RuntimeDeps {
  readonly now: () => number;
  readonly telemetry: TelemetrySink | undefined;
  readonly onUnhandled: (error: unknown) => void;
  readonly inbox: ResolvedInboxConfig;
}

export function resolveInboxConfig(
  config: InboxConfig | undefined
): ResolvedInboxConfig {
  const maxQueued = config?.maxQueued ?? DEFAULT_MAX_QUEUED;
  const overflow = config?.overflow ?? "reject";

  // An unbounded inbox converts overload into silent latency and unbounded memory, which
  // is the failure this runtime exists to prevent. There is deliberately no way to ask
  // for one, so a nonsensical value is refused rather than reinterpreted.
  if (!(Number.isInteger(maxQueued) && maxQueued >= 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `inbox maxQueued must be a non-negative integer, received ${JSON.stringify(maxQueued)}. ` +
        "Use 0 to allow no queuing at all; there is no unbounded setting."
    );
  }

  if (!OVERFLOW_POLICIES.includes(overflow)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `inbox overflow policy ${JSON.stringify(overflow)} is not recognized. ` +
        `Expected one of: ${OVERFLOW_POLICIES.join(", ")}`
    );
  }

  return Object.freeze({
    maxQueued,
    overflow,
    recordOverflow: config?.recordOverflow ?? false,
  });
}
