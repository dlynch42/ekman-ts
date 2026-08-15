import { EkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import type { ResolvedMemoryConfig } from "./memory";
import type { ResolvedStack } from "./stack";
import type { TelemetrySink } from "./telemetry";
import type { InboxConfig, OverflowPolicy } from "./types";

/**
 * Runtime configuration, resolved once at construction.
 *
 * User config is optional and partial; everything downstream wants it whole. Resolving
 * in one place means defaults are stated once and an unsatisfiable configuration is
 * refused at startup rather than discovered under load.
 */

/** Default to 128 waiting triggers per key. */
export const DEFAULT_CAPACITY = 128;

export const OVERFLOW_POLICIES: readonly OverflowPolicy[] = [
  "reject",
  "drop-newest",
  "drop-oldest",
];

export interface ResolvedInboxConfig {
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  readonly recordOverflow: boolean;
}

/** Everything the instances and their inboxes need from the runtime that owns them. */
export interface RuntimeDeps {
  readonly now: () => number;
  readonly telemetry: TelemetrySink | undefined;
  readonly onUnhandled: (error: unknown) => void;
  readonly inbox: ResolvedInboxConfig;
  /** Which layer owns the truth, and which are caches. */
  readonly stack: ResolvedStack;
  readonly memory: ResolvedMemoryConfig;
  /**
   * Hand a committed event to the audit sinks. Never awaited, never able to fail a commit.
   */
  readonly audit: (event: EkmanEvent) => void;
}

export function resolveInboxConfig(
  config: InboxConfig | undefined
): ResolvedInboxConfig {
  const capacity = config?.capacity ?? DEFAULT_CAPACITY;
  const overflow = config?.overflow ?? "reject";

  // An unbounded inbox converts overload into silent latency and unbounded memory, which
  // is the failure this runtime exists to prevent. There is deliberately no way to ask
  // for one, so a nonsensical value is refused rather than reinterpreted.
  if (!(Number.isInteger(capacity) && capacity >= 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `inbox capacity must be a non-negative integer number of triggers, received ${JSON.stringify(capacity)}. ` +
        "It is a queue length, not a size in bytes. Use 0 to allow no queuing at all; " +
        "there is no unbounded setting."
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
    capacity,
    overflow,
    recordOverflow: config?.recordOverflow ?? false,
  });
}
