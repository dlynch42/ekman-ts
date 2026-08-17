import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EkmanError } from "../errors";
import type { EkmanEvent } from "../events";
import type {
  LoadResult,
  ScanCriteria,
  ScanResult,
  Store,
  StoreCapabilities,
  StoreSnapshot,
  StoreUsage,
} from "../store";
import { EMPTY_SEQ, entityOf, latestSeq, replay, scanKeys } from "../store";
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

/**
 * What happens when a store reaches its total budget.
 *
 * - `none`: account and report, never act. The budget becomes a measurement rather than a
 *   limit, which is how a team finds out what its real footprint is before enforcing one.
 *   The same argument `warn` makes for constraints, and eviction's `none` for memory.
 * - `reject`: refuse to create new instances. Instances that already exist keep committing,
 *   because shedding new work is recoverable and breaking work in flight is not.
 * - `compact`: compact the largest logs until back under budget. Costs history, not state.
 * - `forget`: delete the oldest terminal instances. Discards committed state, so it has to
 *   be asked for explicitly.
 */
export type RetentionPolicy = "none" | "reject" | "compact" | "forget";

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  "none",
  "reject",
  "compact",
  "forget",
];

export interface RetentionConfig {
  /**
   * Compact a single log once it grows past this many bytes.
   *
   * Compaction writes a snapshot and drops the events it folded in, so the cost is history
   * rather than state: replay and current values are untouched, and `history()` reports
   * itself incomplete. `0` disables it and keeps every event forever.
   */
  readonly perLogBytes?: number;
  /**
   * Budget across every log this store owns. Omitted means unlimited.
   *
   * Accounted either way, so `usage` always answers. What happens on reaching it is
   * `policy`, which does nothing unless you say otherwise.
   */
  readonly totalBytes?: number;
  /** Defaults to `none`. */
  readonly policy?: RetentionPolicy;
  /**
   * Permit retention to delete committed state.
   *
   * Off by default and required to be explicit, for the same reason
   * `eviction.allowDiscard` is: throwing away what a caller was told had committed is the
   * one thing retention must never do by accident.
   */
  readonly allowDiscard?: boolean;
}

export interface FileStoreOptions {
  /** Names the layer. Appears in telemetry and in the runtime's refusal messages. */
  readonly name?: string;
  /** Claim the commit authority, rather than letting the stack pick. */
  readonly authority?: boolean;
  readonly retention?: RetentionConfig;
}

/** 5MB, roughly fifteen to twenty thousand events at a typical line length. */
const DEFAULT_PER_LOG_BYTES = 5 * 1024 * 1024;

interface ResolvedRetention {
  readonly perLogBytes: number;
  readonly totalBytes: number;
  readonly policy: RetentionPolicy;
  readonly bounded: boolean;
}

/**
 * Settle the retention config, refusing what cannot be satisfied rather than adjusting it.
 */
function resolveRetention(
  config: RetentionConfig | undefined
): ResolvedRetention {
  const perLogBytes = config?.perLogBytes ?? DEFAULT_PER_LOG_BYTES;
  const totalBytes = config?.totalBytes ?? Number.POSITIVE_INFINITY;
  const policy = config?.policy ?? "none";

  if (!(Number.isInteger(perLogBytes) && perLogBytes >= 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `retention perLogBytes must be a non-negative integer number of bytes, received ${JSON.stringify(config?.perLogBytes)}. ` +
        "Use 0 to keep every event and never compact."
    );
  }

  const bounded = totalBytes !== Number.POSITIVE_INFINITY;
  if (bounded && !(Number.isInteger(totalBytes) && totalBytes >= 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `retention totalBytes must be a non-negative integer number of bytes, received ${JSON.stringify(config?.totalBytes)}. ` +
        "Omit it for an unlimited budget that is still measured."
    );
  }

  if (!RETENTION_POLICIES.includes(policy)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `retention policy ${JSON.stringify(policy)} is not recognized. ` +
        `Expected one of: ${RETENTION_POLICIES.join(", ")}.`
    );
  }

  // A policy that only ever fires at a ceiling is meaningless without one. Refused rather
  // than silently never running, which would look configured and do nothing.
  if (policy !== "none" && !bounded) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `retention policy ${JSON.stringify(policy)} needs a totalBytes to act on, and none is set. ` +
        'Set retention.totalBytes, or leave the policy at "none" to measure without enforcing.'
    );
  }

  if (policy === "forget" && config?.allowDiscard !== true) {
    throw new EkmanError(
      "INVALID_CONFIG",
      'retention policy "forget" deletes committed state once the budget is reached. ' +
        'Set retention.allowDiscard to accept that, or use policy "reject" to refuse new ' +
        "instances instead."
    );
  }

  return { perLogBytes, totalBytes, policy, bounded };
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
    forget: true,
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

  readonly #retention: ResolvedRetention;

  /**
   * Bytes per log, and their total.
   *
   * Seeded lazily rather than at construction, because summing the tree costs a walk of
   * every file and a store nobody asks about should not pay for it. Once seeded it is
   * maintained from the byte lengths `append` already computes, so the common path is
   * arithmetic rather than a stat.
   */
  #bytes: Map<string, number> | undefined;
  #total = 0;

  constructor(options?: FileStoreOptions);
  constructor(dir: string, options?: FileStoreOptions);
  constructor(
    dirOrOptions?: string | FileStoreOptions,
    maybeOptions?: FileStoreOptions
  ) {
    const named = typeof dirOrOptions === "string";
    const options = (named ? maybeOptions : dirOrOptions) ?? {};
    this.#retention = resolveRetention(options.retention);

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

    const line = `${JSON.stringify(event)}\n`;
    const width = Buffer.byteLength(line, "utf8");

    // Refused before the write, and only for a key this store has never seen. An instance
    // that already exists keeps committing: shedding new work is recoverable, and stopping
    // work already in flight is not.
    const refusal = this.#refuseIfFull(key, width);
    if (refusal !== undefined) {
      return Promise.reject(refusal);
    }

    mkdirSync(this.#entityDir(key), { recursive: true });
    appendFileSync(this.#logPath(key), line, "utf8");
    this.#account(key, width);

    if (event.type === "transition") {
      this.#seq.set(key, event.seq);
    }

    // After the write rather than before it, so the size that triggers compaction is the
    // size the log actually reached.
    this.#compactIfOversized(key);
    return Promise.resolve();
  }

  /** What this store is holding, and what it is allowed to hold. */
  get usage(): StoreUsage {
    const bytes = this.#seeded();
    return Object.freeze({
      bytes: this.#total,
      logs: bytes.size,
      maxBytes: this.#retention.bounded ? this.#retention.totalBytes : null,
    });
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

  forget(key: string): Promise<void> {
    // `force` so forgetting a key this store never held is not an error. A sweep that dies
    // halfway and is retried should behave the same the second time.
    rmSync(this.#logPath(key), { force: true });
    rmSync(this.#snapshotPath(key), { force: true });

    // The cached sequence has to go too, or a key created again under the same name would
    // be appended at the old number and refused as a conflict.
    this.#seq.delete(key);

    // Zero when nothing is counting yet, which makes this a no-op rather than a special
    // case: an unseeded store has a total of zero to take it off.
    this.#total -= this.#bytes?.get(key) ?? 0;
    this.#bytes?.delete(key);
    return Promise.resolve();
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

  /**
   * The per-log byte table, summed from disk the first time anything needs it.
   *
   * One walk, once, and only when a budget is configured or somebody reads `usage`. A
   * store that is asked neither question never pays for it.
   */
  #seeded(): Map<string, number> {
    if (this.#bytes !== undefined) {
      return this.#bytes;
    }

    const bytes = new Map<string, number>();
    let total = 0;
    for (const key of this.#keysOf()) {
      const { size } = statSync(this.#logPath(key));
      bytes.set(key, size);
      total += size;
    }

    this.#bytes = bytes;
    this.#total = total;
    return bytes;
  }

  /**
   * Fold an oversized log into a snapshot and drop what the snapshot now covers.
   *
   * The two halves this needs already exist: `snapshot` writes atomically through a
   * temporary name, and `load` already ignores events at or below the snapshot's sequence.
   * So compaction is those two put together, and the read path needs to know nothing about
   * it.
   *
   * What it costs is history, not state. Current values, replay and the sequence are
   * untouched; the events folded away were already reflected in the snapshot. `history`
   * reports itself incomplete afterwards, which is the honest half of the trade and the
   * reason `HistoryResult.complete` exists.
   */
  #compactIfOversized(key: string): void {
    const limit = this.#retention.perLogBytes;
    if (limit === 0) {
      return;
    }

    const size = this.#bytes?.get(key) ?? statSync(this.#logPath(key)).size;
    if (size <= limit) {
      return;
    }

    // Folded onto any earlier snapshot, because a log compacted before holds only the
    // events after it and replaying those alone would lose everything before.
    const events = this.#readLog(key);
    const current = replay({
      snapshot: this.#readSnapshot(key),
      events,
      seq: latestSeq(events),
    });
    if (current === undefined) {
      // Nothing but refusals and violations so far. There is no state to snapshot, so
      // there is nothing that could be dropped without losing the only record of it.
      return;
    }

    writeFileSync(
      this.#snapshotPath(key),
      JSON.stringify({
        key,
        entity: entityOf(key),
        state: current.state,
        values: current.values,
        seq: current.seq,
        at: Date.now(),
        enteredAt: current.enteredAt,
      } satisfies StoreSnapshot),
      "utf8"
    );

    // Everything the snapshot does not account for. A rejection or a violation carries the
    // sequence it followed rather than a new one, so events at the snapshot's own sequence
    // that are not the transition itself have to survive.
    const kept = events.filter(
      (event) => event.seq > current.seq || event.type !== "transition"
    );
    const rewritten = kept
      .map((event) => `${JSON.stringify(event)}\n`)
      .join("");

    writeFileSync(this.#logPath(key), rewritten, "utf8");
    this.#resize(key, size, Buffer.byteLength(rewritten, "utf8"));
  }

  /** Note that a log went from one size to another, keeping the total in step. */
  #resize(key: string, before: number, after: number): void {
    if (this.#bytes === undefined) {
      return;
    }
    this.#total += after - before;
    this.#bytes.set(key, after);
  }

  /** Record bytes just written, if anything is counting. */
  #account(key: string, delta: number): void {
    if (this.#bytes === undefined) {
      // Nobody is counting yet, and the eventual seed will read the real sizes off disk,
      // so skipping the bookkeeping cannot make it wrong.
      if (!this.#retention.bounded) {
        return;
      }

      // A budget is set, so this is the moment to start counting. Seeding stats the file
      // that was just written to, which means the seed already includes `delta`. Adding it
      // again here would count this one write twice.
      this.#seeded();
      return;
    }

    this.#bytes.set(key, (this.#bytes.get(key) ?? 0) + delta);
    this.#total += delta;
  }

  /**
   * The refusal a full store owes a key it has never seen, or undefined.
   *
   * Only `reject` acts here. `compact` and `forget` run as sweeps rather than on the commit
   * path, because both have to look across keys to choose what to act on, and a scan is the
   * wrong thing to do while somebody waits on an append.
   */
  #refuseIfFull(key: string, width: number): EkmanError | undefined {
    if (this.#retention.policy !== "reject") {
      return;
    }

    const bytes = this.#seeded();
    if (bytes.has(key) || this.#total + width <= this.#retention.totalBytes) {
      return;
    }

    return new EkmanError(
      "STORE_FULL",
      `the ${this.name} store holds ${this.#total} bytes across ${bytes.size} logs, which is its ` +
        `configured retention totalBytes of ${this.#retention.totalBytes}, so ${JSON.stringify(key)} ` +
        "was not created. Instances that already exist continue to commit."
    );
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

  /**
   * The key's latest committed sequence.
   *
   * Taken from the snapshot as well as the log, not the log alone. Compaction can fold
   * every transition into the snapshot and leave a log with none, and reading only the log
   * would then report the key as having no events at all. The sequence would restart, and
   * the next append would be a conditional append against the wrong number.
   */
  #currentSeq(key: string): number {
    const cached = this.#seq.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const snapshot = this.#readSnapshot(key);
    const seq = Math.max(
      latestSeq(this.#readLog(key)),
      snapshot === undefined ? EMPTY_SEQ : snapshot.seq
    );
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
