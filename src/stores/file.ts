import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EkmanEvent } from "../events";
import type {
  LoadResult,
  ScanCriteria,
  ScanResult,
  Store,
  StoreCapabilities,
  StoreSnapshot,
} from "../store";
import { entityOf, latestSeq, scanKeys } from "../store";
import { conflict } from "./memory";

/** The directory a durable store defaults into, under the calling project's root. */
export const STORE_DIR_NAME = ".ekman";

/**
 * The nearest directory at or above `from` that holds a `package.json`.
 *
 * The nearest one rather than the outermost, so a package inside a workspace keeps its own
 * state instead of pooling it with its siblings. Walked upward rather than taken from the
 * working directory as-is, because otherwise `node dist/server.js` and
 * `cd src && node ../dist/server.js` would resolve to two different places, and a service
 * whose state appears to vanish because of where it was launched from looks exactly like a
 * service that lost it.
 *
 * Resolved from the caller's working directory and never from this file's own location.
 * This module lives in somebody's `node_modules`, and an install directory is not anywhere
 * a caller's data belongs.
 *
 * Falls back to where it started when nothing above has a `package.json`, which is the case
 * for a bundled single-file build. That reintroduces the launch-directory dependency, so a
 * deployment in that shape should name its directory explicitly.
 */
export function projectRoot(from: string = process.cwd()): string {
  const start = resolve(from);
  let dir = start;

  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }

  return dir;
}

/**
 * The runtime's directory under the calling project's root.
 *
 * A namespace rather than a single store's folder. The first level inside it names what
 * kind of thing is being kept, so `logs/` can sit beside whatever later features need to
 * put somewhere without either having to know about the other.
 */
export function defaultStoreDir(from: string = process.cwd()): string {
  return join(projectRoot(from), STORE_DIR_NAME);
}

/** Where a durable store puts its logs when nobody said where. */
export function defaultLogDir(from: string = process.cwd()): string {
  return join(defaultStoreDir(from), LOGS_DIR_NAME);
}

export interface FileStoreOptions {
  /** Names the layer. Appears in telemetry and in the runtime's refusal messages. */
  readonly name?: string;
  /** Claim the commit authority, rather than letting the stack pick. */
  readonly authority?: boolean;
}

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
 *
 * Logs are sharded into a directory per entity, because every scan is scoped to one entity,
 * so a flat directory would mean listing every other entity's files to answer about one.
 * Given no directory, the store takes `.ekman/logs` under the calling project's root.
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

  /**
   * Where the logs are, resolved.
   *
   * Public because "where did this write" is a question asked during an incident, and with
   * a default the caller may hold no variable that answers it. The layout *inside* stays
   * private: the encoded filename must never become the identity anyone reads.
   */
  readonly dir: string;

  /** Latest committed sequence per key, so the common append does not re-read the log. */
  readonly #seq = new Map<string, number>();

  constructor(options?: FileStoreOptions);
  constructor(dir: string, options?: FileStoreOptions);
  constructor(
    dirOrOptions?: string | FileStoreOptions,
    maybeOptions?: FileStoreOptions
  ) {
    const named = typeof dirOrOptions === "string";
    const options = (named ? maybeOptions : dirOrOptions) ?? {};

    // No directory given means the caller does not care where, not that they do not care
    // whether. Durability was opted into by choosing this store at all; the path is the
    // layout detail that follows from that choice.
    this.dir = named ? dirOrOptions : defaultLogDir();

    this.name = options.name ?? "file";
    if (options.authority !== undefined) {
      this.authority = options.authority;
    }

    // Eagerly, not at first append: a root that cannot be created is a configuration that
    // cannot work, and startup is the only useful moment to find that out.
    mkdirSync(this.dir, { recursive: true });
  }

  append(key: string, event: EkmanEvent, expectedSeq: number): Promise<void> {
    const current = this.#currentSeq(key);

    if (current !== expectedSeq) {
      return Promise.reject(conflict(this.name, key, expectedSeq, current));
    }

    mkdirSync(this.#entityDir(key), { recursive: true });
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
    mkdirSync(this.#entityDir(key), { recursive: true });
    const path = this.#snapshotPath(key);
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), "utf8");
    renameSync(temp, path);
    return Promise.resolve();
  }

  scan(criteria: ScanCriteria): Promise<ScanResult> {
    // Scoped to the one entity asked about, which is the whole reason logs are sharded by
    // entity: the alternative is listing every other entity's files to answer about one.
    return scanKeys(this.#keysOf(criteria.entity), criteria, (key) =>
      this.load(key)
    );
  }

  /**
   * Every key this store holds a log for, recovered from the directory itself.
   *
   * Sorted, so a scan walks keys in the same order on every run and a limit truncates the
   * same way twice. Directory order is not something to build a contract on.
   */
  get keys(): readonly string[] {
    return this.#keysOf();
  }

  /** The keys under one entity, or under all of them when no entity is named. */
  #keysOf(entity?: string): readonly string[] {
    const entities =
      entity === undefined
        ? // Only directories. Anything else here belongs to whoever put it there: an
          // application is free to keep its own files alongside, and a stray one must not
          // be mistaken for an entity or stop the walk.
          readdirSync(this.dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [encodeURIComponent(entity)];

    const keys: string[] = [];
    for (const encoded of entities) {
      const dir = join(this.dir, encoded);
      if (!existsSync(dir)) {
        // An entity nothing has been written for yet, which is the normal early state.
        continue;
      }
      for (const name of readdirSync(dir)) {
        if (name.endsWith(LOG_SUFFIX)) {
          keys.push(decodeURIComponent(name.slice(0, -LOG_SUFFIX.length)));
        }
      }
    }

    return keys.sort();
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

  /**
   * The log, up to the last line that was written whole.
   *
   * Read as bytes and cut at the final newline, because an append that did not finish
   * leaves a partial line behind: a full disk makes `appendFileSync` write a short count,
   * and so does losing the process between the write and the flush. That fragment is not
   * parseable, and parsing it would throw on every later load, so a torn tail would cost
   * the key everything rather than the one event that never landed.
   *
   * A malformed line that *is* newline-terminated still throws. It was written whole, so
   * whatever damaged it damaged the file, and reporting a corrupted log as a short healthy
   * one is the worse of the two failures.
   */
  #readLog(key: string): EkmanEvent[] {
    const path = this.#logPath(key);
    if (!existsSync(path)) {
      return [];
    }

    // Byte offsets, not string indices: a multibyte character before the cut would put a
    // string index in the wrong place.
    const bytes = readFileSync(path);
    const lastNewline = bytes.lastIndexOf(NEWLINE);

    // Repaired now, not on the next append: appending would concatenate onto the fragment
    // and leave a corrupt line that is no longer last, indistinguishable from real damage.
    if (lastNewline !== bytes.length - 1) {
      truncateSync(path, lastNewline + 1);
    }

    return bytes
      .toString("utf8", 0, lastNewline + 1)
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
   * The directory holding one entity's logs.
   *
   * Created on write rather than up front, because an entity's directory cannot be known
   * to be needed until a key belonging to it arrives.
   */
  #entityDir(key: string): string {
    return join(this.dir, encodeURIComponent(entityOf(key)));
  }

  /**
   * Keys contain `:`, which is not a filename on every platform, so the name is
   * percent-encoded. The key itself stays human-readable inside the file: the encoding is
   * a storage-layout detail and must never become the identity anyone reads.
   */
  #logPath(key: string): string {
    return join(
      this.#entityDir(key),
      `${encodeURIComponent(key)}${LOG_SUFFIX}`
    );
  }

  #snapshotPath(key: string): string {
    return join(
      this.#entityDir(key),
      `${encodeURIComponent(key)}${SNAPSHOT_SUFFIX}`
    );
  }
}

const LOGS_DIR_NAME = "logs";
const LOG_SUFFIX = ".jsonl";
const SNAPSHOT_SUFFIX = ".snapshot.json";
/** The record separator, as a byte, because torn tails are found by byte offset. */
const NEWLINE = 0x0a;

export function fileStore(options?: FileStoreOptions): FileStore;
export function fileStore(dir: string, options?: FileStoreOptions): FileStore;
export function fileStore(
  dirOrOptions?: string | FileStoreOptions,
  maybeOptions?: FileStoreOptions
): FileStore {
  // Forwarded rather than normalized here, so the constructor stays the one place that
  // decides what a first argument means and the two entry points cannot drift apart.
  return typeof dirOrOptions === "string"
    ? new FileStore(dirOrOptions, maybeOptions)
    : new FileStore(dirOrOptions);
}
