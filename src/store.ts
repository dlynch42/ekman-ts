import type { EkmanEvent, TransitionEvent } from "./events";
import type { Values } from "./types";

/**
 * The adapter contract.
 *
 * A store is the only thing that knows whether a commit survives the process. Everything
 * about durability in this runtime reduces to which store is the commit authority and what
 * that store honestly declares it can do.
 *
 * The contract is small on purpose. Four operations carry the semantics; a fifth reads the
 * full stream back. A port implements this much and inherits the shared contract tests.
 */

/** The sequence reported for a key the store has never seen. */
export const EMPTY_SEQ = -1;

/**
 * What a store can actually do, declared rather than assumed.
 *
 * The runtime refuses a configuration these cannot satisfy instead of silently
 * under-delivering. Claiming durability a store does not have is the one lie a state
 * runtime must never tell, so every field here is a promise the adapter is held to by the
 * contract tests.
 */
export interface StoreCapabilities {
  /**
   * `durable` means a commit survives the process. `ephemeral` means it does not, which is
   * a valid documented mode rather than a degraded one.
   */
  readonly durability: "ephemeral" | "durable";
  /** Whether `append` is genuinely conditional on `expectedSeq`, atomically. */
  readonly conditionalAppend: boolean;
  /**
   * Whether that conditional append holds across processes.
   *
   * A store can be perfectly conditional within one runtime and useless across two. The
   * distinction is what lets the runtime refuse multi-writer configurations exactly.
   */
  readonly multiWriter: boolean;
  /** Which scan criteria this store can evaluate. Anything else is reported unsupported. */
  readonly scan: {
    readonly byState: boolean;
    readonly olderThan: boolean;
  };
  /**
   * Whether this store can delete a key's stream outright.
   *
   * Declared rather than assumed, because a store built on an append-only medium may have
   * no way to remove anything. Saying so lets retention be refused exactly instead of
   * appearing to work and quietly keeping everything.
   */
  readonly forget: boolean;
  /**
   * Whether this store can reclaim space by compacting what it holds.
   *
   * Separate from `forget` because the two cost different things. Compaction folds events
   * into a snapshot and costs history alone; deleting costs the instance. A store can
   * honestly offer either, both, or neither.
   */
  readonly compact: boolean;
}

/**
 * What one compaction pass did.
 *
 * `withinBudget` is false when the pass ran out of things to fold before it reached the
 * bound. Compaction has a floor: once every log is a bare snapshot there is nothing left
 * to reclaim, and a store that has hit that floor is over its bound and has to say so
 * rather than sweeping forever.
 */
export interface StoreCompaction {
  /** How many logs were folded. */
  readonly logs: number;
  /** Bytes given back. */
  readonly reclaimed: number;
  readonly withinBudget: boolean;
}

/**
 * One storage sweep, summed across every layer that could reclaim.
 *
 * `overBudget` names layers rather than counting them, because a stack can hold several and
 * "something is over" is not an actionable sentence. A layer appearing here has reached the
 * floor of what compaction can give back and is still above its bound, which is a signal to
 * raise the bound or delete instances, not to sweep again.
 */
export interface StorageSweep {
  readonly logs: number;
  readonly reclaimed: number;
  readonly overBudget: readonly string[];
}

/** A point-in-time picture of an instance, enough to skip replaying from the beginning. */
export interface StoreSnapshot<
  S extends string = string,
  V extends Values = Values,
> {
  readonly key: string;
  readonly entity: string;
  readonly state: S;
  readonly values: Readonly<V>;
  readonly seq: number;
  /** When the instance entered `state`, so time in state survives a restart. */
  readonly enteredAt: number;
  /** When the snapshot was taken. */
  readonly at: number;
}

/**
 * Everything needed to rebuild an instance: a snapshot if there is one, plus every event
 * after it.
 *
 * `seq` is the latest committed sequence, which is what the next `append` must be
 * conditional on.
 */
export interface LoadResult<
  S extends string = string,
  V extends Values = Values,
> {
  readonly snapshot: StoreSnapshot<S, V> | undefined;
  readonly events: readonly EkmanEvent<S, V>[];
  readonly seq: number;
}

export interface ScanCriteria {
  readonly entity: string;
  readonly state?: string;
  /** Minimum milliseconds in state. */
  readonly olderThanMs?: number;
  /** The instant `olderThanMs` is measured against, from the runtime's clock. */
  readonly now: number;
  readonly limit?: number;
}

export interface ScanMatch {
  readonly key: string;
  readonly entity: string;
  readonly state: string;
  readonly seq: number;
  readonly enteredAt: number;
}

export interface ScanResult {
  readonly matches: readonly ScanMatch[];
  /**
   * Criteria this store could not evaluate, named so the runtime can report a partial
   * answer as partial. A store that quietly ignores a filter turns a query into a lie.
   */
  readonly unsupported: readonly string[];
  /** False when the answer was truncated, by a limit or by anything else. */
  readonly complete: boolean;
}

/**
 * What a store is holding, and what it is allowed to hold. `null` means unlimited.
 *
 * Reported rather than emitted, because a store has no telemetry handle: it is built by
 * the caller and handed in. Optional on the interface, since a store with nothing to
 * measure should say nothing rather than invent a number.
 */
export interface StoreUsage {
  readonly bytes: number;
  readonly logs: number;
  readonly maxBytes: number | null;
}

export interface Store {
  /** Identifies this layer in telemetry and in a query's `sources`. */
  readonly name: string;
  readonly capabilities: StoreCapabilities;
  /**
   * Claim to be the commit authority, overriding the runtime's own choice.
   *
   * Omitted is the normal case: the runtime picks the last durable layer, or the last layer
   * when none is durable. Two layers claiming it is a refused configuration.
   */
  readonly authority?: boolean;

  /**
   * Append one event, conditional on the key's latest committed sequence.
   *
   * Fails with `STORE_CONFLICT` and **no side effects** when the condition does not hold.
   * That is what makes a failed append safe to react to: the caller knows nothing landed.
   *
   * Only a transition event advances the sequence. A rejection or a violation appends with
   * the sequence it followed, and leaves the condition for the next append unchanged.
   */
  readonly append: (
    key: string,
    event: EkmanEvent,
    expectedSeq: number
  ) => Promise<void>;

  /** Rebuild material for a key, or undefined if the store has never seen it. */
  readonly load: (key: string) => Promise<LoadResult | undefined>;

  /** The full ordered stream for a key, including events before any snapshot. */
  readonly read: (key: string) => Promise<readonly EkmanEvent[]>;

  /** Persist a snapshot. Idempotent per (key, seq): writing the same one twice is a no-op. */
  readonly snapshot: (key: string, snapshot: StoreSnapshot) => Promise<void>;

  /** Keys matching the criteria, with whatever the store could not evaluate declared. */
  readonly scan: (criteria: ScanCriteria) => Promise<ScanResult>;

  /**
   * Delete everything this store holds for a key: its stream and any snapshot.
   *
   * Present only when `capabilities.forget` says so. Deleting a key that was never here is
   * not an error, so a retry after a partial sweep behaves the same as the first attempt.
   *
   * This destroys committed state. The runtime is what decides whether that is allowed and
   * whether the key is idle enough for it; a store asked to forget just forgets.
   */
  readonly forget?: (key: string) => Promise<void>;

  /**
   * Reclaim space by compacting, according to whatever bound this store was configured
   * with. Present only when `capabilities.compact` says so.
   *
   * Off the commit path by design: choosing what to compact means looking across keys, and
   * a walk of the whole store is the wrong thing to do while a caller waits on an append.
   * The runtime drives this on its own schedule.
   *
   * Compaction costs history and never state. Current values, the sequence, and replay are
   * untouched, so an attempt already in flight against a compacted key still commits.
   */
  readonly compact?: () => Promise<StoreCompaction>;

  /** What this store is holding, when it accounts for itself. */
  readonly usage?: StoreUsage;

  /** Release anything held open. Optional, because a memory store holds nothing. */
  readonly close?: () => Promise<void>;
}

/**
 * Rebuild current state from a load.
 *
 * Shared by every adapter and by the runtime, because "replay" having one meaning is the
 * whole point of the event stream. Only transition events reconstruct: a rejection or a
 * violation records that something happened, not that anything changed.
 */
export interface ReplayedState<
  S extends string = string,
  V extends Values = Values,
> {
  readonly state: S;
  readonly values: Readonly<V>;
  readonly seq: number;
  readonly enteredAt: number;
}

export function replay<S extends string, V extends Values>(
  loaded: LoadResult<S, V>
): ReplayedState<S, V> | undefined {
  const { snapshot } = loaded;
  let current: ReplayedState<S, V> | undefined =
    snapshot === undefined
      ? undefined
      : {
          state: snapshot.state,
          values: snapshot.values,
          seq: snapshot.seq,
          enteredAt: snapshot.enteredAt,
        };

  for (const event of loaded.events) {
    if (event.type !== "transition") {
      continue;
    }

    const transition = event as TransitionEvent<S, V>;
    // Events already folded into the snapshot are skipped rather than reapplied.
    if (current !== undefined && transition.seq <= current.seq) {
      continue;
    }

    current = {
      state: transition.to,
      values: transition.values,
      seq: transition.seq,
      // A move restarts time in state; a values-only commit leaves it running.
      enteredAt:
        transition.from === transition.to && current !== undefined
          ? current.enteredAt
          : transition.at,
    };
  }

  return current;
}

/** The sequence a key is at after these events, ignoring everything that is not a commit. */
export function latestSeq(events: readonly EkmanEvent[]): number {
  let seq = EMPTY_SEQ;
  for (const { type, seq: eventSeq } of events) {
    if (type === "transition") {
      seq = eventSeq;
    }
  }
  return seq;
}

/** The entity name a key addresses: its first segment. */
export function entityOf(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? key : key.slice(0, separator);
}

/**
 * Walk keys and evaluate them against scan criteria.
 *
 * Shared by every adapter that can enumerate its own keys, which is what keeps two
 * implementations of "in this state for longer than N" from drifting apart. An adapter with
 * a real index (Postgres, later) replaces this with a query and declares the same result
 * shape.
 */
export async function scanKeys(
  keys: Iterable<string>,
  criteria: ScanCriteria,
  load: (key: string) => Promise<LoadResult | undefined>
): Promise<ScanResult> {
  const matches: ScanMatch[] = [];

  for (const key of keys) {
    if (entityOf(key) !== criteria.entity) {
      continue;
    }

    if (criteria.limit !== undefined && matches.length >= criteria.limit) {
      // Reported rather than silently returned as a whole answer.
      return { matches, unsupported: [], complete: false };
    }

    // biome-ignore lint/performance/noAwaitInLoops: keys are walked in order so that a limit truncates deterministically, which a port has to reproduce
    const loaded = await load(key);
    const match =
      loaded === undefined ? undefined : toMatch(key, criteria, loaded);
    if (match !== undefined) {
      matches.push(match);
    }
  }

  return { matches, unsupported: [], complete: true };
}

function toMatch(
  key: string,
  criteria: ScanCriteria,
  loaded: LoadResult
): ScanMatch | undefined {
  const current = replay(loaded);
  if (current === undefined) {
    return;
  }
  if (criteria.state !== undefined && current.state !== criteria.state) {
    return;
  }
  if (
    criteria.olderThanMs !== undefined &&
    criteria.now - current.enteredAt < criteria.olderThanMs
  ) {
    return;
  }

  return {
    key,
    entity: entityOf(key),
    state: current.state,
    seq: current.seq,
    enteredAt: current.enteredAt,
  };
}
