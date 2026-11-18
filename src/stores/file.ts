import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertKnownKeys } from "../config";
import { EkmanError, isEkmanError } from "../errors";
import type { EkmanEvent } from "../events";
import { isWellFormed, KEY_SEPARATOR } from "../key";
import type {
  LoadResult,
  ScanCriteria,
  ScanResult,
  Store,
  StoreCapabilities,
  StoreCompaction,
  StoreSnapshot,
  StoreUsage,
} from "../store";
import {
  EMPTY_SEQ,
  entityOf,
  isAfterSnapshot,
  latestSeq,
  replay,
  scanKeys,
} from "../store";
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
 * - `compact`: fold the largest logs into snapshots until back under budget. Costs history,
 *   not state, and runs on the runtime's schedule rather than on the commit path.
 *
 * There is deliberately no policy that deletes instances to make room. A store sees bytes
 * and keys; which instances no longer matter is a domain question, and answering it from
 * the wrong layer would mean deleting live state to answer a disk-space question. Deleting
 * is a query for what is finished plus `forget` on each result, and it stays in the
 * application where the knowledge is.
 */
export type RetentionPolicy = "none" | "reject" | "compact";

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  "none",
  "reject",
  "compact",
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
}

/**
 * Permission bits for what the store creates.
 *
 * Owner-only unless told otherwise, because a log holds every value an instance ever
 * committed. Applied when a file or directory is created, so anything already on disk
 * keeps the bits it has until compaction or a snapshot replaces it.
 */
export interface FileModeConfig {
  /** Logs and snapshots. Defaults to `0o600`. */
  readonly file?: number;
  /** The store's directory and the one under it per entity. Defaults to `0o700`. */
  readonly dir?: number;
}

export interface FileStoreOptions {
  /** Names the layer. Appears in telemetry and in the runtime's refusal messages. */
  readonly name?: string;
  /** Claim the commit authority, rather than letting the stack pick. */
  readonly authority?: boolean;
  readonly retention?: RetentionConfig;
  readonly mode?: FileModeConfig;
  /**
   * How many logs are held open for appending at once. Defaults to 256.
   *
   * A log that is open takes one write per commit, where opening and closing it each time
   * costs more than the write does. Past this many, the log least recently written to is
   * closed, and opened again the next time it is needed. Lower it for a process with a
   * tight descriptor limit.
   */
  readonly maxOpenLogs?: number;
}

const OPTION_KEYS = [
  "name",
  "authority",
  "retention",
  "mode",
  "maxOpenLogs",
] as const;
const DEFAULT_MAX_OPEN_LOGS = 256;
/** How far past its limit a log may get while its compaction waits for a turn. */
const OVERDUE_FACTOR = 2;
const RETENTION_KEYS = ["perLogBytes", "totalBytes", "policy"] as const;
const MODE_KEYS = ["file", "dir"] as const;

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
  assertKnownKeys("file store retention", config, RETENTION_KEYS);
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

  return { perLogBytes, totalBytes, policy, bounded };
}

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIR_MODE = 0o700;
const ALL_PERMISSION_BITS = 0o777;

interface ResolvedMode {
  readonly file: number;
  readonly dir: number;
}

function resolveMode(config: FileModeConfig | undefined): ResolvedMode {
  assertKnownKeys("file store mode", config, MODE_KEYS);
  const resolved = {
    file: config?.file ?? DEFAULT_FILE_MODE,
    dir: config?.dir ?? DEFAULT_DIR_MODE,
  };

  for (const [which, bits] of Object.entries(resolved)) {
    if (!(Number.isInteger(bits) && bits >= 0 && bits <= ALL_PERMISSION_BITS)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `file store mode.${which} must be permission bits between 0 and 0o777, received ${JSON.stringify(bits)}.`
      );
    }
  }

  return resolved;
}

function resolveMaxOpenLogs(configured: number | undefined): number {
  const limit = configured ?? DEFAULT_MAX_OPEN_LOGS;
  if (!(Number.isInteger(limit) && limit > 0)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `file store maxOpenLogs must be a positive integer, received ${JSON.stringify(configured)}.`
    );
  }
  return limit;
}

const PERCENT = 0x25;
const BYTE_VALUES = 256;
const HEX_RADIX = 16;
const HEX_WIDTH = 2;

/** One entry per byte value: the byte itself where it is plain, its escape elsewhere. */
function nameTable(plain: string): readonly string[] {
  return Array.from({ length: BYTE_VALUES }, (_, byte) => {
    const character = String.fromCharCode(byte);
    return plain.includes(character)
      ? character
      : `%${byte.toString(HEX_RADIX).toUpperCase().padStart(HEX_WIDTH, "0")}`;
  });
}

const LOWER_AND_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";
const CURRENT_NAMES = nameTable(`${LOWER_AND_DIGITS}-_`);
const EARLIER_NAMES = nameTable(
  `${LOWER_AND_DIGITS}${LOWER_AND_DIGITS.toUpperCase()}-_.!~*'()`
);

function encodeWith(text: string, table: readonly string[]): string {
  let name = "";
  for (const byte of Buffer.from(text, "utf8")) {
    name += table[byte];
  }
  return name;
}

/**
 * The name a key or an entity is stored under.
 *
 * Every byte of its UTF-8 form is percent-escaped unless it is a lowercase ASCII letter, a
 * digit, `-` or `_`. Uppercase letters are escaped too, and that is the point: keys are
 * case-sensitive and many filesystems are not, so `orders:ABC` and `orders:abc` have to
 * differ in more than case to be two files. Here they differ in a digit, `%41` against
 * `a`, and the escapes themselves are always written in uppercase hex, so no two keys
 * fold to one name.
 *
 * Nothing it produces contains a `.` or a separator, so a name is never a path.
 */
function encodeName(text: string): string {
  return encodeWith(text, CURRENT_NAMES);
}

/**
 * The name the same text had before uppercase letters were escaped.
 *
 * Only ever used to recognize what an earlier version left on disk.
 */
function earlierName(text: string): string {
  return encodeWith(text, EARLIER_NAMES);
}

/**
 * The key or entity a stored name stands for, or undefined when the store did not write
 * it.
 *
 * Both naming schemes are percent escapes, so one decoder reads either. A name counts as
 * the store's own only if encoding the result gives the name back under one scheme or the
 * other, which is what keeps a stray file from being read as a key.
 */
function decodeName(name: string): string | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code === PERCENT) {
      bytes.push(
        Number.parseInt(name.slice(index + 1, index + 1 + HEX_WIDTH), HEX_RADIX)
      );
      index += HEX_WIDTH;
    } else {
      bytes.push(code);
    }
  }

  const text = Buffer.from(bytes).toString("utf8");
  return encodeName(text) === name || earlierName(text) === name
    ? text
    : undefined;
}

/**
 * The key a file in an entity's directory is named for, or undefined when the name is not
 * one the store gives a key there.
 *
 * It has to decode to a key, and that key's entity has to be the one the directory is
 * for. The directory is compared without regard to case, since a filesystem that ignores
 * case hands back one directory for two entities that differ only by it.
 */
function keyNamed(directory: string, stem: string): string | undefined {
  const key = decodeName(stem);
  if (key === undefined || !key.includes(KEY_SEPARATOR)) {
    return;
  }

  const entity = entityOf(key);
  const found = directory.toLowerCase();
  return found === encodeName(entity).toLowerCase() ||
    found === earlierName(entity).toLowerCase()
    ? key
    : undefined;
}

/**
 * The keys the files in an entity's directory are named for, each once.
 *
 * A key is listed for its log, or for its snapshot when it has no log: a key can be held
 * as a snapshot alone, and it loads, so it has to be found. A snapshot beside a log is
 * passed over by its name, without decoding it a second time.
 */
function keysAmong(directory: string, files: readonly string[]): string[] {
  const keys: string[] = [];
  const logged = new Set<string>();
  const found = (stem: string): void => {
    const key = keyNamed(directory, stem);
    if (key !== undefined) {
      keys.push(key);
    }
  };

  for (const file of files) {
    if (file.endsWith(LOG_SUFFIX)) {
      const stem = file.slice(0, -LOG_SUFFIX.length);
      logged.add(stem);
      found(stem);
    }
  }
  for (const file of files) {
    if (file.endsWith(SNAPSHOT_SUFFIX)) {
      const stem = file.slice(0, -SNAPSHOT_SUFFIX.length);
      if (!logged.has(stem)) {
        found(stem);
      }
    }
  }
  return keys;
}

/**
 * Turn a filesystem failure into the store's own error.
 *
 * The message names the store and what it was doing, never the resolved path. These
 * messages end up in a caller's logs and HTTP responses, and the path is `store.dir` for
 * anyone who needs it. The original error rides along as `cause`.
 *
 * An error that is already Ekman's passes through, so a conflict or a refusal raised
 * inside a guarded block keeps its own code.
 */
function toStoreError(
  error: unknown,
  store: string,
  what: string,
  key?: string
): EkmanError {
  if (isEkmanError(error)) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = typeof code === "string" ? ` (${code})` : "";
  return new EkmanError(
    "STORE_UNAVAILABLE",
    `the ${store} store could not ${what}${suffix}.`,
    key === undefined ? { cause: error } : { key, cause: error }
  );
}

/**
 * A durable store: one JSONL append log per key, plus a snapshot file beside it.
 *
 * JSONL because an append log wants appends, and because a file you can read with `tail`
 * during an incident is worth more than a compact binary format. One file per key rather
 * than one shared log, so a key's stream is contiguous and `load` never scans other keys.
 *
 * Writes are synchronous. That is not laziness: checking the sequence and writing the line
 * in one synchronous block is what makes the conditional append actually atomic against a
 * concurrent caller in this process, because nothing can interleave between the two. An
 * async write would need a per-key queue to get the same guarantee, and would still not
 * extend it across processes.
 *
 * A resolved append has been handed to the operating system. That survives this process
 * ending, and it does not survive the machine losing power before the system flushes its
 * cache: there is no fsync per commit.
 *
 * Logs being written to are kept open, up to `maxOpenLogs`, so a commit is one write. The
 * files belong to the store while it runs. Removing one from outside leaves the store
 * writing to a file nobody can reach, so delete through `forget`.
 *
 * Which is why `multiWriter` is false. Two processes pointed at one directory will both
 * believe their conditional appends held. The runtime refuses configurations that need
 * more than this store declares, so the honest declaration is the safety mechanism.
 *
 * Logs are sharded into a directory per entity, because every scan is scoped to one entity,
 * so a flat directory would mean listing every other entity's files to answer about one.
 * Given no directory, the store takes `.ekman/logs` under the calling project's root.
 *
 * A file is named for its key, escaped so that two keys differing only in case are two
 * files on a filesystem that ignores case. Logs written under the earlier naming scheme
 * are renamed the first time their entity's directory is used.
 *
 * A filesystem failure reaches the caller as `STORE_UNAVAILABLE`, naming the store and the
 * key. Once a line is in the log the append has succeeded: accounting runs after it, and a
 * log past its limit is compacted on a later turn of the event loop, never inside the
 * commit that crossed it. A failure in either is kept on `lastHousekeepingError` instead
 * of being reported as a write that never happened.
 */
export class FileStore implements Store {
  readonly name: string;
  readonly capabilities: StoreCapabilities = Object.freeze({
    durability: "durable" as const,
    conditionalAppend: true,
    multiWriter: false,
    scan: { byState: true, olderThan: true },
    forget: true,
    compact: true,
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
  readonly #mode: ResolvedMode;
  readonly #maxOpenLogs: number;

  /** Entity directories known to exist, so a commit does not ask the filesystem again. */
  readonly #dirs = new Set<string>();
  /**
   * Logs open for appending, least recently written first.
   *
   * Anything that replaces or removes a log closes its descriptor first, since a
   * descriptor follows the file it was opened on and not the name.
   */
  readonly #open = new Map<string, number>();
  /**
   * Each log's size as far as this store knows, for the per-log limit.
   *
   * Read off the descriptor on a key's first append in this process and kept by addition
   * after that. Apart from `#bytes`, which stays unset until something needs the total.
   */
  readonly #logBytes = new Map<string, number>();
  /** Logs past their limit, waiting for the compaction that was put off. */
  readonly #oversized = new Set<string>();
  #folding: NodeJS.Immediate | undefined;

  /** Where each key's files are, worked out once per key. */
  readonly #paths = new Map<string, KeyPaths>();
  /** Directory names already checked for files an earlier version left behind. */
  readonly #adopted = new Set<string>();

  /**
   * Per key, where in its log a load can start reading.
   *
   * A load with a snapshot needs only the events after it, and everything before `offset`
   * is known to be at or below `floor`. So a later load whose snapshot is at `floor` or
   * past it reads from `offset` and parses what one residency added, not the whole log.
   *
   * `size` is the log's length as this store last knew it, kept in step with its own
   * appends. A log of any other length was changed by something else, and the entry is
   * dropped for a full read. Compaction, forgetting and a failed write drop it too.
   */
  readonly #tails = new Map<string, Tail>();

  /**
   * Bytes per log, and their total.
   *
   * Seeded lazily rather than at construction, because summing the tree costs a walk of
   * every file and a store nobody asks about should not pay for it. Once seeded it is
   * maintained from the byte lengths `append` already computes, so the common path is
   * arithmetic rather than a stat.
   */
  #bytes: Map<string, number> | undefined;
  /**
   * Bytes per snapshot, kept apart from the logs rather than summed into them.
   *
   * Two questions need different answers. `perLogBytes` asks whether one log outgrew its
   * limit, which is about the log alone: folding it and then counting the snapshot against
   * the same limit would make a compacted key look oversized forever. The budget asks what
   * the store holds, which is both, because compaction moves bytes from a log into a
   * snapshot and a total that watched only logs would report that move as space reclaimed
   * while the disk gave back nothing.
   */
  readonly #snapshotBytes = new Map<string, number>();
  /** Logs plus snapshots. What the budget is measured against. */
  #total = 0;

  /**
   * Logs with nothing left to fold: no transition since the last compaction.
   *
   * Refusals and violations survive compaction by design, so a log made only of them stays
   * over its limit however often it is rewritten. Remembering that keeps an append from
   * re-reading the whole log to learn it again. A transition is the only thing that gives
   * compaction something to do, so appending one takes the key back out.
   */
  readonly #uncompactable = new Set<string>();

  #accountingError: EkmanError | undefined;
  #compactionError: EkmanError | undefined;

  constructor(options?: FileStoreOptions);
  constructor(dir: string, options?: FileStoreOptions);
  constructor(
    dirOrOptions?: string | FileStoreOptions,
    maybeOptions?: FileStoreOptions
  ) {
    const named = typeof dirOrOptions === "string";
    const options = (named ? maybeOptions : dirOrOptions) ?? {};
    assertKnownKeys("the file store's options", options, OPTION_KEYS);
    this.#retention = resolveRetention(options.retention);
    this.#mode = resolveMode(options.mode);
    this.#maxOpenLogs = resolveMaxOpenLogs(options.maxOpenLogs);

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
    try {
      mkdirSync(this.dir, { recursive: true, mode: this.#mode.dir });
    } catch (error) {
      const { code } = error as { code?: unknown };
      // biome-ignore lint/style/useErrorCause: EkmanError takes `cause` in its options bag and forwards it to the Error constructor
      throw new EkmanError(
        "INVALID_CONFIG",
        `the ${this.name} store could not create its directory ${this.dir} (${String(code)}). ` +
          'Pass { kind: "file", dir } to choose another location.',
        { cause: error }
      );
    }
  }

  /**
   * The failure of the last accounting or compaction pass that followed an append, if the
   * most recent one failed.
   *
   * Those passes run after the line is in the log, so their failure is never the append's:
   * the event is durable and the sequence has moved. It is kept here for an operator to
   * read. Each kind is cleared by the next pass of its own kind that succeeds, and a
   * compaction failure is the one reported when both have failed.
   */
  get lastHousekeepingError(): EkmanError | undefined {
    return this.#compactionError ?? this.#accountingError;
  }

  /**
   * How many logs are open for appending right now. Never more than `maxOpenLogs`.
   *
   * A diagnostic, for checking a process against its descriptor limit.
   */
  get openLogs(): number {
    return this.#open.size;
  }

  append(key: string, event: EkmanEvent, expectedSeq: number): Promise<void> {
    return this.#settle(
      `append to the log of ${JSON.stringify(key)}`,
      key,
      () => this.#append(key, event, expectedSeq)
    );
  }

  /**
   * The conditional append, as one synchronous block.
   *
   * The sequence moves as soon as the line is written and before any housekeeping, so
   * nothing that fails afterwards can leave the cache behind the log and let a second
   * append through at the same sequence.
   */
  #append(key: string, event: EkmanEvent, expectedSeq: number): void {
    const current = this.#currentSeq(key);
    if (current !== expectedSeq) {
      throw conflict(this.name, key, expectedSeq, current);
    }

    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const width = line.length;

    // Refused before the write, and only for a key this store has never seen. An instance
    // that already exists keeps committing: shedding new work is recoverable, and stopping
    // work already in flight is not.
    const refusal = this.#refuseIfFull(key, width);
    if (refusal !== undefined) {
      throw refusal;
    }

    const descriptor = this.#write(key, line);
    const tail = this.#tails.get(key);
    if (tail !== undefined) {
      this.#tails.set(key, { ...tail, size: tail.size + width });
    }
    if (event.type === "transition") {
      this.#seq.set(key, event.seq);
      this.#uncompactable.delete(key);
    }

    try {
      this.#account(key, width);
      this.#measure(key, descriptor, width);
      this.#accountingError = undefined;
    } catch (error) {
      this.#accountingError = toStoreError(
        error,
        this.name,
        `account for the log of ${JSON.stringify(key)} after appending to it`,
        key
      );
    }
  }

  /**
   * Put one line at the end of a key's log, and return the descriptor it went through.
   *
   * A write that fails may have left part of a line behind. Dropping the cached sequence
   * makes the next append read the log again, and reading is what trims a torn tail, so
   * nothing is ever concatenated onto the fragment.
   */
  #write(key: string, line: Buffer): number {
    try {
      const descriptor = this.#descriptor(key);
      let written = 0;
      while (written < line.length) {
        written += writeSync(descriptor, line, written);
      }
      return descriptor;
    } catch (error) {
      this.#seq.delete(key);
      this.#tails.delete(key);
      this.#logBytes.delete(key);
      this.#release(key);
      throw error;
    }
  }

  /**
   * The descriptor a key's log is appended through, opening it if it is not open.
   *
   * Opened for append, so every write lands at the end of the file whatever else has
   * happened to it. Using one moves it to the back of the queue, and opening one at the
   * limit closes whichever has waited longest first. First, so the store never holds one
   * descriptor more than its limit, and a process with none to spare can still open the
   * log it needs.
   */
  #descriptor(key: string): number {
    const held = this.#open.get(key);
    if (held !== undefined) {
      this.#open.delete(key);
      this.#open.set(key, held);
      return held;
    }

    const { dir, log } = this.#pathsOf(key);
    if (this.#open.size >= this.#maxOpenLogs) {
      for (const coldest of this.#open.keys()) {
        this.#release(coldest);
        break;
      }
    }

    const descriptor = this.#inside(dir, () =>
      openSync(log, "a", this.#mode.file)
    );
    this.#open.set(key, descriptor);
    return descriptor;
  }

  /** Close a key's log if it is open. The next append opens it again. */
  #release(key: string): void {
    const held = this.#open.get(key);
    if (held !== undefined) {
      this.#open.delete(key);
      closeSync(held);
    }
  }

  /**
   * Do something that needs an entity's directory to exist.
   *
   * The directory is created once and remembered. If it has gone since, the work fails as
   * a missing path, and it is created again and the work tried once more.
   */
  #inside<T>(dir: string, work: () => T): T {
    if (this.#dirs.has(dir)) {
      try {
        return work();
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") {
          throw error;
        }
        this.#dirs.delete(dir);
      }
    }

    mkdirSync(dir, { recursive: true, mode: this.#mode.dir });
    this.#dirs.add(dir);
    return work();
  }

  /**
   * Keep a log's size current, and queue it for compaction once it is past its limit.
   *
   * The compaction itself is put off to a later turn of the event loop. Folding a log
   * means reading, replaying and rewriting all of it, and the sender whose commit happened
   * to cross the limit should not be the one who waits for that.
   *
   * A later turn only comes if the caller lets one happen, and a loop of awaited sends to a
   * synchronous store never does. So the limit has a backstop: a log that reaches twice
   * its limit while still waiting is folded here, in the commit that got it there. That
   * bounds a log at twice its limit however the caller is written.
   */
  #measure(key: string, descriptor: number, width: number): void {
    const limit = this.#retention.perLogBytes;
    if (limit === 0) {
      return;
    }

    const known = this.#logBytes.get(key);
    const size =
      known === undefined ? fstatSync(descriptor).size : known + width;
    this.#logBytes.set(key, size);

    if (size <= limit || this.#uncompactable.has(key)) {
      return;
    }
    if (size > limit * OVERDUE_FACTOR) {
      this.#oversized.delete(key);
      this.#compactionError = this.#fold(key);
      return;
    }

    this.#oversized.add(key);
    // Unreferenced, so a process with nothing else to do is not kept alive to tidy up.
    this.#folding ??= setImmediate(() => this.#foldOversized()).unref();
  }

  /**
   * Compact one log, returning the failure if it could not be done.
   *
   * What it gave back is added to `swept` when a sweep is the one asking.
   */
  #fold(key: string, swept?: Swept): EkmanError | undefined {
    try {
      const freed = this.#compactLog(key, this.#bytes?.get(key) ?? 0);
      if (swept !== undefined) {
        tally(swept, freed);
      }
    } catch (error) {
      return toStoreError(
        error,
        this.name,
        `compact the log of ${JSON.stringify(key)}`,
        key
      );
    }
  }

  /**
   * Compact every log that passed its limit since the last time this ran.
   *
   * Appends are synchronous, so none is ever in progress when this runs. One that landed
   * after its log was queued is simply part of what gets folded.
   *
   * Returns the failure, if a log could not be compacted. With nothing queued it changes
   * nothing, so an earlier failure stays on record until a compaction succeeds.
   */
  #foldOversized(swept?: Swept): EkmanError | undefined {
    clearImmediate(this.#folding);
    this.#folding = undefined;
    if (this.#oversized.size === 0) {
      return;
    }

    let failure: EkmanError | undefined;
    for (const key of this.#oversized) {
      this.#oversized.delete(key);
      failure = this.#fold(key, swept) ?? failure;
    }
    this.#compactionError = failure;
    return failure;
  }

  /** What this store is holding, and what it is allowed to hold. */
  usage(): StoreUsage {
    const bytes = this.#attempt("measure its logs", undefined, () =>
      this.#seeded()
    );
    return Object.freeze({
      bytes: this.#total,
      logs: bytes.size,
      maxBytes: this.#retention.bounded ? this.#retention.totalBytes : null,
    });
  }

  /**
   * The snapshot, if there is one, and the events after it.
   *
   * The snapshot is read first, because it says how much of the log does not need reading.
   * The sequence is worked out from what was just read and remembered, so the append that
   * usually follows a load does not read either file again.
   */
  load(key: string): Promise<LoadResult | undefined> {
    return this.#settle(`load ${JSON.stringify(key)}`, key, () => {
      const snapshot = this.#readSnapshot(key);
      const events =
        snapshot === undefined
          ? this.#readLog(key)
          : this.#readAfter(key, snapshot.seq);

      if (events.length === 0 && snapshot === undefined) {
        return;
      }

      const seq = Math.max(
        latestSeq(events),
        snapshot === undefined ? EMPTY_SEQ : snapshot.seq
      );
      this.#seq.set(key, seq);
      return { snapshot, events, seq };
    });
  }

  read(key: string): Promise<readonly EkmanEvent[]> {
    return this.#settle(`read the log of ${JSON.stringify(key)}`, key, () =>
      this.#readLog(key)
    );
  }

  snapshot(key: string, snapshot: StoreSnapshot): Promise<void> {
    return this.#settle(`snapshot ${JSON.stringify(key)}`, key, () => {
      const existing = this.#readSnapshot(key);
      if (existing !== undefined && existing.seq >= snapshot.seq) {
        return;
      }

      const { dir, snapshot: path } = this.#pathsOf(key);
      this.#inside(dir, () => this.#writeWhole(path, JSON.stringify(snapshot)));
      // A snapshot past the last event in the log moves the key on, so a sequence
      // remembered from before it is read again.
      if ((this.#seq.get(key) ?? snapshot.seq) < snapshot.seq) {
        this.#seq.delete(key);
      }
      this.#accountSnapshot(key);
    });
  }

  scan(criteria: ScanCriteria): Promise<ScanResult> {
    // Scoped to the one entity asked about, which is the whole reason logs are sharded by
    // entity: the alternative is listing every other entity's files to answer about one.
    return this.#settle(
      `list the logs of ${JSON.stringify(criteria.entity)}`,
      undefined,
      () => this.#keysOf(criteria.entity)
    ).then((keys) => scanKeys(keys, criteria, (key) => this.load(key)));
  }

  forget(key: string): Promise<void> {
    return this.#settle(`forget ${JSON.stringify(key)}`, key, () => {
      this.#release(key);
      // `force` so forgetting a key this store never held is not an error. A sweep that
      // dies halfway and is retried should behave the same the second time.
      rmSync(this.#logPath(key), { force: true });
      rmSync(this.#snapshotPath(key), { force: true });

      // The cached sequence has to go too, or a key created again under the same name
      // would be appended at the old number and refused as a conflict.
      this.#seq.delete(key);
      this.#uncompactable.delete(key);
      this.#tails.delete(key);
      this.#logBytes.delete(key);
      this.#oversized.delete(key);
      this.#paths.delete(key);

      // Zero when nothing is counting yet, which makes this a no-op rather than a special
      // case: an unseeded store has a total of zero to take it off. Both files come off,
      // because both were counted.
      this.#total -= this.#bytes?.get(key) ?? 0;
      this.#bytes?.delete(key);
      if (this.#bytes !== undefined) {
        this.#total -= this.#snapshotBytes.get(key) ?? 0;
      }
      this.#snapshotBytes.delete(key);
    });
  }

  /** Run one synchronous store operation, raising any failure as the store's own error. */
  #attempt<T>(what: string, key: string | undefined, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw toStoreError(error, this.name, what, key);
    }
  }

  /**
   * The same, as the promise the store interface returns.
   *
   * A failure is a rejection and never a synchronous throw, so a caller that only attached
   * a `catch` still sees it.
   */
  #settle<T>(
    what: string,
    key: string | undefined,
    operation: () => T
  ): Promise<T> {
    try {
      return Promise.resolve(this.#attempt(what, key, operation));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Write a whole file through a temporary name and a rename.
   *
   * A crash leaves the old file or the new one, never a torn one: a half-written snapshot
   * that replaced a whole one would be worse than no snapshot at all. Rename is atomic
   * within a filesystem.
   *
   * The temporary name is the destination's with its last extension swapped, not added
   * to, so it fits in a path component whenever the destination does.
   *
   * The temporary file is always created here and never reused. One a crash left behind
   * is removed first, so its contents and its permissions go with it, and what replaces
   * the destination always has the configured mode.
   */
  #writeWhole(path: string, contents: string): void {
    const temp = `${path.slice(0, path.lastIndexOf("."))}${TEMPORARY_SUFFIX}`;
    try {
      rmSync(temp, { force: true });
      writeFileSync(temp, contents, {
        encoding: "utf8",
        flag: "wx",
        mode: this.#mode.file,
      });
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  /**
   * Reclaim space by folding the largest logs, until back inside the budget or out of
   * things worth folding.
   *
   * Off the commit path deliberately. Choosing what to compact means walking every key,
   * and doing that while somebody waits on an append trades a bounded latency for an
   * unbounded one. The runtime calls this on its own schedule.
   *
   * Largest first, because the budget is a total and the biggest log gives back the most
   * per rewrite. The walk is one pass over a fixed list, so it terminates whether or not it
   * reaches the bound: a log that has already been folded gives back nothing and is simply
   * passed over. Reaching the end still over budget is reported rather than retried, since
   * compaction has a floor and sweeping harder cannot lower it.
   *
   * A no-op under any other policy, which is what makes this safe for the runtime to call
   * across every layer without asking each one what it was configured for.
   */
  compact(): Promise<StoreCompaction> {
    return this.#settle("compact its logs", undefined, () => this.#sweep());
  }

  #sweep(): StoreCompaction {
    // Seeded first, and even when there is nothing to do. `withinBudget` is then answered
    // from the real numbers and not from an empty table that would read as comfortably
    // inside a budget the store has never measured itself against, and what the folds
    // below give back can be measured at all.
    const bytes = this.#seeded();
    const swept: Swept = { logs: 0, reclaimed: 0 };

    // Whatever is already past its own limit goes first, so the budget is measured against
    // what is left after the compaction this store owed anyway. It is still this sweep
    // that did the work, so it is counted in what the sweep reports.
    const failure = this.#foldOversized(swept);
    if (failure !== undefined) {
      throw failure;
    }

    if (this.#retention.policy !== "compact") {
      return this.#compaction(swept);
    }

    // Both key and size taken from one snapshot of the table, because compacting rewrites
    // entries as it goes and re-reading a size mid-walk would measure the wrong log.
    const largestFirst = [...bytes.entries()].sort(([, a], [, b]) => b - a);

    for (const [key, size] of largestFirst) {
      if (this.#total <= this.#retention.totalBytes) {
        break;
      }
      tally(swept, this.#compactLog(key, size));
    }

    return this.#compaction(swept);
  }

  #compaction({ logs, reclaimed }: Swept): StoreCompaction {
    return Object.freeze({
      logs,
      reclaimed,
      withinBudget: this.#total <= this.#retention.totalBytes,
    });
  }

  /**
   * Every key this store holds a log for, recovered from the directory itself.
   *
   * Sorted, so a scan walks keys in the same order on every run and a limit truncates the
   * same way twice. Directory order is not something to build a contract on.
   */
  get keys(): readonly string[] {
    return this.#attempt("list its logs", undefined, () => this.#keysOf());
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
      const size = this.#sizeOf(this.#logPath(key));
      bytes.set(key, size);
      total += size;

      // The snapshot beside it counts too. It is not history, but it is bytes on the same
      // disk, and a budget that could not see them would go on reporting room that is not
      // there once compaction started moving the log into it.
      const snapshot = this.#sizeOf(this.#snapshotPath(key));
      if (snapshot > 0) {
        this.#snapshotBytes.set(key, snapshot);
        total += snapshot;
      }
    }

    this.#bytes = bytes;
    this.#total = total;
    return bytes;
  }

  /** A file's size, or 0 when it is not there. */
  #sizeOf(path: string): number {
    return existsSync(path) ? statSync(path).size : 0;
  }

  /**
   * Bring a key's snapshot back into the total after it was written or replaced.
   *
   * Stat rather than the serialized length, because `snapshot` writes through a temporary
   * name and a rename, and what matters is what ended up at the final path.
   */
  #accountSnapshot(key: string): void {
    if (this.#bytes === undefined) {
      // Nobody is counting yet. The eventual seed reads both files off disk, so skipping
      // this cannot make the total wrong.
      return;
    }

    const size = this.#sizeOf(this.#snapshotPath(key));
    this.#total += size - (this.#snapshotBytes.get(key) ?? 0);
    this.#snapshotBytes.set(key, size);
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
  /**
   * Release what the store holds open, after doing the compaction it had put off.
   *
   * Nothing is left scheduled afterwards. The store still works: an append after this
   * opens its log again.
   */
  close(): Promise<void> {
    return this.#settle("close its logs", undefined, () => {
      this.#foldOversized();
      for (const key of [...this.#open.keys()]) {
        this.#release(key);
      }
    });
  }

  /**
   * Fold one log, whatever its size, and report the bytes it gave back.
   *
   * Split from the per-log check because the budget sweep has a different question. The
   * check asks whether this log outgrew its own limit; the sweep asks for bytes back and
   * does not care what `perLogBytes` was set to, including `0`, which switches the per-log
   * check off entirely and must not switch the sweep off with it.
   */
  #compactLog(key: string, size: number): number {
    // Measured as the change in the whole total, not in the log alone. Folding always
    // shrinks the log and always grows the snapshot, so reporting the log's drop as bytes
    // reclaimed would credit a move between two files as space given back.
    const before = this.#total;
    // Folded onto any earlier snapshot, because a log compacted before holds only the
    // events after it and replaying those alone would lose everything before.
    const events = this.#readLog(key);
    const current = replay({
      snapshot: this.#readSnapshot(key),
      events,
      seq: latestSeq(events),
    });
    if (
      current === undefined ||
      !events.some((event) => event.type === "transition")
    ) {
      // Nothing but refusals and violations in the log. Either there is no state to
      // snapshot, or the snapshot already holds all of it, and what is left is the only
      // record that those triggers were turned away.
      this.#uncompactable.add(key);
      return 0;
    }

    // Snapshot first: it has to be whole on disk before the log gives up the events it
    // folds, or a crash between the two would lose them.
    this.#writeWhole(
      this.#snapshotPath(key),
      JSON.stringify({
        key,
        entity: entityOf(key),
        state: current.state,
        values: current.values,
        seq: current.seq,
        at: Date.now(),
        enteredAt: current.enteredAt,
        ...(current.temporal === undefined
          ? {}
          : { temporal: current.temporal }),
      } satisfies StoreSnapshot)
    );
    this.#accountSnapshot(key);

    // Everything the snapshot does not account for. A rejection or a violation carries the
    // sequence it followed rather than a new one, so events at the snapshot's own sequence
    // that are not the transition itself have to survive.
    const kept = events.filter(
      (event) => event.seq > current.seq || event.type !== "transition"
    );
    const rewritten = kept
      .map((event) => `${JSON.stringify(event)}\n`)
      .join("");

    // Closed first: the rewrite puts a new file under the name, and a descriptor held
    // open would go on appending to the old one. Opened again if it was open, so the cost
    // of that lands here and not on the next commit, and last, so a log that cannot be
    // opened again has already had its new size written down.
    const wasOpen = this.#open.has(key);
    this.#release(key);
    this.#writeWhole(this.#logPath(key), rewritten);
    this.#tails.delete(key);
    const length = Buffer.byteLength(rewritten, "utf8");
    this.#logBytes.set(key, length);
    this.#resize(key, size, length);
    const freed = before - this.#total;
    if (wasOpen) {
      this.#descriptor(key);
    }
    return freed;
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

  /**
   * The keys under one entity, or under all of them when no entity is named.
   *
   * Read back from the file names, which is exact: a name decodes to the one key it was
   * made from. Anything the store did not name is left out, since an application is free
   * to keep its own files alongside and a stray one must not be mistaken for a key or
   * stop the walk.
   */
  #keysOf(entity?: string): readonly string[] {
    const keys: string[] = [];
    for (const name of this.#directoriesOf(entity)) {
      const dir = join(this.dir, name);
      if (!existsSync(dir)) {
        continue;
      }
      keys.push(...keysAmong(name, readdirSync(dir)));
    }

    return keys.sort();
  }

  /**
   * The directory names to list for one entity, or for all of them, once anything an
   * earlier version left in them has been renamed.
   *
   * For all of them the root is listed twice, because adopting moves files into
   * directories that may not have existed a moment ago and removes the ones it emptied.
   */
  #directoriesOf(entity?: string): readonly string[] {
    if (entity !== undefined) {
      return [this.#adopt(entity)];
    }

    for (const name of this.#directories()) {
      this.#adoptDirectory(name);
    }
    return this.#directories();
  }

  #directories(): readonly string[] {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  /**
   * Make an entity's directory safe to address by name, and return that name.
   *
   * Both the current name and the earlier one are checked. On a filesystem that ignores
   * case the current name of one entity can open a directory an earlier version made for
   * another, so files are placed by what their own names decode to, never by which
   * directory they were found in.
   *
   * The earlier scheme left `.` unescaped, so the earlier name of an entity called `..` is
   * the directory above the store. That one is never looked in.
   */
  #adopt(entity: string): string {
    const current = encodeName(entity);
    this.#adoptDirectory(current);
    const earlier = earlierName(entity);
    if (!DIRECTORY_REFERENCES.has(earlier)) {
      this.#adoptDirectory(earlier);
    }
    return current;
  }

  /**
   * Rename whatever an earlier version left in one directory, once per process.
   *
   * Done for the whole directory before any key in it is looked up by name. Looking up
   * first is what would go wrong: where case is ignored, the current name of `orders:abc`
   * opens the file an earlier version wrote for `orders:Abc`.
   */
  #adoptDirectory(name: string): void {
    if (this.#adopted.has(name)) {
      return;
    }

    const dir = join(this.dir, name);
    if (existsSync(dir)) {
      const moved = readdirSync(dir).filter((file) => this.#rehome(name, file));
      if (moved.length > 0 && readdirSync(dir).length === 0) {
        rmdirSync(dir);
      }
    }
    this.#adopted.add(name);
  }

  /**
   * Move one file to where its key belongs under the current naming scheme, reporting
   * whether it moved.
   *
   * A file already in place, and a file the store did not name, are left alone. So is one
   * whose destination is the same path in another case, which is the same file wherever
   * that can happen.
   *
   * A file whose key has no name short enough under the current scheme is refused out
   * loud. Leaving it where it is and carrying on would hide an instance, and where case is
   * ignored its old name is one another key's current name can open.
   */
  #rehome(directory: string, file: string): boolean {
    const suffix = [SNAPSHOT_SUFFIX, LOG_SUFFIX].find((ending) =>
      file.endsWith(ending)
    );
    const key =
      suffix === undefined
        ? undefined
        : keyNamed(directory, file.slice(0, -suffix.length));
    if (key === undefined) {
      return false;
    }

    const name = encodeName(key);
    const home = encodeName(entityOf(key));
    const from = join(directory, file);
    const to = join(home, `${name}${suffix}`);
    // Before anything else, and for a file already at its current name too: a key of
    // lowercase letters has one name under both schemes, and an earlier version would
    // write one longer than this version will read.
    if (name.length > MAX_NAME_BYTES) {
      throw new EkmanError(
        "STORE_UNAVAILABLE",
        `the ${this.name} store holds a file for ${JSON.stringify(key)} named under an earlier ` +
          `scheme, and its name under the current one is ${name.length} bytes where the limit ` +
          `is ${MAX_NAME_BYTES}. The file was left as it is. Move it out of the store to go on ` +
          "without that key.",
        { key }
      );
    }

    if (from.toLowerCase() === to.toLowerCase()) {
      return false;
    }

    if (existsSync(join(this.dir, to))) {
      throw new EkmanError(
        "STORE_UNAVAILABLE",
        `the ${this.name} store holds two files for ${JSON.stringify(key)}, one of them named ` +
          "under an earlier scheme. Neither was changed. Keep the one that is current and " +
          "remove the other.",
        { key }
      );
    }

    mkdirSync(join(this.dir, home), { recursive: true, mode: this.#mode.dir });
    renameSync(join(this.dir, from), join(this.dir, to));
    return true;
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
   * leaves a partial line behind: a full disk makes a write come up short,
   * and so does losing the process between the write and the flush. That fragment is not
   * parseable, and parsing it would throw on every later load, so a torn tail would cost
   * the key everything rather than the one event that never landed.
   *
   * A malformed line that *is* newline-terminated is refused as `STORE_UNAVAILABLE`. It was
   * written whole, so whatever damaged it damaged the file, and reporting a corrupted log
   * as a short healthy one is the worse of the two failures.
   */
  #readLog(key: string): EkmanEvent[] {
    return this.#eventsIn(key, this.#wholeLines(key));
  }

  /** The bytes of a key's log up to its last whole line, trimming a torn tail off the file. */
  #wholeLines(key: string): Buffer {
    const path = this.#logPath(key);
    if (!existsSync(path)) {
      return NO_BYTES;
    }

    // Byte offsets, not string indices: a multibyte character before the cut would put a
    // string index in the wrong place.
    const bytes = readFileSync(path);
    const lastNewline = bytes.lastIndexOf(NEWLINE);

    // Repaired now, not on the next append: appending would concatenate onto the fragment
    // and leave a corrupt line that is no longer last, indistinguishable from real damage.
    if (lastNewline !== bytes.length - 1) {
      truncateSync(path, lastNewline + 1);
      this.#tails.delete(key);
      this.#logBytes.delete(key);
    }

    return bytes.subarray(0, lastNewline + 1);
  }

  /**
   * Parse whole lines into events, keeping those a snapshot at `covered` does not account
   * for: every later commit, and anything recorded at that sequence that is not a commit.
   *
   * `startsAt`, when asked for, is given the index into the text of the first line kept,
   * or the text's length when none was.
   */
  #eventsIn(
    key: string,
    lines: Buffer,
    covered = Number.NEGATIVE_INFINITY,
    startsAt?: (text: string, index: number) => void
  ): EkmanEvent[] {
    const text = lines.toString("utf8");
    const events: EkmanEvent[] = [];
    let index = 0;
    let first = text.length;

    for (const [number, line] of text.split("\n").entries()) {
      if (line.length > 0) {
        const event = this.#parse<EkmanEvent>(
          line,
          key,
          `log for ${JSON.stringify(key)} is corrupt at line ${number + 1}`
        );
        if (isAfterSnapshot(event, covered)) {
          first = Math.min(first, index);
          events.push(event);
        }
      }
      index += line.length + 1;
    }

    startsAt?.(text, first);
    return events;
  }

  /**
   * The events a snapshot does not account for, reading no more of the log than it has to.
   *
   * The first load of a key in this process reads the whole log, which is also what trims
   * a torn tail. It leaves behind where the events it kept begin, and later loads start
   * there. Anything unexpected about the remembered tail, its length or its contents,
   * sends the load back to the whole log, so a stale entry costs a read and never an
   * answer.
   */
  #readAfter(key: string, covered: number): EkmanEvent[] {
    return this.#readTail(key, covered) ?? this.#remember(key, covered, 0);
  }

  /** Events from the remembered offset, or undefined when the whole log has to be read. */
  #readTail(key: string, covered: number): EkmanEvent[] | undefined {
    const tail = this.#tails.get(key);
    if (tail === undefined) {
      return;
    }

    const path = this.#logPath(key);
    const size = statSync(path, { throwIfNoEntry: false })?.size;
    if (tail.floor > covered || size !== tail.size) {
      this.#tails.delete(key);
      return;
    }
    if (tail.offset === tail.size) {
      return [];
    }

    try {
      return this.#remember(key, covered, tail.offset);
    } catch {
      this.#tails.delete(key);
    }
  }

  /**
   * Read a key's log from a byte offset, keep the events above `covered`, and record
   * where they begin for the next load.
   */
  #remember(key: string, covered: number, from: number): EkmanEvent[] {
    const whole =
      from === 0 ? this.#wholeLines(key) : readFileSync(this.#logPath(key));
    return this.#eventsIn(key, whole.subarray(from), covered, (text, index) => {
      this.#tails.set(key, {
        floor: covered,
        offset: from + Buffer.byteLength(text.slice(0, index), "utf8"),
        size: whole.length,
      });
    });
  }

  #readSnapshot(key: string): StoreSnapshot | undefined {
    const path = this.#snapshotPath(key);
    if (!existsSync(path)) {
      return;
    }
    return this.#parse<StoreSnapshot>(
      readFileSync(path, "utf8"),
      key,
      `snapshot for ${JSON.stringify(key)} is corrupt`
    );
  }

  /** Parse stored JSON, naming the key and never the file when it does not parse. */
  #parse<T>(text: string, key: string, problem: string): T {
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: EkmanError takes `cause` in its options bag and forwards it to the Error constructor
      throw new EkmanError(
        "STORE_UNAVAILABLE",
        `the ${this.name} store's ${problem}.`,
        { key, cause: error }
      );
    }
  }

  /**
   * Where a key's files are.
   *
   * The entity's directory is created on write rather than here, because it cannot be
   * known to be needed until something is written. The key stays readable inside the
   * file: the name is a storage-layout detail and must never become the identity anyone
   * reads.
   *
   * A name has to fit in one path component with its suffix, so a key whose name does not
   * is refused, and that is `INVALID_KEY` because no retry can make it fit. So is a key
   * that is not well-formed text: half of a surrogate pair is written as the replacement
   * character, and two such keys would share one file.
   */
  #pathsOf(key: string): KeyPaths {
    const known = this.#paths.get(key);
    if (known !== undefined) {
      return known;
    }

    if (!isWellFormed(key)) {
      throw new EkmanError(
        "INVALID_KEY",
        `the ${this.name} store names a file after each key, and this key holds half of a ` +
          "surrogate pair, which has no bytes of its own to be named by.",
        { key }
      );
    }

    const name = encodeName(key);
    if (name.length > MAX_NAME_BYTES) {
      throw new EkmanError(
        "INVALID_KEY",
        `the ${this.name} store names a file after each key, and this key's name is ${name.length} bytes ` +
          `where the limit is ${MAX_NAME_BYTES}. Uppercase letters and anything outside ASCII ` +
          "letters, digits, - and _ take three bytes or more each.",
        { key }
      );
    }

    const dir = join(this.dir, this.#adopt(entityOf(key)));
    const paths = {
      dir,
      log: join(dir, `${name}${LOG_SUFFIX}`),
      snapshot: join(dir, `${name}${SNAPSHOT_SUFFIX}`),
    };
    this.#paths.set(key, paths);
    return paths;
  }

  #logPath(key: string): string {
    return this.#pathsOf(key).log;
  }

  #snapshotPath(key: string): string {
    return this.#pathsOf(key).snapshot;
  }
}

interface Tail {
  /** Every event before `offset` has a sequence at or below this. */
  readonly floor: number;
  readonly offset: number;
  readonly size: number;
}

interface KeyPaths {
  readonly dir: string;
  readonly log: string;
  readonly snapshot: string;
}

/**
 * The longest encoded name, in bytes. The longest suffix added to it is 14 bytes, and a
 * path component is limited to 255 on the filesystems this runs on.
 */
/** What a sweep has done so far: how many logs it folded, and the bytes that gave back. */
interface Swept {
  logs: number;
  reclaimed: number;
}

/** Count one fold, if it gave anything back. */
function tally(swept: Swept, freed: number): void {
  if (freed > 0) {
    swept.logs += 1;
    swept.reclaimed += freed;
  }
}

const MAX_NAME_BYTES = 240;
const TEMPORARY_SUFFIX = ".tmp";
/** Names that are a path to a directory and never the name of one inside the store. */
const DIRECTORY_REFERENCES: ReadonlySet<string> = new Set([".", ".."]);
const LOGS_DIR_NAME = "logs";
const LOG_SUFFIX = ".jsonl";
const SNAPSHOT_SUFFIX = ".snapshot.json";
/** The record separator, as a byte, because torn tails are found by byte offset. */
const NEWLINE = 0x0a;
const NO_BYTES = Buffer.alloc(0);

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
