/**
 * The routes: record a probe, read one service, and ask where everything is.
 *
 * A probe arrives as an untrusted request body, so it is checked here and built into a
 * typed trigger before the runtime sees it. This is the only place a trigger for a service
 * is built from outside input, and it only ever builds a probe: nothing a caller sends can
 * arrive as a rule's proposal or a freshness bound's.
 */

import { parseDuration } from "ekman";
import type { Probe } from "../entities/service";
import { SERVICE_STATES } from "../entities/service";
import { ekman, services } from "../lib/runtime";
import { BadRequest, json, type Reply, type Route } from "./server";

const MAX_ERROR_LENGTH = 200;

function probeFrom(body: Record<string, unknown>): Probe {
  const { ok, latencyMs, error } = body;
  if (typeof ok !== "boolean") {
    throw new BadRequest("ok is required and must be true or false");
  }
  if (
    typeof latencyMs !== "number" ||
    !Number.isFinite(latencyMs) ||
    latencyMs < 0
  ) {
    throw new BadRequest(
      "latencyMs is required and must be a number, 0 or more"
    );
  }
  if (error !== undefined && typeof error !== "string") {
    throw new BadRequest("error must be text when given");
  }
  return {
    type: "probe",
    ok,
    latencyMs,
    // Kept short. It is stored with every commit that follows it.
    ...(error === undefined ? {} : { error: error.slice(0, MAX_ERROR_LENGTH) }),
  };
}

const WHOLE_NUMBER = /^\d+$/;

/**
 * A count named in a URL. Checked here because it is text from outside: handed on as it
 * came, anything that is not a count would be refused by the runtime as a mistake in this
 * service's own configuration, and the caller would be told the server had failed.
 */
function countFrom(given: string, name: string): number {
  const count = Number(given);
  // Digits alone are not enough: enough of them is a number too large to be a count.
  if (!(WHOLE_NUMBER.test(given) && Number.isSafeInteger(count))) {
    throw new BadRequest(`${name} must be a whole number, 0 or more`);
  }
  return count;
}

/** A duration named in a URL, such as `30s`, checked for the same reason. */
function durationFrom(given: string, name: string): string {
  try {
    parseDuration(given, name);
  } catch (error) {
    throw new BadRequest((error as Error).message, { cause: error });
  }
  return given;
}

export const routes: readonly Route[] = [
  {
    method: "POST",
    path: "/services/:name/probes",
    handle: async (ctx): Promise<Reply> => {
      // Resolves when the commit lands. If this probe made the rule's condition hold, the
      // proposal is queued behind it and the move shows up on the next read.
      const committed = await services.send(ctx.name, probeFrom(ctx.body));
      return json(200, {
        key: committed.key,
        state: committed.state,
        values: committed.values,
        seq: committed.seq,
      });
    },
  },

  {
    method: "GET",
    path: "/services/:name",
    handle: async (ctx): Promise<Reply> => {
      // What a service is now comes from the instance, in memory or in the store, and
      // never from its history. A store folds old events into a snapshot, so a service
      // that plainly exists can have a history with no commit left in it.
      const key = services.key(ctx.name);
      const current =
        services.inspect(ctx.name) ??
        (await services.query({ includeValues: true })).instances.find(
          (match) => match.key === key
        );
      if (current === undefined) {
        return json(404, { error: "not_found", message: "no such service" });
      }

      const { events, complete } = await services.history(ctx.name);
      return json(200, {
        key,
        state: current.state,
        values: current.values,
        seq: current.seq,
        lastCommittedAt: current.lastCommittedAt,
        // Every proposal made to this service and why, straight out of its own stream.
        proposals: events.flatMap((event) =>
          event.type === "violation"
            ? [
                {
                  by: event.constraint.name,
                  kind: event.constraint.kind,
                  reason: event.reason,
                  at: event.at,
                },
              ]
            : []
        ),
        // False when the store has folded part of this service's history away, in which
        // case the list above is what is left of it.
        complete,
      });
    },
  },

  {
    method: "GET",
    path: "/map",
    handle: async (ctx): Promise<Reply> => {
      // The whole fleet in one call. `complete` and `reasons` are passed straight through:
      // someone acting on "nothing is unreachable" needs to know it was the whole answer.
      const limit = ctx.query.get("limitPerState");
      const map = await services.map(
        limit === null
          ? {}
          : { limitPerState: countFrom(limit, "limitPerState") }
      );
      return json(200, map);
    },
  },

  {
    method: "GET",
    path: "/quiet",
    handle: async (ctx): Promise<Reply> => {
      // Which services have said nothing lately, with what was last known about each.
      // The same measurement the freshness bound uses, asked on demand.
      const staleFor = durationFrom(ctx.query.get("for") ?? "30s", "for");
      const given = ctx.query.get("state");
      const state = SERVICE_STATES.find((known) => known === given);
      if (given !== null && state === undefined) {
        throw new BadRequest(
          `state must be one of: ${SERVICE_STATES.join(", ")}`
        );
      }
      const result = await services.query({
        staleFor,
        includeValues: true,
        ...(state === undefined ? {} : { state }),
      });
      return json(200, {
        query: { for: staleFor, state: state ?? null },
        count: result.instances.length,
        complete: result.complete,
        reasons: result.reasons,
        instances: result.instances,
      });
    },
  },

  {
    method: "GET",
    path: "/health",
    handle: (): Reply => json(200, { ok: true, memory: ekman.memoryUsage }),
  },
];
