/**
 * Cross-entity reaction: a failed deployment opens an incident.
 *
 * This is an audit sink rather than something inside the deployment handler, and the
 * distinction is worth being explicit about.
 *
 * A handler returns one result for one instance. It cannot also write to a second
 * instance, because that would be a second commit riding on the first one's atomicity
 * without any of its guarantees. So a reaction to a commit belongs after the commit, which
 * is exactly what an audit sink is.
 *
 * What that buys, and what it costs:
 *
 * - The deployment commits whether or not the incident is ever opened. A reaction cannot
 *   veto the thing it is reacting to.
 * - Delivery is at-least-once, so this sink may be handed the same transition twice. The
 *   incident handler is idempotent for that reason, not by accident.
 * - This is a reaction, not a transaction. If opening the incident is genuinely required
 *   for correctness, it belongs in the caller that owns both, not here.
 */

import type { AuditSink, Trigger } from "ekman";
import { isTransitionEvent } from "ekman";

/**
 * @param post Fire-and-forget send. Injected rather than imported so this file does not
 *   have to import the runtime that is going to import it.
 */
export function incidentOpener(
  post: (key: string, trigger: Trigger) => void
): AuditSink {
  return {
    name: "incident-opener",
    deliver: (event) => {
      if (!isTransitionEvent(event)) {
        return;
      }
      if (event.to !== "failed") {
        return;
      }

      // One incident per deployment, by key. A redelivery of this same event lands on the
      // same instance and the handler treats it as the no-op it is.
      const id = event.key.split(":").slice(1).join("-");
      post(`incidents:${id}`, {
        type: "open",
        about: event.key,
        reason: String(event.values.note ?? "deployment failed"),
      });
    },
  };
}
