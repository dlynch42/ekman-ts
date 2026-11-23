/**
 * A service this process depends on, as what is remembered about it.
 *
 * The handlers here do two things: record what a probe said, and decide what to do with
 * a proposal. They never compare a counter with a threshold and never read a clock.
 * Those are the two constraints at the bottom of the file, and each one reaches a
 * handler as a trigger carrying the state it is asking for.
 *
 *   healthy  --rule: too many failures in a row-->  degraded
 *   healthy, degraded  --nothing heard for too long-->  unreachable
 *   degraded, unreachable  --a probe that succeeds-->  healthy
 */

import type { RuleTrigger, StaleTrigger } from "ekman";
import {
  DEFAULT_RULE_TRIGGER,
  DEFAULT_STALE_TRIGGER,
  defineEntity,
  patch,
  stay,
  transitionTo,
} from "ekman";
import { config } from "../lib/config";

/** Every state a service can be in. A list, so a state named in a URL can be checked. */
export const SERVICE_STATES = ["healthy", "degraded", "unreachable"] as const;

export type ServiceState = (typeof SERVICE_STATES)[number];

export interface ServiceValues extends Record<string, unknown> {
  /** Failed probes in a row. A probe that succeeds sets it back to zero. */
  failures: number;
  /** How long the last probe took. */
  latencyMs: number;
  /** What the last failed probe said. Kept after a recovery, as the last thing that went wrong. */
  lastError: string;
  /** How many probes have been recorded in all. */
  probes: number;
}

export interface Probe {
  type: "probe";
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * What a service can be sent. The two proposals are in the union because the entity
 * declares a rule and a freshness bound. Only the runtime raises them: the API builds
 * probes and nothing else.
 */
export type ServiceTrigger =
  | Probe
  | RuleTrigger<ServiceState>
  | StaleTrigger<ServiceState>;

const nothingKnown: ServiceValues = {
  failures: 0,
  latencyMs: 0,
  lastError: "",
  probes: 0,
};

/** What one probe teaches. It names only what changed, and `patch` keeps the rest. */
function learned(known: ServiceValues, probe: Probe): Partial<ServiceValues> {
  return probe.ok
    ? { failures: 0, latencyMs: probe.latencyMs, probes: known.probes + 1 }
    : {
        failures: known.failures + 1,
        latencyMs: probe.latencyMs,
        lastError: probe.error ?? "probe failed",
        probes: known.probes + 1,
      };
}

export const service = defineEntity.withTriggers<ServiceTrigger>()("services", {
  initial: "healthy",
  values: nothingKnown,
  triggers: ["probe", DEFAULT_RULE_TRIGGER, DEFAULT_STALE_TRIGGER],

  states: {
    healthy: (current, trigger) =>
      trigger.type === "probe"
        ? patch(learned(current.values, trigger))
        : // A proposal. It says where it wants the service to go, and this agrees.
          transitionTo(trigger.propose ?? "degraded", current.values),

    degraded: (current, trigger) => {
      if (trigger.type !== "probe") {
        return transitionTo(trigger.propose ?? "unreachable", current.values);
      }
      // A move replaces values, so what the probe taught is laid over what was known.
      return trigger.ok
        ? transitionTo("healthy", {
            ...current.values,
            ...learned(current.values, trigger),
          })
        : patch(learned(current.values, trigger));
    },

    unreachable: (current, trigger) =>
      // Anything heard at all means it is reachable again. Whether it is well is for the
      // next probes, and the rule, to say.
      trigger.type === "probe"
        ? transitionTo("healthy", {
            ...current.values,
            ...learned(current.values, trigger),
          })
        : stay(),
  },

  constraints: {
    transitions: {
      allow: {
        healthy: ["degraded", "unreachable"],
        degraded: ["healthy", "unreachable"],
        unreachable: ["healthy"],
      },
    },

    // Checked after every commit while a service is healthy. It fires once, when the
    // count reaches the threshold, and not again while the count keeps climbing.
    rules: [
      {
        name: "too-many-failures",
        in: "healthy",
        when: (current) =>
          current.values.failures >= config.failuresBeforeDegraded &&
          `${current.values.failures} failed probes in a row`,
        propose: "degraded",
      },
    ],

    // Checked by the sweep. A probe is a commit, so a service that is being probed is
    // never quiet, whatever the probes say. One that is not being probed has no handler
    // running to notice, which is why this cannot live in a handler.
    stale: [
      {
        name: "gone-quiet",
        after: config.quietAfterMs,
        propose: "unreachable",
      },
    ],
  },
});
