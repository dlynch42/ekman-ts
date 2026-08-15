import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EkmanEvent } from "../events";
import type {
  LoadResult,
  ScanCriteria,
  ScanResult,
  Store,
  StoreCapabilities,
  StoreSnapshot,
} from "../store";
import { latestSeq, scanKeys } from "../store";
import { conflict } from "./memory";

/**
 * A durable store: one JSONL append log per key, plus a snapshot file beside it.
 *
 * JSONL because an append log wants appends, and because a file you can read with `tail`
 * during an incident is worth more than a compact binary format. One file per key rather
 * than one shared log, so a key's stream is contiguous and `load` never scans other keys.
 *
 * Writes are synchronous. That is not laziness: `appendFileSync` is what makes the
 * conditional append actually atomic against a concurrent caller in this process, because
 * nothing can interleave between the check and the write. An async write would need a
 * per-key queue to get the same guarantee, and would still not extend it across processes.
 *
 * Which is why `multiWriter` is false. Two processes pointed at one directory will both
 * believe their conditional appends held. The runtime refuses configurations that need
 * more than this store declares, so the honest declaration is the safety mechanism.
 */
export class FileStore implements Store {
  readonly name: string;
  readonly capabilities: StoreCapabilities = Object.freeze({
    durability: "durable" as const,
    conditionalAppend: true,
    multiWriter: false,
    scan: { byState: true, olderThan: true },
  });
  readonly authority?: boolean;

  readonly #dir: string;
  /** Latest committed sequence per key, so the common append does not re-read the log. */
  readonly #seq = new Map<string, number>();

  constructor(
    dir: string,
    options: { name?: string; authority?: boolean } = {}
  ) {
    this.#dir = dir;
    this.name = options.name ?? "file";
    if (options.authority !== undefined) {
      this.authority = options.authority;
    }
    mkdirSync(dir, { recursive: true });
  }

  append(key: string, event: EkmanEvent, expectedSeq: number): Promise<void> {
    const current = this.#currentSeq(key);

    if (current !== expectedSeq) {
      return Promise.reject(conflict(this.name, key, expectedSeq, current));
    }

    appendFileSync(this.#logPath(key), `${JSON.stringify(event)}\n`, "utf8");

    if (event.type === "transition") {
      this.#seq.set(key, event.seq);
    }
    return Promise.resolve();
  }

  load(key: string): Promise<LoadResult | undefined> {
    const events = this.#readLog(key);
    const snapshot = this.#readSnapshot(key);

    if (events.length === 0 && snapshot === undefined) {
      return Promise.resolve(undefined);
    }

    const after =
      snapshot === undefined
        ? events
        : events.filter((event) => event.seq > snapshot.seq);

    return Promise.resolve({
      snapshot,
      events: after,
      seq: this.#currentSeq(key),
    });
  }

  read(key: string): Promise<readonly EkmanEvent[]> {
    return Promise.resolve(this.#readLog(key));
  }

  snapshot(key: string, snapshot: StoreSnapshot): Promise<void> {
    const existing = this.#readSnapshot(key);
    if (existing !== undefined && existing.seq >= snapshot.seq) {
      return Promise.resolve();
    }

    // Written to a temporary name and renamed, because a half-written snapshot that
    // replaced a whole one would be worse than having no snapshot at all. Rename is atomic
    // within a filesystem.
    const path = this.#snapshotPath(key);
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), "utf8");
    renameSync(temp, path);
    return Promise.resolve();
  }

  scan(criteria: ScanCriteria): Promise<ScanResult> {
    return scanKeys(this.keys, criteria, (key) => this.load(key));
  }

  /**
   * Every key this store holds a log for, recovered from the directory itself.
   *
   * Sorted, so a scan walks keys in the same order on every run and a limit truncates the
   * same way twice. Directory order is not something to build a contract on.
   */
  get keys(): readonly string[] {
    return readdirSync(this.#dir)
      .filter((name) => name.endsWith(LOG_SUFFIX))
      .map((name) => decodeURIComponent(name.slice(0, -LOG_SUFFIX.length)))
      .sort();
  }

  #currentSeq(key: string): number {
    const cached = this.#seq.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const seq = latestSeq(this.#readLog(key));
    this.#seq.set(key, seq);
    return seq;
  }

  #readLog(key: string): EkmanEvent[] {
    const path = this.#logPath(key);
    if (!existsSync(path)) {
      return [];
    }

    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EkmanEvent);
  }

  #readSnapshot(key: string): StoreSnapshot | undefined {
    const path = this.#snapshotPath(key);
    if (!existsSync(path)) {
      return;
    }
    return JSON.parse(readFileSync(path, "utf8")) as StoreSnapshot;
  }

  /**
   * Keys contain `:`, which is not a filename on every platform, so the name is
   * percent-encoded. The key itself stays human-readable inside the file: the encoding is
   * a storage-layout detail and must never become the identity anyone reads.
   */
  #logPath(key: string): string {
    return join(this.#dir, `${encodeURIComponent(key)}${LOG_SUFFIX}`);
  }

  #snapshotPath(key: string): string {
    return join(this.#dir, `${encodeURIComponent(key)}${SNAPSHOT_SUFFIX}`);
  }
}

const LOG_SUFFIX = ".jsonl";
const SNAPSHOT_SUFFIX = ".snapshot.json";

export function fileStore(
  dir: string,
  options: { name?: string; authority?: boolean } = {}
): FileStore {
  return new FileStore(dir, options);
}
