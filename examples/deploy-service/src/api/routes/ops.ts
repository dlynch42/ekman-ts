/**
 * Operational routes: the questions you have at 3am.
 *
 * These are the endpoints that are usually missing, or that exist as a hand-written SQL
 * query pasted into a runbook. "What is stuck in `deploying`, and for how long" is a
 * first-class question here rather than something to reconstruct under pressure.
 *
 * The query endpoints and the map pass `complete` and `reasons` straight through to the
 * caller. That is deliberate: an operator acting on "nothing is stuck" needs to know
 * whether that was the whole answer or only the part this process could see.
 *
 * A state arrives here as text in a URL, and the entity's handle only accepts states the
 * entity has. So it is checked against the list first, and a misspelt one is a 400 that
 * names the choices instead of a query that quietly matches nothing.
 */

import { isEkmanError } from "ekman";
import { DEPLOYMENT_STATES } from "../../entities/deployment";
import { INCIDENT_STATES } from "../../entities/incident";
import { config } from "../../lib/config";
import { metricsSnapshot } from "../../lib/metrics";
import { deployments, ekman, incidents } from "../../lib/runtime";
import {
  BadRequest,
  json,
  type Reply,
  type Route,
  requireOperator,
} from "../server";

function stateFrom<S extends string>(given: string, states: readonly S[]): S {
  const state = states.find((known) => known === given);
  if (state === undefined) {
    throw new BadRequest(`state must be one of: ${states.join(", ")}`);
  }
  return state;
}

export const opsRoutes: readonly Route[] = [
  {
    method: "GET",
    path: "/ops/stuck",
    handle: async (ctx): Promise<Reply> => {
      const state = stateFrom(
        ctx.query.get("state") ?? "deploying",
        DEPLOYMENT_STATES
      );
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
      const result = await incidents.query(
        state === null ? {} : { state: stateFrom(state, INCIDENT_STATES) }
      );
      return json(200, {
        count: result.instances.length,
        complete: result.complete,
        reasons: result.reasons,
        instances: result.instances,
      });
    },
  },

  {
    method: "GET",
    path: "/ops/map",
    handle: async (ctx): Promise<Reply> => {
      // The whole fleet in one call: how many deployments are in each state, and which.
      const map = await deployments.map();
      if (ctx.query.get("values") !== "true") {
        return json(200, map);
      }

      // What each one knows, on request. Reading every deployment's values is the
      // expensive form of the question, so it is not the default.
      const { instances } = await deployments.query({ includeValues: true });
      return json(200, {
        ...map,
        values: Object.fromEntries(
          instances.map((match) => [match.key, match.values])
        ),
      });
    },
  },

  {
    method: "POST",
    path: "/ops/sweep",
    handle: async (ctx): Promise<Reply> => {
      // It delivers triggers, so it changes things, so it asks who is calling.
      const denied = requireOperator(ctx);
      if (denied !== undefined) {
        return denied;
      }

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
      // The one route that deletes committed state. Checked before anything is read, a
      // dry run included, because the list of what would be deleted is not public either.
      const denied = requireOperator(ctx);
      if (denied !== undefined) {
        return denied;
      }

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
