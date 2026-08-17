import { EkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import type { Values } from "./types";

/**
 * Queries: the operational half of the runtime.
 *
 * "What is stuck in `deploying`, and for how long" is the question that makes a state
 * runtime worth embedding, and the one that homegrown versions never answer. The whole
 * design problem here is honesty: a query can only see what the configured stores can see,
 * and an answer that quietly leaves things out is worse than no query at all.
 *
 * So every result says whether it is complete, and why not when it is not.
 */

export interface QueryCriteria {
  readonly entity: string;
  /** Restrict to one state. Omitted means every state. */
  readonly state?: string;
  /**
   * Minimum time in the current state: a number of milliseconds, or a duration such as
   * `"5m"`. This is the "stuck in X for longer than N" filter.
   */
  readonly olderThan?: number | string;
  /** Stop after this many matches. A truncated answer reports itself as incomplete. */
  readonly limit?: number;
}

export interface QueryMatch {
  readonly key: string;
  readonly entity: string;
  readonly state: string;
  readonly seq: number;
  /** When the instance entered its current state, on the runtime's clock. */
  readonly enteredAt: number;
  /** How long it has been there, as of the instant the query was evaluated. */
  readonly ageMs: number;
  /** Whether this instance was in memory, or came from a store. */
  readonly resident: boolean;
}

/** Why an answer is not the whole answer. */
export type Partiality =
  /**
   * Nothing durable is configured, so the answer covers what this runtime happens to
   * retain and nothing that was evicted or committed before it started.
   */
  | "no-durable-store"
  /** A store could not evaluate one of the filters, so it was applied after the fact. */
  | "unsupported-criteria"
  /** The answer was truncated by `limit`. */
  | "limit-reached"
  /**
   * The stream was compacted, so events before the snapshot are gone.
   *
   * Current state, values and sequence are unaffected: everything dropped had already
   * been folded into the snapshot. What is missing is the middle of the history.
   */
  | "compacted";

export interface QueryResult {
  readonly instances: readonly QueryMatch[];
  /**
   * Whether this is every instance matching the criteria.
   *
   * False does not mean the answer is wrong. It means something in the configuration
   * cannot see everything, and `reasons` says what.
   */
  readonly complete: boolean;
  readonly reasons: readonly Partiality[];
  /** Which store layers, if any, contributed. `resident` is always in here. */
  readonly sources: readonly string[];
}

export interface HistoryResult<
  S extends string = string,
  V extends Values = Values,
> {
  readonly key: string;
  readonly events: readonly EkmanEvent<S, V>[];
  /** Whether this is the instance's whole history. */
  readonly complete: boolean;
  readonly reasons: readonly Partiality[];
  readonly sources: readonly string[];
}

/**
 * Weave the restores this runtime recorded into the stream the store holds.
 *
 * A restore is not persisted, because writing one would turn every read into a write, and
 * would do so worst under a small memory budget where reloads are the whole point. But it
 * is still the thing that explains a stream picking up mid-life, so a history read puts it
 * back where it happened.
 *
 * Placement is "after everything the store holds at or below the sequence it restored to".
 * Two events sharing a sequence have no defined order between them anyway, so the only
 * imprecision this can produce is one the model does not promise to avoid.
 */
export function mergeRestores<S extends string, V extends Values>(
  stored: readonly EkmanEvent<S, V>[],
  resident: readonly EkmanEvent<S, V>[]
): readonly EkmanEvent<S, V>[] {
  const restores = resident.filter((event) => event.type === "restored");
  if (restores.length === 0) {
    return stored;
  }

  const merged: EkmanEvent<S, V>[] = [];
  let next = 0;

  for (const restore of restores) {
    while (
      next < stored.length &&
      (stored[next] as EkmanEvent).seq <= restore.seq
    ) {
      merged.push(stored[next] as EkmanEvent<S, V>);
      next += 1;
    }
    merged.push(restore);
  }

  merged.push(...stored.slice(next));
  return merged;
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Read a duration: a number of milliseconds, or a string such as `"5m"`.
 *
 * The string form exists because `olderThan: "5m"` is what an operator actually wants to
 * write, and `olderThan: 300000` is a number nobody checks twice. Both are accepted; a
 * string that is not a duration is refused rather than guessed at.
 */
export function parseDuration(value: number | string): number {
  if (typeof value === "number") {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `olderThan must be a non-negative number of milliseconds, received ${JSON.stringify(value)}`
      );
    }
    return value;
  }

  const match = DURATION.exec(value.trim());
  const unit = match?.[2];
  if (match === null || unit === undefined) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `olderThan ${JSON.stringify(value)} is not a duration. Use a number of milliseconds, ` +
        'or a value with a unit such as "500ms", "30s", "5m", "2h" or "1d".'
    );
  }

  return Number(match[1]) * (UNITS[unit] as number);
}
