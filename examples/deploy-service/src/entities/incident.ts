/**
 * An incident, opened when a deployment fails.
 *
 * Every handler here is idempotent, and that is deliberate rather than defensive. The
 * thing that opens incidents is an audit sink (see `lib/reactions.ts`), and audit delivery
 * is at-least-once. Being handed the same `open` twice is normal operation, not an error,
 * so `open` on an already-open incident is a no-op rather than a second incident or a
 * thrown exception.
 *
 * The transition graph is what makes that safe to write casually: `open -> open` is not in
 * it, so a handler returning `stay` is the only thing that can happen.
 */

import { defineEntity, stay, transitionTo } from "ekman";

export type IncidentState = "open" | "acknowledged" | "resolved";

export interface IncidentValues extends Record<string, unknown> {
  /** The deployment this was opened for. */
  about: string;
  reason: string;
  acknowledgedBy: string;
}

export const incident = defineEntity("incidents", {
  initial: "open",
  values: {
    about: "",
    reason: "",
    acknowledgedBy: "",
  } as IncidentValues,

  triggers: ["open", "acknowledge", "resolve"],

  states: {
    open: (current, trigger) => {
      if (trigger.type === "acknowledge") {
        return transitionTo("acknowledged", {
          ...current.values,
          acknowledgedBy: trigger.actor as string,
        });
      }
      if (trigger.type === "resolve") {
        return transitionTo("resolved", current.values);
      }

      // A redelivered `open`. Record the details the first time and ignore them after,
      // so the incident keeps the reason it was actually opened for.
      return current.values.reason === ""
        ? stay({
            ...current.values,
            about: trigger.about as string,
            reason: trigger.reason as string,
          })
        : stay(current.values);
    },

    acknowledged: (current, trigger) =>
      trigger.type === "resolve"
        ? transitionTo("resolved", current.values)
        : stay(current.values),

    resolved: (current) => stay(current.values),
  },

  constraints: {
    transitions: {
      policy: "reject",
      allow: {
        open: ["acknowledged", "resolved"],
        acknowledged: ["resolved"],
        resolved: [],
      },
    },
  },
});
