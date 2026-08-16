/**
 * Operational routes: the questions you have at 3am.
 *
 * These are the endpoints that are usually missing, or that exist as a hand-written SQL
 * query pasted into a runbook. "What is stuck in `deploying`, and for how long" is a
 * first-class question here rather than something to reconstruct under pressure.
 *
 * Both query endpoints pass `complete` and `reasons` straight through to the caller. That
 * is deliberate: an operator acting on "nothing is stuck" needs to know whether that was
 * the whole answer or only the part this process could see.
 */

import { metricsSnapshot } from "../../lib/metrics";
import { deployments, ekman, incidents } from "../../lib/runtime";
import { json, type Reply, type Route } from "../server";

export const opsRoutes: readonly Route[] = [
  {
    method: "GET",
    path: "/ops/stuck",
    handle: async (ctx): Promise<Reply> => {
      const state = ctx.query.get("state") ?? "deploying";
      const olderThan = ctx.query.get("olderThan") ?? "5m";

      // Oldest first, which is the order the question is asked in. Time in state is
      // measured from the last move, so a deployment writing progress updates does not
      // keep resetting its own clock.
      const result = await deployments.query({ state, olderThan });

      return json(200, {
        query: { state, olderThan },
        count: result.instances.length,
        complete: result.complete,
        reasons: result.reasons,
        sources: result.sources,
        instances: result.instances,
      });
    },
  },

  {
    method: "GET",
    path: "/ops/incidents",
    handle: async (ctx): Promise<Reply> => {
      const state = ctx.query.get("state");
      const result = await incidents.query(state === null ? {} : { state });
      return json(200, {
        count: result.instances.length,
        complete: result.complete,
        reasons: result.reasons,
        instances: result.instances,
      });
    },
  },

  {
    method: "POST",
    path: "/ops/sweep",
    handle: async (): Promise<Reply> => {
      // The runtime sweeps on its own interval; this is the manual version, for when you
      // do not want to wait for the next one.
      const escalated = await ekman.sweep();
      return json(200, { escalated });
    },
  },

  {
    method: "GET",
    path: "/ops/metrics",
    handle: (): Reply =>
      json(200, {
        ...metricsSnapshot(),
        // Resident bytes and instance count on the documented accounting basis. This is
        // the number to watch before deciding what the budget should be.
        memory: ekman.memoryUsage,
      }),
  },

  {
    method: "GET",
    path: "/health",
    handle: (): Reply => json(200, { ok: true }),
  },
];
