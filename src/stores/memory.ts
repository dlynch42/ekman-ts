import { assertKnownKeys } from "../config";
import { EkmanError } from "../errors";
import type { EkmanEvent } from "../events";
import type {
  LoadResult,
  ScanCriteria,
  ScanResult,
  Store,
  StoreCapabilities,
  StoreSnapshot,
} from "../store";
import {
  EMPTY_SEQ,
  isAfterSnapshot,
  replay,
  scanKeys,
  snapshotOf,
} from "../store";

/**
 * What a memory store keeps for a key.
 *
 * - `stream`: every event, which is what `history()` reads and what a commit authority
 *   has to keep.
 * - `state`: one snapshot and the few events since it, folded into the snapshot every
 *   `STATE_FOLD_EVERY` events. Enough to answer a load, which is the one read a cache
 *   layer serves, and it does not grow with the key's history.
 */
export type MemoryKeep = "stream" | "state";

/**
 * How many events a key may gather, when only state is kept, before they are folded into
 * its snapshot.
 *
 * Folding on every event would put a replay on the path of every commit. Folding in
 * batches costs a push per commit, and bounds what a key holds all the same.
 */
export const STATE_FOLD_EVERY = 16;

export interface MemoryStoreOptions {
  readonly name?: string;
  readonly authority?: boolean;
  /**
   * What to keep for a key. Defaults to `state` when the store is a cache layer and to
   * `stream` otherwise. `state` is refused on a commit authority, which would lose the
   * history it owns.
   */
  readonly keep?: MemoryKeep;
  /**
   * The most keys to hold. The least recently used is dropped to make room. Omitted means
   * no limit.
   *
   * Only for a cache layer, where a dropped key is a miss the commit authority answers.
   * Refused on a commit authority, where it would be committed state thrown away.
   */
  readonly maxKeys?: number;
}

/**
 * The reference store: everything in a map, nothing on disk.
 *
 * `ephemeral` and honest about it. This exists to be the thing every other adapter is
 * measured against, and to make a memory-only runtime a documented mode rather than a
 * degraded one. It is also the fastest way to find out that an adapter's semantics are
 * wrong, because the contract tests run against this one first.
 *
 * Conditional append is trivially atomic here: JavaScript on one isolate cannot interleave
 * inside the check-and-write. That is also exactly why `multiWriter` is false. Two runtimes
 * sharing one of these do not share anything at all.
 *
 * In front of another store it is a cache, and a cache is asked for one thing: the state
 * of a key that is not resident. So there it keeps a snapshot per key and the few events
 * since, and can be told the most keys to hold.
 */
export class MemoryStore implements Store {
  readonly name: string;
  readonly capabilities: StoreCapabilities;
  readonly authority?: boolean;

  /**
   * What is kept for a key. Undecided until the stack says which role this store has.
   * An object, so it reads as something that changes.
   */
  readonly #kept: { keep: MemoryKeep | undefined };
  readonly #maxKeys: number | undefined;

  readonly #events = new Map<string, EkmanEvent[]>();
  /**
   * Each key's latest sequence, kept as it is written.
   *
   * Deriving it means scanning the key's events, and doing that on every append makes the
   * cost of a commit grow with the history behind it. Only a transition advances it.
   */
  readonly #seq = new Map<string, number>();
  readonly #snapshots = new Map<string, StoreSnapshot>();
  /** Keys from least to most recently used. Kept only when there is a limit on them. */
  readonly #recent = new Map<string, true>();

  constructor(options: MemoryStoreOptions = {}) {
    assertKnownKeys("the memory store's options", options, OPTION_KEYS);
    this.name = options.name ?? "memory";
    if (options.authority !== undefined) {
      this.authority = options.authority;
    }

    const { keep, maxKeys } = options;
    if (keep !== undefined && !KEEPS.includes(keep)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `${this.name}: keep ${JSON.stringify(keep)} is not recognized. Expected one of: ${KEEPS.join(", ")}.`
      );
    }
    if (maxKeys !== undefined && !(Number.isInteger(maxKeys) && maxKeys > 0)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `${this.name}: maxKeys must be a positive whole number of keys, received ${JSON.stringify(maxKeys)}. ` +
          "Omit it for no limit."
      );
    }
    this.#kept = { keep };
    this.#maxKeys = maxKeys;
    this.capabilities = Object.freeze({
      durability: "ephemeral" as const,
      conditionalAppend: true,
      multiWriter: false,
      scan: { byState: true, olderThan: true, staleFor: true },
      forget: true,
      compact: false,
      ...(maxKeys === undefined ? {} : { evicts: true }),
    });
  }

  /**
   * Tell a store which role the stack gave it. Does nothing to a store that is not one of
   * these, such as one wrapped in another.
   *
   * A cache that was not told what to keep keeps state. An authority keeps the stream,
   * and is refused if it was asked to keep less or to drop keys: both lose what it alone
   * holds. Events a store already holds when it becomes a cache are folded.
   */
  static placed(layer: Store, role: "authority" | "cache"): void {
    if (!(layer instanceof MemoryStore)) {
      return;
    }

    if (role === "cache") {
      layer.#kept.keep ??= "state";
      if (layer.#kept.keep === "state") {
        layer.#foldAll();
      }
      return;
    }

    const asked = [
      layer.#kept.keep === "state" ? 'keep: "state"' : undefined,
      layer.#maxKeys === undefined ? undefined : "maxKeys",
    ].filter((option) => option !== undefined);
    if (asked.length > 0) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `store layer "${layer.name}" is the commit authority and was given ${asked.join(" and ")}. ` +
          "An authority owns the history and every key, and those options discard them. " +
          "They are for a memory layer in front of another store."
      );
    }
    layer.#kept.keep = "stream";
  }

  append(key: string, event: EkmanEvent, expectedSeq: number): Promise<void> {
    const current = this.#seq.get(key) ?? EMPTY_SEQ;

    if (current !== expectedSeq) {
      // Refused before anything is touched, so a caller that sees this knows the store is
      // exactly as it was.
      return Promise.reject(conflict(this.name, key, expectedSeq, current));
    }

    this.#used(key);
    const events = this.#events.get(key);
    if (events === undefined) {
      this.#events.set(key, [event]);
    } else {
      events.push(event);
      if (events.length >= STATE_FOLD_EVERY && this.#kept.keep === "state") {
        this.#fold(key, events);
      }
    }
    if (event.type === "transition") {
      this.#seq.set(key, event.seq);
    }
    return Promise.resolve();
  }

  load(key: string): Promise<LoadResult | undefined> {
    const snapshot = this.#snapshots.get(key);
    const events = this.#events.get(key) ?? NO_EVENTS;
    if (events.length === 0 && snapshot === undefined) {
      return Promise.resolve(undefined);
    }
    this.#used(key);

    const after =
      snapshot === undefined
        ? events.slice()
        : events.filter((event) => isAfterSnapshot(event, snapshot.seq));

    return Promise.resolve({
      snapshot,
      events: after,
      seq: this.#seq.get(key) ?? EMPTY_SEQ,
    });
  }

  read(key: string): Promise<readonly EkmanEvent[]> {
    return Promise.resolve([...(this.#events.get(key) ?? [])]);
  }

  snapshot(key: string, snapshot: StoreSnapshot): Promise<void> {
    this.#used(key);
    const existing = this.#snapshots.get(key);
    // Idempotent per (key, seq), and never moves backwards: a late snapshot from a stale
    // reader must not undo a newer one.
    if (existing === undefined || existing.seq < snapshot.seq) {
      this.#snapshots.set(key, snapshot);
    }
    // A snapshot past the last event this store holds says the key is further on than its
    // stream shows, which is how a store that was handed a state and not a history is told
    // where the next append goes.
    if (snapshot.seq > (this.#seq.get(key) ?? EMPTY_SEQ)) {
      this.#seq.set(key, snapshot.seq);
    }
    return Promise.resolve();
  }

  scan(criteria: ScanCriteria): Promise<ScanResult> {
    return scanKeys(this.keys, criteria, (key) => this.load(key));
  }

  forget(key: string): Promise<void> {
    // Both halves, or a snapshot would outlive its stream and a later load would rebuild
    // state for a key that is supposed to be gone.
    this.#drop(key);
    return Promise.resolve();
  }

  #drop(key: string): void {
    this.#events.delete(key);
    this.#seq.delete(key);
    this.#snapshots.delete(key);
    this.#recent.delete(key);
  }

  /**
   * Note that a key was used, and drop the least recently used one if that is one too
   * many. Does nothing when there is no limit on keys.
   */
  #used(key: string): void {
    if (this.#maxKeys === undefined) {
      return;
    }

    this.#recent.delete(key);
    this.#recent.set(key, true);
    if (this.#recent.size > this.#maxKeys) {
      const [oldest] = this.#recent.keys();
      this.#drop(oldest as string);
    }
  }

  /**
   * Fold a key's events into its snapshot and let them go.
   *
   * Written past the rule `snapshot()` holds to, that one at a sequence already held is
   * ignored: a refusal or a violation does not advance the sequence, and what it says
   * about the key's bounds has to land all the same.
   *
   * Events that replay to no state, refusals for a key that was never created, are let go
   * with nothing kept, and the key stops counting toward the limit on keys.
   */
  #fold(key: string, events: readonly EkmanEvent[]): void {
    const current = replay({
      snapshot: this.#snapshots.get(key),
      events,
      seq: EMPTY_SEQ,
    });
    this.#events.delete(key);
    if (current === undefined) {
      this.#recent.delete(key);
      return;
    }

    const { at } = events.at(-1) as EkmanEvent;
    this.#snapshots.set(key, snapshotOf(key, current, at));
  }

  #foldAll(): void {
    for (const [key, events] of [...this.#events]) {
      this.#fold(key, events);
    }
  }

  /** Keys this store holds anything for, whether a stream, a snapshot or both. */
  get keys(): readonly string[] {
    return [...new Set([...this.#events.keys(), ...this.#snapshots.keys()])];
  }
}

const OPTION_KEYS = ["name", "authority", "keep", "maxKeys"] as const;
const KEEPS: readonly MemoryKeep[] = ["stream", "state"];
const NO_EVENTS: readonly EkmanEvent[] = Object.freeze([]);

export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(options);
}

export function conflict(
  store: string,
  key: string,
  expectedSeq: number,
  actualSeq: number
): EkmanError {
  const found =
    actualSeq === EMPTY_SEQ ? "has no events" : `is at ${actualSeq}`;
  return new EkmanError(
    "STORE_CONFLICT",
    `${store}: append for ${key} expected sequence ${expectedSeq}, but the key ${found}. ` +
      "Nothing was written. Reload the instance before retrying.",
    { key }
  );
}
