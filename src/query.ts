import { EkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import { parseKey } from "./key";
import type { Residency } from "./residency";
import type { ResolvedStack } from "./stack";
import type { ScanCriteria, ScanFilter, ScanMatch, Store } from "./store";
import { lastCommitOf, replay } from "./store";
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
  /**
   * Minimum time since the instance last committed anything: a number of milliseconds,
   * or a duration such as `"5m"`. This is the "nothing heard from it for N" filter, and it
   * runs on a different clock from `olderThan`: a values-only commit resets this one and
   * leaves time in state running.
   */
  readonly staleFor?: number | string;
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
  /**
   * When the instance last committed anything, on the runtime's clock. Absent only for
   * a stored instance whose store does not know, which a query by `staleFor` never
   * returns.
   */
  readonly lastCommittedAt?: number;
  /** How long ago that was, as of the instant the query was evaluated. */
  readonly staleMs?: number;
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
 * Read a duration: a number of milliseconds, or a string such as `"5m"`. `what` names
 * the option being read, for the refusal.
 *
 * The string form exists because `olderThan: "5m"` is what an operator actually wants to
 * write, and `olderThan: 300000` is a number nobody checks twice. Both are accepted; a
 * string that is not a duration is refused rather than guessed at.
 */
export function parseDuration(
  value: number | string,
  what = "olderThan"
): number {
  if (typeof value === "number") {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `${what} must be a non-negative number of milliseconds, received ${JSON.stringify(value)}`
      );
    }
    return value;
  }

  const match = DURATION.exec(value.trim());
  const unit = match?.[2];
  if (match === null || unit === undefined) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${what} ${JSON.stringify(value)} is not a duration. Use a number of milliseconds, ` +
        'or a value with a unit such as "500ms", "30s", "5m", "2h" or "1d".'
    );
  }

  return Number(match[1]) * (UNITS[unit] as number);
}

/** What the read path needs from the runtime: the clock, the stores, and what is resident. */
export interface ReadContext {
  readonly now: () => number;
  readonly stack: ResolvedStack;
  readonly residency: Residency;
  /**
   * Refuse an entity nobody registered, before a store is asked about it.
   *
   * @param entity the name to check
   * @param key the key that named it, when one did, for the error
   */
  readonly known: (entity: string, key?: string) => void;
}

/** One key's ordered event stream, and whether it is the whole of it. */
export async function readHistory<
  S extends string = string,
  V extends Values = Values,
>(ctx: ReadContext, key: string): Promise<HistoryResult<S, V>> {
  const { key: parsed, entity } = parseKey(key);
  ctx.known(entity, key);
  const instance = ctx.residency.get(parsed);
  const { authority } = ctx.stack;

  if (authority === undefined) {
    return Object.freeze({
      key: parsed,
      events: (instance?.events ?? []) as readonly EkmanEvent<S, V>[],
      complete: false,
      reasons:
        instance?.historyTrimmed === true ? CAPPED_IN_MEMORY : NO_DURABLE_STORE,
      sources: RESIDENT_ONLY,
    });
  }

  // Refusals and violations are written without being awaited, so without this a read
  // taken immediately after one could miss it and report a stream with a hole in it.
  await instance?.flushed();

  const stored = (await authority.read(parsed)) as readonly EkmanEvent<S, V>[];

  const compacted = await wasCompacted(parsed, stored, authority);

  return Object.freeze({
    key: parsed,
    // Restores are never persisted, so they are woven back in here. Without that, a
    // stream read after a reload would give no sign that anything was reloaded.
    events: mergeRestores(
      stored,
      (instance?.events ?? []) as readonly EkmanEvent<S, V>[]
    ),
    complete: ctx.stack.durable && !compacted,
    reasons: partiality(ctx.stack.durable, compacted),
    sources: Object.freeze([authority.name, "resident"]),
  });
}

/** Resident and stored instances matching the criteria, oldest first. */
export async function queryInstances<
  S extends string = string,
  V extends Values = Values,
>(ctx: ReadContext, criteria: QueryCriteria<S, V>): Promise<QueryResult<S, V>> {
  ctx.known(criteria.entity);
  const { limit } = criteria;
  assertLimit(limit, "a query's limit", "every match");
  const at = ctx.now();
  const olderThanMs =
    criteria.olderThan === undefined
      ? undefined
      : parseDuration(criteria.olderThan);
  const staleForMs =
    criteria.staleFor === undefined
      ? undefined
      : parseDuration(criteria.staleFor, "staleFor");
  const where = criteria.where as
    | ((values: Readonly<Values>) => boolean)
    | undefined;
  const showing = criteria.includeValues === true;
  const reading = showing || where !== undefined;

  const reasons = new Set<Partiality>();
  const sources = ["resident"];
  const matches = new Map<string, QueryMatch>();

  for (const match of residentMatches(
    ctx.residency,
    criteria.entity,
    criteria.state,
    olderThanMs,
    at,
    reading
  )) {
    // Only when the query asked. A clock that steps backwards can put the last commit
    // ahead of now, and a filter nobody set must not drop the instance over that.
    if (staleForMs === undefined || staleForMs <= (match.staleMs as number)) {
      matches.set(match.key, match);
    }
  }

  const { authority } = ctx.stack;
  if (authority === undefined) {
    reasons.add("no-durable-store");
  } else {
    sources.push(authority.name);
    await scanInto(
      matches,
      authority,
      criteria.entity,
      criteria.state,
      olderThanMs,
      staleForMs,
      at,
      reading,
      reasons
    );
    if (!ctx.stack.durable) {
      reasons.add("no-durable-store");
    }
  }

  // Applied after the union, to resident and stored matches alike, so the filter is
  // exact wherever an instance happened to be.
  const found =
    where === undefined
      ? [...matches.values()]
      : [...matches.values()].filter((match) =>
          where(match.values as Readonly<Values>)
        );

  // Applied last, so a limit cannot silently prefer resident instances over stored ones
  // or the other way round.
  const truncated = limit !== undefined && limit < found.length;
  const ordered = truncated ? oldest(found, limit) : found.sort(byAgeThenKey);
  // Values read only to evaluate `where` are not part of an answer that did not ask.
  const instances = reading && !showing ? ordered.map(withoutValues) : ordered;

  if (truncated) {
    reasons.add("limit-reached");
  }

  return Object.freeze({
    instances: Object.freeze(instances),
    complete: reasons.size === 0,
    reasons: Object.freeze([...reasons]),
    sources: Object.freeze(sources),
  }) as QueryResult<S, V>;
}

/** Where every instance of an entity is: a count and the keys for each state. */
export async function mapStates<S extends string = string>(
  ctx: ReadContext,
  entity: string,
  options: StateMapOptions = {}
): Promise<StateMap<S>> {
  const { limitPerState } = options;
  assertLimit(limitPerState, "a map's limitPerState", "every key");
  const found = await queryInstances(ctx, { entity });
  return stateMap<S>(
    entity,
    found.instances,
    found.reasons,
    found.sources,
    limitPerState
  );
}

/** The state map of what is in memory, without asking a store. */
export function residentStateMap<S extends string = string>(
  ctx: ReadContext,
  entity: string
): StateMap<S> {
  ctx.known(entity);
  const instances = [
    ...residentMatches(
      ctx.residency,
      entity,
      undefined,
      undefined,
      ctx.now(),
      false
    ),
  ].sort(byAgeThenKey);
  return stateMap<S>(entity, instances, IN_MEMORY_ONLY, RESIDENT_ONLY);
}

/** Resident instances matching the criteria, read through the same index the sweep uses. */
function* residentMatches(
  residency: Residency,
  entity: string,
  only: string | undefined,
  olderThanMs: number | undefined,
  at: number,
  reading: boolean
): Generator<QueryMatch> {
  const states = only === undefined ? residency.statesIn(entity) : [only];

  for (const state of states) {
    for (const key of residency.keysIn(entity, state)) {
      const aged = residency.ageOf(key, state, at);
      if (aged === undefined || (olderThanMs ?? 0) > aged.elapsedMs) {
        continue;
      }

      yield {
        key,
        entity,
        state,
        seq: aged.instance.seq,
        enteredAt: aged.instance.enteredAt,
        ageMs: aged.elapsedMs,
        resident: true,
        lastCommittedAt: aged.instance.lastCommittedAt,
        staleMs: at - aged.instance.lastCommittedAt,
        ...(reading ? { values: aged.instance.values } : {}),
      };
    }
  }
}

/**
 * Add the store's matches, leaving any key the resident view already answered.
 *
 * Resident wins because it is the more current of the two: the store lags by whatever is
 * queued behind the last commit, and an instance in memory is by definition up to date.
 * The store is told which keys those are, so it does not load what would be discarded.
 * Only keys that matched are named. A resident instance that did not match is still
 * asked about, because its stored row is the answer when another writer has moved it.
 *
 * The caller's limit is not passed down. A store truncates in key order and the answer
 * is ordered by age, so a store that stopped early could drop a row older than every one
 * it returned.
 *
 * A match is rebuilt field by field, so values a store returned without being asked
 * never reach an answer that did not ask for them.
 */
async function scanInto(
  matches: Map<string, QueryMatch>,
  authority: Store,
  entity: string,
  state: string | undefined,
  olderThanMs: number | undefined,
  staleForMs: number | undefined,
  at: number,
  reading: boolean,
  reasons: Set<Partiality>
): Promise<void> {
  const result = await scanStore(authority, {
    entity,
    now: at,
    ...(state === undefined ? {} : { state }),
    ...(olderThanMs === undefined ? {} : { olderThanMs }),
    ...(staleForMs === undefined ? {} : { staleForMs }),
    skip: new Set(matches.keys()),
    ...(reading ? { includeValues: true } : {}),
  });

  if (!result.complete) {
    reasons.add("limit-reached");
  }
  if (result.filtered) {
    reasons.add("unsupported-criteria");
  }

  for (const match of result.matches) {
    if (!matches.has(match.key)) {
      matches.set(match.key, {
        key: match.key,
        entity: match.entity,
        state: match.state,
        seq: match.seq,
        enteredAt: match.enteredAt,
        ageMs: at - match.enteredAt,
        resident: false,
        ...(match.lastCommittedAt === undefined
          ? {}
          : {
              lastCommittedAt: match.lastCommittedAt,
              staleMs: at - match.lastCommittedAt,
            }),
        ...(reading ? { values: match.values as Readonly<Values> } : {}),
      });
    }
  }
}

/**
 * Scan a store, applying here whatever criteria it could not apply itself.
 *
 * A store that could not filter says so and hands back more than was asked for. The
 * filter is finished here, so a query and a sweep both get exactly the rows they asked
 * about, and `filtered` says that it had to be.
 *
 * What the store declared it cannot do counts as well as what this answer reported, so
 * a store that declares no filter by state and then forgets to say so in an answer is
 * still filtered. The declaration and the answer cannot disagree.
 *
 * Values are finished here in the same way. A store asked for them that returned a match
 * without any has that key loaded, so every match of a scan that asked carries values.
 */
export async function scanStore(
  authority: Store,
  criteria: ScanCriteria
): Promise<{
  matches: readonly ScanMatch[];
  complete: boolean;
  filtered: boolean;
}> {
  const result = await authority.scan(criteria);
  const { state, olderThanMs, staleForMs, now } = criteria;
  const declared = authority.capabilities.scan;
  const unsupported = new Set<ScanFilter>(result.unsupported);
  if (!declared.byState && state !== undefined) {
    unsupported.add("state");
  }
  if (!declared.olderThan && olderThanMs !== undefined) {
    unsupported.add("olderThan");
  }
  if (declared.staleFor !== true && staleForMs !== undefined) {
    unsupported.add("staleFor");
  }

  // What a row already says is settled before anything is loaded. A store that could
  // not filter hands back every instance of the entity, and reading each one's values
  // or last commit only to discard it on its state would replay the whole entity.
  const filtered = unsupported.size > 0;
  const narrowed = filtered
    ? result.matches.filter((match) => isPlaced(match, criteria))
    : result.matches;
  const read = await readMissing(
    authority,
    criteria,
    narrowed,
    unsupported.has("staleFor")
  );
  const matches = unsupported.has("staleFor")
    ? read.filter((match) => isQuiet(match, staleForMs as number, now))
    : read;

  return { matches, complete: result.complete, filtered };
}

/**
 * Load whatever a scan needed from a match and a store left off it.
 *
 * Values, when the scan asked for them. And the time of the last commit, when the
 * runtime has to finish a freshness filter the store could not apply and so cannot go
 * by the store's word for which rows passed it.
 *
 * The key can have committed between the scan and this load, so the match is rebuilt
 * whole from what was loaded and held to the criteria again. Laying the loaded values
 * over the scan's row would describe a revision that never existed: one commit's state
 * and sequence with a later commit's values.
 *
 * A match whose key is gone by the time it is loaded was deleted in between, and is
 * dropped: it is no longer an instance.
 */
async function readMissing(
  authority: Store,
  criteria: ScanCriteria,
  matches: readonly ScanMatch[],
  filteringByLastCommit: boolean
): Promise<readonly ScanMatch[]> {
  const lacks = (match: ScanMatch): boolean =>
    (criteria.includeValues === true && match.values === undefined) ||
    (filteringByLastCommit && match.lastCommittedAt === undefined);
  if (!matches.some(lacks)) {
    return matches;
  }

  const read = await Promise.all(
    matches.map(async (match) => {
      if (!lacks(match)) {
        return match;
      }
      const loaded = await authority.load(match.key);
      const current = loaded === undefined ? undefined : replay(loaded);
      if (
        current === undefined ||
        !isPlaced(current, criteria) ||
        !(
          criteria.staleForMs === undefined ||
          isQuiet(current, criteria.staleForMs, criteria.now)
        )
      ) {
        return;
      }
      return {
        key: match.key,
        entity: match.entity,
        state: current.state,
        seq: current.seq,
        enteredAt: current.enteredAt,
        ...(criteria.includeValues === true ? { values: current.values } : {}),
        ...lastCommitOf(current),
      };
    })
  );
  return read.filter((match) => match !== undefined);
}

/**
 * Whether a snapshot has absorbed events this stream can no longer show.
 *
 * Asked of the events rather than of the store, so every adapter answers it the same way
 * with no capability for it: a whole stream holds the transition that initialized the
 * instance, and one without it is missing its beginning. The earliest event's sequence
 * cannot answer this, because refusals and violations survive compaction and one recorded
 * at sequence zero would make a folded stream read as whole.
 *
 * A stream with no initialization in it is the case events alone cannot settle. A key
 * that was never initialized and a key whose beginning is inside its snapshot look
 * identical from here, and only the snapshot tells them apart.
 */
async function wasCompacted(
  key: string,
  stored: readonly EkmanEvent[],
  authority: Store
): Promise<boolean> {
  if (
    stored.some((event) => event.type === "transition" && event.from === null)
  ) {
    return false;
  }
  return (await authority.load(key))?.snapshot !== undefined;
}

const NONE: readonly Partiality[] = Object.freeze([]);

const NO_DURABLE_STORE: readonly Partiality[] = Object.freeze([
  "no-durable-store" as const,
]);

const CAPPED_IN_MEMORY: readonly Partiality[] = Object.freeze([
  "no-durable-store" as const,
  "history-capped" as const,
]);

const RESIDENT_ONLY: readonly string[] = Object.freeze(["resident"]);

const IN_MEMORY_ONLY: readonly Partiality[] = Object.freeze([
  "resident-only" as const,
]);

const COMPACTED: readonly Partiality[] = Object.freeze(["compacted"]);

/** Why a history is not the whole story, if it is not. */
function partiality(
  durable: boolean,
  compacted: boolean
): readonly Partiality[] {
  if (!durable) {
    return NO_DURABLE_STORE;
  }
  return compacted ? COMPACTED : NONE;
}

/** Refuse a limit that is not a count. `undefined` means no limit. */
function assertLimit(
  limit: number | undefined,
  what: string,
  everything: string
): void {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${what} must be a non-negative integer, received ${JSON.stringify(limit)}. ` +
        `Omit it to ask for ${everything}.`
    );
  }
}

/** Whether one committed revision of an instance meets a scan's state and age criteria. */
function isPlaced(
  current: { readonly state: string; readonly enteredAt: number },
  criteria: ScanCriteria
): boolean {
  return (
    (criteria.state === undefined || current.state === criteria.state) &&
    (criteria.olderThanMs === undefined ||
      criteria.now - current.enteredAt >= criteria.olderThanMs)
  );
}

/** A match as an answer that did not ask for values shows it. */
function withoutValues(match: QueryMatch): QueryMatch {
  const { values: _values, ...rest } = match;
  return rest;
}

/**
 * Group matches by state. They arrive oldest first, so each state's keys come out oldest
 * first as well. Grouped in a `Map` and then laid into an object with no prototype, so a
 * state with a name an object treats specially is an ordinary entry when present and
 * absent when not.
 */
function stateMap<S extends string>(
  entity: string,
  instances: readonly QueryMatch[],
  reasons: readonly Partiality[],
  sources: readonly string[],
  limitPerState?: number
): StateMap<S> {
  const groups = new Map<string, { count: number; keys: string[] }>();
  let truncated = false;

  for (const { state, key } of instances) {
    let group = groups.get(state);
    if (group === undefined) {
      group = { count: 0, keys: [] };
      groups.set(state, group);
    }
    group.count += 1;
    if (limitPerState === undefined || group.keys.length < limitPerState) {
      group.keys.push(key);
    } else {
      truncated = true;
    }
  }

  const all = new Set(reasons);
  if (truncated) {
    all.add("limit-reached");
  }

  // With no prototype, so a state nothing is in reads as undefined whatever it is called.
  // On an ordinary object `byState.constructor` is a function every object inherits.
  const byState: Record<string, StateMapEntry> = Object.create(null);
  for (const [state, { count, keys }] of groups) {
    byState[state] = Object.freeze({ count, keys: Object.freeze(keys) });
  }

  return Object.freeze({
    entity,
    byState: Object.freeze(byState) as StateMap<S>["byState"],
    total: instances.length,
    complete: all.size === 0,
    reasons: Object.freeze([...all]),
    sources,
  });
}

/**
 * Oldest first, which is the order the question is asked in: "what has been stuck longest".
 * Ties break on the key so a limited answer is the same answer twice.
 *
 * Keys are compared as plain strings and not by locale, so the order is the same on every
 * machine. Two matches never share a key, so there is no equal case.
 */
function byAgeThenKey(a: QueryMatch, b: QueryMatch): number {
  if (a.ageMs !== b.ageMs) {
    return b.ageMs - a.ageMs;
  }
  return a.key < b.key ? -1 : 1;
}

/** The longest list `oldest` keeps in order by insertion. */
const BOUNDED_INSERTION_LIMIT = 64;

/**
 * The first `limit` matches in `byAgeThenKey` order, without sorting the rest.
 *
 * A short sorted list is kept and each match is placed into it by binary search, or passed
 * over when it would land past the end. A dashboard asking for ten of a hundred thousand
 * pays for the ten.
 *
 * Only while the list is short. Placing a match moves everything after it, so matches
 * that arrive newest first cost the length of the list each, and a limit just under the
 * number of matches would make that the square of it. Past `BOUNDED_INSERTION_LIMIT` the
 * matches are sorted and cut, which is what an untruncated answer costs anyway.
 */
function oldest(matches: Iterable<QueryMatch>, limit: number): QueryMatch[] {
  if (limit > BOUNDED_INSERTION_LIMIT) {
    return [...matches].sort(byAgeThenKey).slice(0, limit);
  }

  const kept: QueryMatch[] = [];

  for (const match of matches) {
    const last = kept[limit - 1];
    if (last !== undefined && byAgeThenKey(match, last) > 0) {
      continue;
    }

    let low = 0;
    let high = kept.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (byAgeThenKey(kept[middle] as QueryMatch, match) < 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    kept.splice(low, 0, match);
    if (kept.length > limit) {
      kept.pop();
    }
  }

  return kept;
}

/**
 * Whether a scan row has gone at least this long without a commit. A row whose last
 * commit time the store does not know has not: unknown is not stale.
 */
export function isQuiet(
  match: { readonly lastCommittedAt?: number | undefined },
  forMs: number,
  at: number
): boolean {
  return (
    match.lastCommittedAt !== undefined && at - match.lastCommittedAt >= forMs
  );
}
