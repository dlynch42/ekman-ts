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

export interface QueryCriteria<
  S extends string = string,
  V extends Values = Values,
> {
  readonly entity: string;
  /** Restrict to one state. Omitted means every state. */
  readonly state?: S;
  /**
   * Minimum time in the current state: a number of milliseconds, or a duration such as
   * `"5m"`. This is the "stuck in X for longer than N" filter.
   */
  readonly olderThan?: number | string;
  /** Stop after this many matches. A truncated answer reports itself as incomplete. */
  readonly limit?: number;
  /**
   * Carry each match's values. Off unless asked for, because reading the values of every
   * stored instance is the expensive form of a query and most questions are answered by
   * the key and the state.
   */
  readonly includeValues?: boolean;
  /**
   * Keep only the instances whose values pass. Applied by the runtime to resident and
   * stored instances alike, so the answer is exact and a store never has to understand it.
   * It makes the query read every candidate's values, which is the slow form. It must be
   * pure: a throw fails the query.
   */
  readonly where?: (values: Readonly<V>) => boolean;
}

export interface QueryMatch<
  S extends string = string,
  V extends Values = Values,
> {
  readonly key: string;
  readonly entity: string;
  readonly state: S;
  readonly seq: number;
  /** When the instance entered its current state, on the runtime's clock. */
  readonly enteredAt: number;
  /** How long it has been there, as of the instant the query was evaluated. */
  readonly ageMs: number;
  /** Whether this instance was in memory, or came from a store. */
  readonly resident: boolean;
  /** The committed values. Present only when the query set `includeValues`. */
  readonly values?: Readonly<V>;
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
  | "compacted"
  /**
   * Nothing durable holds the stream, and the instance has committed more events than a
   * runtime keeps in memory per key, so the oldest are gone. Current state, values and
   * sequence are unaffected.
   */
  | "history-capped"
  /**
   * Only memory was asked. Whatever was evicted, or has not been loaded by this runtime,
   * is left out, whether or not a store holds it.
   */
  | "resident-only";

export interface QueryResult<
  S extends string = string,
  V extends Values = Values,
> {
  readonly instances: readonly QueryMatch<S, V>[];
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

/** One state's share of a state map. */
export interface StateMapEntry {
  /** How many instances are in this state. Never reduced by `limitPerState`. */
  readonly count: number;
  /** Which ones, longest in the state first, ties by key. */
  readonly keys: readonly string[];
}

export interface StateMapOptions {
  /**
   * List at most this many keys per state. The counts stay whole, and a map that left
   * keys out reports `limit-reached`.
   */
  readonly limitPerState?: number;
}

/**
 * Where every instance of one entity is: how many in each state, and which.
 *
 * A state nothing is in has no entry, so the order of the states is the order instances
 * happened to be found in and carries no meaning.
 *
 * `byState` has no prototype. `byState[state]` is therefore undefined for any state
 * nothing is in, including one named `constructor` or `toString`, and the object has no
 * methods of its own: use `Object.keys`, `Object.entries` or `Object.hasOwn` on it.
 */
export interface StateMap<S extends string = string> {
  readonly entity: string;
  readonly byState: Readonly<Partial<Record<S, StateMapEntry>>>;
  /** Every instance counted, across all states. */
  readonly total: number;
  /** Whether every instance of the entity was counted and listed. */
  readonly complete: boolean;
  readonly reasons: readonly Partiality[];
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
