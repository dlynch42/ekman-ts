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
import { EMPTY_SEQ, latestSeq, scanKeys } from "../store";

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
  });
  readonly authority?: boolean;

  readonly #events = new Map<string, EkmanEvent[]>();
  readonly #snapshots = new Map<string, StoreSnapshot>();

  constructor(options: { name?: string; authority?: boolean } = {}) {
    this.name = options.name ?? "memory";
    if (options.authority !== undefined) {
      this.authority = options.authority;
    }
  }

  append(key: string, event: EkmanEvent, expectedSeq: number): Promise<void> {
    const events = this.#events.get(key) ?? [];
    const current = latestSeq(events);

    if (current !== expectedSeq) {
      // Refused before anything is touched, so a caller that sees this knows the store is
      // exactly as it was.
      return Promise.reject(conflict(this.name, key, expectedSeq, current));
    }

    events.push(event);
    this.#events.set(key, events);
    return Promise.resolve();
  }

  load(key: string): Promise<LoadResult | undefined> {
    const events = this.#events.get(key);
    if (events === undefined) {
      return Promise.resolve(undefined);
    }

    const snapshot = this.#snapshots.get(key);
    // Everything after the snapshot. A snapshot at seq N means every commit up to N is
    // already folded into it, so replaying them again would be work with no effect.
    const after =
      snapshot === undefined
        ? events
        : events.filter((event) => event.seq > snapshot.seq);

    return Promise.resolve({
      snapshot,
      events: [...after],
      seq: latestSeq(events),
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
    return Promise.resolve();
  }

  scan(criteria: ScanCriteria): Promise<ScanResult> {
    return scanKeys(this.keys, criteria, (key) => this.load(key));
  }

  forget(key: string): Promise<void> {
    // Both halves, or a snapshot would outlive its stream and a later load would rebuild
    // state for a key that is supposed to be gone.
    this.#events.delete(key);
    this.#snapshots.delete(key);
    return Promise.resolve();
  }

  /** Keys this store holds anything for. */
  get keys(): readonly string[] {
    return [...this.#events.keys()];
  }
}

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
