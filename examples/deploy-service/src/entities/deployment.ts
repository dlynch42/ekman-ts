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

import type { TemporalTrigger } from "ekman";
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

/**
 * Everything a deployment can be sent. Giving the entity this union is what types
 * `trigger` in each handler below and what `deployments.send` checks a caller against.
 *
 * The time bound's escalation is in it because this entity declares one: it arrives as a
 * trigger like any other, and a handler narrows to it by `type`.
 */
export type DeploymentTrigger =
  | { type: "deploy"; service: string; region: string; version: string }
  | { type: "succeeded" }
  | { type: "failed"; reason?: string }
  | { type: "rollback"; reason?: string }
  | TemporalTrigger<DeploymentState>;

/**
 * An optional reason, with a fallback for one that was left out, left empty, or is not
 * text at all.
 *
 * Takes `unknown` although the union says `string`. The union is a claim about triggers a
 * caller built; one sent by key, from a request body or a queue message, has been checked
 * by nobody, and a number written into `note` would be committed as one.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * Annotated rather than asserted. An annotation is checked for missing fields; `as` would
 * let one through.
 */
const initialValues: DeploymentValues = {
  service: "",
  region: "",
  version: "",
  attempts: 0,
  note: "",
};

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

export const deployment = defineEntity.withTriggers<DeploymentTrigger>()(
  "deployments",
  {
    initial: "queued",
    values: initialValues,

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
      // Only a `deploy` starts a deployment. Anything else that is on the list above, such
      // as a `succeeded` for an id nobody deployed, changes nothing.
      queued: (current, trigger) =>
        trigger.type === "deploy"
          ? transitionTo("deploying", {
              ...current.values,
              service: trigger.service,
              region: trigger.region,
              version: trigger.version,
              attempts: current.values.attempts + 1,
              note: "deploy requested",
            })
          : stay(current.values),

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
            // A `failed` and a `rollback` both carry a reason. A `deploy` arriving here does
            // not, and has none to give.
            note:
              trigger.type === "deploy"
                ? "reported failed"
                : text(trigger.reason, "reported failed"),
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
  }
);
