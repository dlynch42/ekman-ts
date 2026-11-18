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

/** Every state an incident can be in. A list, so a state named in a URL can be checked. */
export const INCIDENT_STATES = ["open", "acknowledged", "resolved"] as const;

export type IncidentState = (typeof INCIDENT_STATES)[number];

export interface IncidentValues extends Record<string, unknown> {
  /** The deployment this was opened for. */
  about: string;
  reason: string;
  acknowledgedBy: string;
}

export type IncidentTrigger =
  | { type: "open"; about: string; reason: string }
  | { type: "acknowledge"; actor: string }
  | { type: "resolve" };

const initialValues: IncidentValues = {
  about: "",
  reason: "",
  acknowledgedBy: "",
};

export const incident = defineEntity.withTriggers<IncidentTrigger>()(
  "incidents",
  {
    initial: "open",
    values: initialValues,

    triggers: ["open", "acknowledge", "resolve"],

    states: {
      open: (current, trigger) => {
        if (trigger.type === "acknowledge") {
          return transitionTo("acknowledged", {
            ...current.values,
            acknowledgedBy: trigger.actor,
          });
        }
        if (trigger.type === "resolve") {
          return transitionTo("resolved", current.values);
        }

        // A redelivered `open`. Record the details the first time and ignore them after,
        // so the incident keeps the reason it was actually opened for. "Not recorded yet"
        // includes a reason that is not text: an incident stored before the checks below
        // existed can hold one, and a later `open` is what repairs it.
        return typeof current.values.reason !== "string" ||
          current.values.reason === ""
          ? stay({
              ...current.values,
              about: trigger.about,
              reason: trigger.reason,
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
      // The thing that opens incidents posts by key, so nothing has checked its fields by
      // the time they arrive. A field that was left out would be stored as `undefined` and
      // read back as "already recorded", so the incident could never be given its reason.
      // These refuse the trigger instead, and the refusal is on the incident's record.
      guards: [
        {
          name: "acknowledger-required",
          on: "acknowledged",
          check: (next) =>
            typeof next.values.acknowledgedBy === "string" &&
            next.values.acknowledgedBy !== "",
        },
      ],
      invariants: [
        {
          name: "details-are-text",
          check: (next) =>
            typeof next.values.about === "string" &&
            typeof next.values.reason === "string",
        },
      ],

      transitions: {
        policy: "reject",
        allow: {
          open: ["acknowledged", "resolved"],
          acknowledged: ["resolved"],
          resolved: [],
        },
      },
    },
  }
);
