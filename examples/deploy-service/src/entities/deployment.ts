/**
 * The deployment lifecycle.
 *
 * An entity is a file. States, handlers, the transition graph, the guards, the time
 * bound, and the execution policy for the one state that talks to something flaky all
 * live here, next to the domain they describe, rather than being spread across a service
 * class, a migration, a cron job and a dashboard.
 *
 * Nothing in this file knows about HTTP, about the queue consumer, or about the runtime
 * it will be registered into. It is a description of how a deployment behaves.
 */

import {
  DEFAULT_TEMPORAL_TRIGGER,
  defineEntity,
  stay,
  transitionTo,
} from "ekman";
import { config } from "../lib/config";

export type DeploymentState =
  | "queued"
  | "deploying"
  | "live"
  | "failed"
  | "rolled-back";

export interface DeploymentValues extends Record<string, unknown> {
  service: string;
  region: string;
  version: string;
  /** How many times the deploy has been attempted, as a domain fact. */
  attempts: number;
  note: string;
}

/** A trigger field as a string, with a fallback. A trigger is an open map, so its fields are `unknown`. */
function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * Stand-in for whatever actually performs a deploy.
 *
 * It fails sometimes, which is the point: the handler below does not retry it, time it,
 * or back off. Those are configured on the state, not written into it.
 */
async function callDeployApi(values: DeploymentValues): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (values.region === "unreachable") {
    throw new Error("deploy api unreachable");
  }
}

export const deployment = defineEntity("deployments", {
  initial: "queued",
  values: {
    service: "",
    region: "",
    version: "",
    attempts: 0,
    note: "",
  } as DeploymentValues,

  // The contract with every producer. Anything else is refused and recorded rather than
  // ignored, including a typo in a message a queue is redelivering.
  triggers: [
    "deploy",
    "succeeded",
    "failed",
    "rollback",
    DEFAULT_TEMPORAL_TRIGGER,
  ],

  states: {
    queued: (current, trigger) =>
      transitionTo("deploying", {
        ...current.values,
        service: trigger.service as string,
        region: trigger.region as string,
        version: trigger.version as string,
        attempts: current.values.attempts + 1,
        note: "deploy requested",
      }),

    // The only state that talks to anything external, and the only one that needs its own
    // execution policy. It overrides attempts and timeout, and inherits the runtime's
    // backoff without restating it.
    deploying: {
      handler: async (current, trigger) => {
        // The time bound fired. The runtime did not move anything: it asked, here, and
        // this is where the decision gets made.
        if (trigger.type === DEFAULT_TEMPORAL_TRIGGER) {
          return transitionTo("failed", {
            ...current.values,
            note: `no result after ${config.stuckAfterMs}ms, gave up`,
          });
        }

        if (trigger.type === "succeeded") {
          await callDeployApi(current.values);
          return transitionTo("live", {
            ...current.values,
            note: "deployed",
          });
        }

        return transitionTo("failed", {
          ...current.values,
          note: text(trigger.reason, "reported failed"),
        });
      },
      maxAttempts: config.deployMaxAttempts,
      timeoutMs: config.deployTimeoutMs,
    },

    live: (current, trigger) => {
      if (trigger.type === "rollback") {
        return transitionTo("rolled-back", {
          ...current.values,
          note: text(trigger.reason, "rolled back"),
        });
      }

      // A redelivered `deploy`. This handler is naive on purpose: it does not check what
      // state it is in or whether it has seen this message before, because that is the
      // handler every codebase actually contains. The transition graph is what stops a
      // live deployment being restarted by a message from an hour ago.
      if (trigger.type === "deploy") {
        return transitionTo("deploying", {
          ...current.values,
          attempts: current.values.attempts + 1,
          note: "redeploy requested",
        });
      }

      return stay(current.values);
    },

    failed: (current, trigger) =>
      trigger.type === "rollback"
        ? transitionTo("rolled-back", {
            ...current.values,
            note: text(trigger.reason, "rolled back"),
          })
        : stay(current.values),

    // A rolled-back deployment is finished. Somebody will try to redeploy it anyway, so
    // this handler cheerfully tries, and the transition graph is what refuses: the caller
    // gets CONSTRAINT_VIOLATED and has to create a new deployment instead. The rule lives
    // in one place rather than in every handler that might be tempted.
    "rolled-back": (current, trigger) =>
      trigger.type === "deploy"
        ? transitionTo("deploying", {
            ...current.values,
            attempts: current.values.attempts + 1,
            note: "redeploy attempted",
          })
        : stay(current.values),
  },

  constraints: {
    // The real lifecycle, written down where the runtime can enforce it. A redelivered
    // `succeeded` for something already rolled back is refused rather than applied.
    transitions: {
      policy: "reject",
      allow: {
        queued: ["deploying"],
        deploying: ["live", "failed"],
        live: ["rolled-back"],
        failed: ["rolled-back"],
        "rolled-back": [],
      },
    },

    // A deploy with no region is not a deploy. The API layer validates request shape;
    // this is the backstop that holds no matter which producer sent it.
    guards: [
      {
        name: "region-required",
        on: "deploying",
        check: (next) => next.values.region !== "",
      },
    ],

    invariants: [
      {
        name: "attempts-sane",
        check: (next) => next.values.attempts >= 0,
      },
    ],

    // Fires as a trigger, handled in `deploying` above.
    temporal: [
      {
        name: "deploy-takes-too-long",
        in: "deploying",
        within: config.stuckAfterMs,
        escalateTo: "failed",
      },
    ],
  },
});
