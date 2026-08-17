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

import { isEkmanError } from "ekman";
import { config } from "../../lib/config";
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
        // And the other axis. Nothing about the memory budget bounds this one: evicted
        // instances free RAM and leave their logs exactly where they were.
        storage: ekman.storageUsage,
      }),
  },

  {
    method: "POST",
    path: "/ops/prune",
    handle: async (ctx): Promise<Reply> => {
      // Retention is this: a query you already have, and the one verb that deletes. There
      // is no policy inside the runtime deciding when a deployment stops mattering,
      // because that is a product question and it belongs here.
      const olderThan = ctx.query.get("olderThan") ?? config.retainFor;
      const dryRun = ctx.query.get("dryRun") === "true";

      const { instances, complete } = await deployments.query({
        state: "rolled-back",
        olderThan,
      });

      const forgotten: string[] = [];
      const busy: string[] = [];

      if (!dryRun) {
        for (const match of instances) {
          try {
            // biome-ignore lint/performance/noAwaitInLoops: a sweep is not a race worth winning
            await ekman.forget(match.key);
            forgotten.push(match.key);
          } catch (error) {
            // A deployment being worked on right now is not a failure of the sweep. It is
            // reported and left alone, and the next run will find it idle.
            if (isEkmanError(error) && error.code === "KEY_BUSY") {
              busy.push(match.key);
            } else {
              throw error;
            }
          }
        }
      }

      return json(200, {
        query: { state: "rolled-back", olderThan },
        dryRun,
        // Passed through, because an operator deleting things needs to know whether the
        // list they acted on was the whole list.
        complete,
        candidates: instances.map((match) => match.key),
        forgotten,
        busy,
        storage: ekman.storageUsage,
      });
    },
  },

  {
    method: "GET",
    path: "/health",
    handle: (): Reply => json(200, { ok: true }),
  },
];
