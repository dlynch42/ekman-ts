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
import { EMPTY_SEQ, isAfterSnapshot, scanKeys } from "../store";

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
 */
export class MemoryStore implements Store {
  readonly name: string;
  readonly capabilities: StoreCapabilities = Object.freeze({
    durability: "ephemeral" as const,
    conditionalAppend: true,
    multiWriter: false,
    scan: { byState: true, olderThan: true },
    forget: true,
    compact: false,
  });
  readonly authority?: boolean;

  readonly #events = new Map<string, EkmanEvent[]>();
  /**
   * Each key's latest sequence, kept as it is written.
   *
   * Deriving it means scanning the key's events, and doing that on every append makes the
   * cost of a commit grow with the history behind it. Only a transition advances it.
   */
  readonly #seq = new Map<string, number>();
  readonly #snapshots = new Map<string, StoreSnapshot>();

  constructor(options: { name?: string; authority?: boolean } = {}) {
    assertKnownKeys("the memory store's options", options, OPTION_KEYS);
    this.name = options.name ?? "memory";
    if (options.authority !== undefined) {
      this.authority = options.authority;
    }
  }

  append(key: string, event: EkmanEvent, expectedSeq: number): Promise<void> {
    const current = this.#seq.get(key) ?? EMPTY_SEQ;

    if (current !== expectedSeq) {
      // Refused before anything is touched, so a caller that sees this knows the store is
      // exactly as it was.
      return Promise.reject(conflict(this.name, key, expectedSeq, current));
    }

    const events = this.#events.get(key);
    if (events === undefined) {
      this.#events.set(key, [event]);
    } else {
      events.push(event);
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
    this.#events.delete(key);
    this.#seq.delete(key);
    this.#snapshots.delete(key);
    return Promise.resolve();
  }

  /** Keys this store holds anything for, whether a stream, a snapshot or both. */
  get keys(): readonly string[] {
    return [...new Set([...this.#events.keys(), ...this.#snapshots.keys()])];
  }
}

const OPTION_KEYS = ["name", "authority"] as const;
const NO_EVENTS: readonly EkmanEvent[] = Object.freeze([]);

export function memoryStore(
  options: { name?: string; authority?: boolean } = {}
): MemoryStore {
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
