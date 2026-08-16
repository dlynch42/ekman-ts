/**
 * Deployment routes.
 *
 * Every handler here does the same three things: read the request, send a trigger, shape
 * the answer. There is no transaction, no lock, no read-modify-write, no "check the state
 * first and then act", and no retry loop. Those all exist, but they are the runtime's, and
 * `lib/runtime.ts` is where they were configured.
 *
 * The thing to notice is what is missing. Two requests for the same deployment arriving at
 * the same instant do not need anything here to make them safe.
 */

import { deployments } from "../../lib/runtime";
import { BadRequest, json, type Reply, type Route } from "../server";

/** Required string field, or a 400 that never reaches the runtime. */
function required(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${field} is required`);
  }
  return value;
}

export const deploymentRoutes: readonly Route[] = [
  {
    method: "POST",
    path: "/deployments/:id",
    handle: async (ctx): Promise<Reply> => {
      const body = await ctx.body();

      // Request shape is validated here. Domain rules (a deploy needs a region, a
      // rolled-back deployment cannot go live) are the entity's, enforced by its
      // constraints no matter which producer sent the trigger.
      const result = await deployments.send(ctx.params.id ?? "", {
        type: "deploy",
        service: required(body, "service"),
        region: required(body, "region"),
        version: required(body, "version"),
      });

      return json(201, {
        key: result.key,
        state: result.state,
        seq: result.seq,
        values: result.values,
      });
    },
  },

  {
    method: "POST",
    path: "/deployments/:id/events",
    handle: async (ctx): Promise<Reply> => {
      const body = await ctx.body();
      const type = required(body, "type");

      // Anything not on the entity's declared trigger list is refused with
      // UNKNOWN_TRIGGER, which the server maps to 422. A typo in a producer does not
      // silently do nothing.
      const result = await deployments.send(ctx.params.id ?? "", {
        ...body,
        type,
      });

      return json(200, {
        key: result.key,
        state: result.state,
        seq: result.seq,
        values: result.values,
      });
    },
  },

  {
    method: "GET",
    path: "/deployments/:id",
    handle: (ctx): Reply => {
      // Resident-only and synchronous: this is a debug read, not the source of truth.
      // A deployment that has been evicted reads as absent here and is still perfectly
      // alive; `/deployments/:id/history` goes through the store.
      const snapshot = deployments.inspect(ctx.params.id ?? "");
      return snapshot === undefined
        ? json(404, { error: "not_resident", key: ctx.params.id })
        : json(200, snapshot);
    },
  },

  {
    method: "GET",
    path: "/deployments/:id/history",
    handle: async (ctx): Promise<Reply> => {
      // Transitions, refused triggers, constraint violations and reloads, in order.
      // "What happened to this deployment" is one call.
      const history = await deployments.history(ctx.params.id ?? "");
      return json(200, history);
    },
  },
];
