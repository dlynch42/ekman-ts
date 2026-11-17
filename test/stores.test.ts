import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EkmanError } from "../src/errors";
import type { EkmanEvent, TransitionEvent } from "../src/events";
import {
  defaultLogDir,
  defaultStoreDir,
  Ekman,
  EMPTY_SEQ,
  entityOf,
  projectRoot,
  replay,
  STORE_DIR_NAME,
} from "../src/index";
import type { LoadResult, Store, StoreSnapshot } from "../src/store";
import type { FileStore, RetentionPolicy } from "../src/stores/file";
import { fileStore } from "../src/stores/file";
import { memoryStore } from "../src/stores/memory";
import type { Values } from "../src/types";
import { storeContract } from "./store-contract";

const NEEDS_BUDGET = /needs a totalBytes to act on/;
const NEEDS_BYTE_COUNT = /non-negative integer/;
const WHEN_FULL = /retention totalBytes/;
const NOT_A_POLICY = /is not recognized/;
const PLAIN_IN_A_NAME = /[a-z0-9_-]/;
const UNKNOWN_OPTION = /has an unrecognized option/;
const PERMISSION_BITS = /permission bits between 0 and 0o777/;
const TWO_FILES = /holds two files for "orders:Abc"/;
const TOO_LONG_TO_RENAME = /named under an earlier scheme.*309 bytes/;
const TOO_LONG_AS_IT_IS = /named under an earlier scheme.*241 bytes/;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const GROUP_READABLE_FILE = 0o640;
const GROUP_READABLE_DIR = 0o750;
const PERMISSION_RANGE = 0o1000;

/** The name a whole-file write goes through on its way to a path. */
const temporaryOf = (path: string): string =>
  `${path.slice(0, path.lastIndexOf("."))}.tmp`;

/**
 * The name the file store gives a key or an entity, restated here so the tests pin the
 * layout instead of asking the store what it did.
 */
const nameOf = (text: string): string =>
  [...Buffer.from(text, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return PLAIN_IN_A_NAME.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");

/** Where a key's log lives: sharded by entity, named for the key. */
const logPathOf = (dir: string, key: string): string =>
  join(dir, nameOf(entityOf(key)), `${nameOf(key)}.jsonl`);

/** The snapshot beside it, which the byte total counts too. */
const snapshotPathOf = (dir: string, key: string): string =>
  join(dir, nameOf(entityOf(key)), `${nameOf(key)}.snapshot.json`);

/** What a key actually occupies: both files, which is what a budget has to measure. */
const onDisk = (dir: string, key: string): number => {
  const snapshot = snapshotPathOf(dir, key);
  return (
    readFileSync(logPathOf(dir, key)).byteLength +
    (existsSync(snapshot) ? readFileSync(snapshot).byteLength : 0)
  );
};

/** Who may read, write and run a file: its mode without the bits that say what it is. */
const permissionsOf = (path: string): number => statSync(path).mode % 0o1000;

/**
 * Whether taking permissions away would stop this process. It would not on Windows, and it
 * would not as root, so tests that deny access to provoke a failure are skipped there.
 */
const CANNOT_DENY = process.platform === "win32" || process.getuid?.() === 0;

/**
 * Give the event loop one turn, which is when a file store compacts a log that passed its
 * limit.
 */
const turn = (): Promise<void> =>
  new Promise((done) => {
    setImmediate(done);
  });

const temporaryDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ekman-store-"));
  temporaryDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporaryDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Where a store puts its files when nobody said where. Exercised through the `from`
// parameter against throwaway trees rather than by chdir, which is process-global and
// unavailable under a threads pool.
describe("finding the project root", () => {
  /** A directory `depth` levels below a temp root, with `package.json` where asked. */
  function tree(marked: readonly string[], leaf: string): string {
    const root = freshDir();
    for (const at of marked) {
      const dir = at === "" ? root : join(root, at);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), "{}", "utf8");
    }
    const target = join(root, leaf);
    mkdirSync(target, { recursive: true });
    return target;
  }

  it("walks up to the nearest package.json", () => {
    const target = tree(["pkg"], "pkg/a/b");
    // Compared against the constructed string, not a realpath: on macOS neither `resolve`
    // nor `dirname` follows the /var to /private/var symlink, so the prefix is unchanged.
    expect(projectRoot(target)).toBe(dirname(dirname(target)));
  });

  it("prefers the nearest package.json over the outermost", () => {
    // The monorepo case. Taking the outermost would pool every package's state together.
    const target = tree(["", "inner"], "inner/deep");
    expect(projectRoot(target)).toBe(dirname(target));
  });

  it("answers with the starting directory when the package.json is right there", () => {
    const target = tree(["here"], "here");
    expect(projectRoot(target)).toBe(target);
  });

  it("falls back to where it started when nothing above has one", () => {
    const target = tree([], "orphan");

    // Only meaningful on a machine with no package.json above the temp directory. Skipped
    // rather than left to fail mysteriously somewhere that does.
    let above = dirname(target);
    let found = false;
    for (;;) {
      if (existsSync(join(above, "package.json"))) {
        found = true;
        break;
      }
      const parent = dirname(above);
      if (parent === above) {
        break;
      }
      above = parent;
    }

    if (found) {
      return;
    }
    expect(projectRoot(target)).toBe(target);
  });

  it("puts the store directory under whatever root it found", () => {
    const target = tree(["pkg"], "pkg");
    expect(defaultStoreDir(target)).toBe(join(target, STORE_DIR_NAME));
  });
});

// The same contract, both adapters. An adapter that passes can be swapped in without
// reading the runtime; one that fails is broken however reasonable it looks.
describe("store contract", () => {
  storeContract("memory", () => memoryStore(), { durable: false });
  storeContract("file", () => fileStore(freshDir()), { durable: true });
});

describe("capability declarations", () => {
  it("says the memory store is ephemeral", () => {
    expect(memoryStore().capabilities).toMatchObject({
      durability: "ephemeral",
      conditionalAppend: true,
      multiWriter: false,
    });
  });

  it("says the file store is durable but single-writer", () => {
    // Honest rather than flattering. Two processes on one directory would both believe
    // their conditional appends held, so the runtime has to be able to refuse that setup.
    expect(fileStore(freshDir()).capabilities).toMatchObject({
      durability: "durable",
      conditionalAppend: true,
      multiWriter: false,
    });
  });

  it("lets a layer name itself and claim authority", () => {
    const store = memoryStore({ name: "hot", authority: true });
    expect(store.name).toBe("hot");
    expect(store.authority).toBe(true);
  });
});

describe("the file store on disk", () => {
  it("survives being reopened, which is the whole point of it", async () => {
    const dir = freshDir();
    const first = fileStore(dir);

    await first.append(
      "orders:1",
      {
        type: "transition",
        key: "orders:1",
        from: null,
        to: "pending",
        seq: 0,
        at: 0,
        cause: { type: "init", id: "t1" },
        values: { total: 5 },
      },
      EMPTY_SEQ
    );

    // A completely separate instance, as if the process had restarted.
    const second = fileStore(dir);
    const loaded = await second.load("orders:1");

    expect(loaded?.seq).toBe(0);
    expect(loaded?.events[0]).toMatchObject({
      to: "pending",
      values: { total: 5 },
    });
  });

  it("recovers its key list from the directory alone", async () => {
    const dir = freshDir();
    const first = fileStore(dir);

    for (const key of ["orders:1", "orders:2", "carts:9"]) {
      // biome-ignore lint/performance/noAwaitInLoops: writes land in order so the recovered key list is deterministic
      await first.append(
        key,
        {
          type: "transition",
          key,
          from: null,
          to: "a",
          seq: 0,
          at: 0,
          cause: { type: "init", id: "t1" },
          values: {},
        },
        EMPTY_SEQ
      );
    }

    expect(fileStore(dir).keys).toEqual(["carts:9", "orders:1", "orders:2"]);
  });

  it("keeps the readable key inside the file even though the filename is encoded", async () => {
    const dir = freshDir();
    const store = fileStore(dir);
    const key = "orders:tenant-a:42";

    await store.append(
      key,
      {
        type: "transition",
        key,
        from: null,
        to: "a",
        seq: 0,
        at: 0,
        cause: { type: "init", id: "t1" },
        values: {},
      },
      EMPTY_SEQ
    );

    // Encoding is a storage-layout detail. The key an operator reads is the real one.
    const events = await store.read(key);
    expect(events[0]).toMatchObject({ key });
    expect(store.keys).toEqual([key]);
  });

  it("shards logs by entity, so a scan reads one directory", async () => {
    const dir = freshDir();
    const store = fileStore(dir);

    for (const key of ["orders:1", "carts:9"]) {
      // biome-ignore lint/performance/noAwaitInLoops: writes land in order so the recovered key list is deterministic
      await store.append(
        key,
        {
          type: "transition",
          key,
          from: null,
          to: "a",
          seq: 0,
          at: 0,
          cause: { type: "init", id: "t1" },
          values: {},
        },
        EMPTY_SEQ
      );
    }

    expect(existsSync(join(dir, "orders"))).toBe(true);
    expect(existsSync(join(dir, "carts"))).toBe(true);

    const found = await store.scan({ entity: "orders", now: 0 });
    expect(found.matches.map((match) => match.key)).toEqual(["orders:1"]);
  });

  it("reports no keys when it has been constructed but never written to", () => {
    // An empty store, not a broken one.
    expect(fileStore(freshDir()).keys).toEqual([]);
  });

  it("ignores files an application keeps alongside its logs", async () => {
    const dir = freshDir();
    const store = fileStore(dir);

    await store.append(
      "orders:1",
      {
        type: "transition",
        key: "orders:1",
        from: null,
        to: "a",
        seq: 0,
        at: 0,
        cause: { type: "init", id: "t1" },
        values: {},
      },
      EMPTY_SEQ
    );

    // The example app puts its audit log beside the entity directories. A stray file must
    // not be walked as though it were an entity, nor stop the walk.
    writeFileSync(join(dir, "audit.jsonl"), "{}\n", "utf8");

    expect(store.keys).toEqual(["orders:1"]);
  });

  it("does not mistake a snapshot file for another key", async () => {
    const dir = freshDir();
    const store = fileStore(dir);

    await store.append(
      "orders:1",
      {
        type: "transition",
        key: "orders:1",
        from: null,
        to: "a",
        seq: 0,
        at: 0,
        cause: { type: "init", id: "t1" },
        values: {},
      },
      EMPTY_SEQ
    );
    await store.snapshot("orders:1", {
      key: "orders:1",
      entity: "orders",
      state: "a",
      values: {},
      seq: 0,
      at: 0,
      enteredAt: 0,
    });

    // A snapshot sits beside its log in the same directory, so the key list has to be able
    // to tell them apart. Counting it would invent a key nobody ever wrote.
    expect(store.keys).toEqual(["orders:1"]);
  });

  it("scans an entity that has no instances yet", async () => {
    const dir = freshDir();
    const store = fileStore(dir);

    await store.append(
      "orders:1",
      {
        type: "transition",
        key: "orders:1",
        from: null,
        to: "a",
        seq: 0,
        at: 0,
        cause: { type: "init", id: "t1" },
        values: {},
      },
      EMPTY_SEQ
    );

    // `logs/` exists, but nothing has ever been a cart. No directory, and no matches, and
    // in particular not an error: an entity with no instances is the normal early state.
    const found = await store.scan({ entity: "carts", now: 0 });
    expect(found.matches).toEqual([]);
    expect(found.complete).toBe(true);
  });
});

describe("how the file store names its files", () => {
  const created = (key: string): TransitionEvent => ({
    type: "transition",
    key,
    from: null,
    to: "a",
    seq: 0,
    at: 0,
    cause: { type: "init", id: "t0" },
    values: { owner: key },
  });

  /** Write a log the way a version before case-safe names would have. */
  const writeEarlier = (dir: string, key: string): string => {
    const entity = join(dir, encodeURIComponent(entityOf(key)));
    mkdirSync(entity, { recursive: true });
    const path = join(entity, `${encodeURIComponent(key)}.jsonl`);
    writeFileSync(path, `${JSON.stringify(created(key))}\n`);
    return path;
  };

  it("keeps two keys that differ only in case in two files", async () => {
    const dir = freshDir();
    const store = fileStore(dir);

    await store.append("orders:ABC", created("orders:ABC"), EMPTY_SEQ);
    await store.append("orders:abc", created("orders:abc"), EMPTY_SEQ);

    const names = readdirSync(join(dir, "orders"));
    expect(names).toHaveLength(2);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(2);

    const reopened = fileStore(dir);
    expect((await reopened.load("orders:ABC"))?.events[0]).toMatchObject({
      values: { owner: "orders:ABC" },
    });
    expect((await reopened.load("orders:abc"))?.events[0]).toMatchObject({
      values: { owner: "orders:abc" },
    });

    await reopened.forget("orders:abc");
    expect(await reopened.load("orders:ABC")).toBeDefined();
  });

  it("lists exactly the keys it was given, whatever they contain", async () => {
    const dir = freshDir();
    const store = fileStore(dir);
    const keys = [
      "orders:Tenant-A:42",
      "orders:%41",
      "orders:ünïcode",
      "orders:a.b",
      "orders:..x",
      "orders:a_b-c",
      "Orders:1",
    ];

    await Promise.all(
      keys.map((key) => store.append(key, created(key), EMPTY_SEQ))
    );

    expect(fileStore(dir).keys).toEqual([...keys].sort());
    expect(
      (await fileStore(dir).scan({ entity: "orders", now: 0 })).matches
    ).toHaveLength(6);
  });

  it("never names a file outside its directory, whatever the key", async () => {
    const dir = freshDir();
    const store = fileStore(join(dir, "logs"));

    // Named the way an earlier version would have named a log for `..:x`, and sitting
    // where that version's directory for the entity `..` would be: above the store.
    const outside = join(dir, "..%3Ax.jsonl");
    writeFileSync(outside, `${JSON.stringify(created("..:x"))}\n`);

    await store.append("..:x", created("..:x"), EMPTY_SEQ);
    await store.append(".:x", created(".:x"), EMPTY_SEQ);

    expect(readdirSync(dir).sort()).toEqual(["..%3Ax.jsonl", "logs"]);
    expect(readFileSync(outside, "utf8")).toBe(
      `${JSON.stringify(created("..:x"))}\n`
    );
    expect(readdirSync(join(dir, "logs")).sort()).toEqual(["%2E", "%2E%2E"]);
    expect(store.keys).toEqual(["..:x", ".:x"]);
  });

  it("refuses a key that is not well-formed text, which would share a file with another", async () => {
    const dir = freshDir();
    const store = fileStore(dir);
    const half = "orders:\ud83d";
    const replacement = "orders:\ufffd";
    await store.append(replacement, created(replacement), EMPTY_SEQ);

    const refusals = await Promise.all(
      [
        store.append(half, created(half), EMPTY_SEQ),
        store.load(half),
        store.read(half),
        store.forget(half),
      ].map((attempt) =>
        attempt.then(
          () => "resolved",
          (reason: EkmanError) => reason.code
        )
      )
    );

    expect(refusals).toEqual(new Array(4).fill("INVALID_KEY"));
    expect((await store.load(replacement))?.seq).toBe(0);
    expect(store.keys).toEqual([replacement]);
  });

  it("snapshots and compacts a key whose name is as long as a name may be", async () => {
    const dir = freshDir();
    const store = fileStore(dir, { retention: { perLogBytes: 64 } });
    const key = `orders:${"a".repeat(231)}`;
    expect(nameOf(key)).toHaveLength(240);

    await store.append(key, created(key), EMPTY_SEQ);
    await store.snapshot(key, {
      key,
      entity: "orders",
      state: "a",
      values: {},
      seq: 0,
      at: 0,
      enteredAt: 0,
    });
    await store.append(key, { ...created(key), from: "a", seq: 1 }, 0);

    expect(store.lastHousekeepingError).toBeUndefined();
    expect((await store.load(key))?.snapshot?.seq).toBe(1);
    expect(readdirSync(join(dir, "orders")).sort()).toEqual([
      `${nameOf(key)}.jsonl`,
      `${nameOf(key)}.snapshot.json`,
    ]);
  });

  it("refuses a key whose name would not fit in a filename", async () => {
    const dir = freshDir();
    const store = fileStore(dir);
    const key = `orders:${"A".repeat(80)}`;
    const refused = (attempt: Promise<unknown>) =>
      attempt.then(
        () => "resolved",
        (reason: EkmanError) => reason.code
      );

    expect(await refused(store.append(key, created(key), EMPTY_SEQ))).toBe(
      "INVALID_KEY"
    );
    expect(await refused(store.load(key))).toBe("INVALID_KEY");
    expect(await refused(store.read(key))).toBe("INVALID_KEY");
    expect(await refused(store.forget(key))).toBe("INVALID_KEY");
    expect(
      await refused(
        store.snapshot(key, {
          key,
          entity: "orders",
          state: "a",
          values: {},
          seq: 0,
          at: 0,
          enteredAt: 0,
        })
      )
    ).toBe("INVALID_KEY");
    expect(readdirSync(dir)).toEqual([]);

    const error = await store.load(key).catch((err: EkmanError) => err);
    expect((error as EkmanError).key).toBe(key);
    expect((error as EkmanError).message).toContain("limit is 240");
  });

  describe("reading what an earlier version wrote", () => {
    it("renames a log and its snapshot to the current scheme and keeps both", async () => {
      const dir = freshDir();
      const earlier = writeEarlier(dir, "orders:Abc");
      writeFileSync(
        earlier.replace(".jsonl", ".snapshot.json"),
        JSON.stringify({
          key: "orders:Abc",
          entity: "orders",
          state: "a",
          values: { owner: "orders:Abc" },
          seq: 0,
          at: 0,
          enteredAt: 0,
        })
      );

      const store = fileStore(dir);
      const loaded = await store.load("orders:Abc");

      expect(loaded?.seq).toBe(0);
      expect(loaded?.snapshot?.values).toEqual({ owner: "orders:Abc" });
      expect(readdirSync(join(dir, "orders")).sort()).toEqual([
        "orders%3A%41bc.jsonl",
        "orders%3A%41bc.snapshot.json",
      ]);

      await store.append(
        "orders:Abc",
        { ...created("orders:Abc"), from: "a", seq: 1 },
        0
      );
      expect((await fileStore(dir).read("orders:Abc")).length).toBe(2);
    });

    it("does not hand one key the file an earlier version wrote for its case variant", async () => {
      const dir = freshDir();
      writeEarlier(dir, "orders:Abc");
      const store = fileStore(dir);

      // Asked for first, and where case is ignored its own name opens the other's file.
      expect(await store.load("orders:abc")).toBeUndefined();

      await store.append("orders:abc", created("orders:abc"), EMPTY_SEQ);
      expect((await store.load("orders:Abc"))?.events[0]).toMatchObject({
        values: { owner: "orders:Abc" },
      });
      expect((await store.load("orders:abc"))?.events).toHaveLength(1);
    });

    it("moves an entity whose directory name changed, and removes the old directory", async () => {
      const dir = freshDir();
      writeEarlier(dir, "Orders:1");
      writeEarlier(dir, "a.b:1");

      const store = fileStore(dir);

      expect(store.keys).toEqual(["Orders:1", "a.b:1"]);
      expect(readdirSync(dir).sort()).toEqual(["%4Frders", "a%2Eb"]);
      expect((await store.load("Orders:1"))?.seq).toBe(0);
    });

    it("finds an entity's earlier directory when asked for one of its keys", async () => {
      const dir = freshDir();
      writeEarlier(dir, "Orders:1");

      expect((await fileStore(dir).load("Orders:1"))?.seq).toBe(0);
      expect(
        (await fileStore(dir).scan({ entity: "Orders", now: 0 })).matches
      ).toHaveLength(1);
    });

    it("leaves a directory in place while anything else is still in it", async () => {
      const dir = freshDir();
      writeEarlier(dir, "a.b:1");
      writeFileSync(join(dir, "a.b", "notes.txt"), "not a log");

      expect((await fileStore(dir).load("a.b:1"))?.seq).toBe(0);
      expect(readdirSync(join(dir, "a.b"))).toEqual(["notes.txt"]);
    });

    it("refuses to choose when a key has a file under each scheme", async () => {
      const dir = freshDir();
      const earlier = writeEarlier(dir, "orders:Abc");
      const current = logPathOf(dir, "orders:Abc");
      writeFileSync(current, `${JSON.stringify(created("orders:Abc"))}\n`);
      const store = fileStore(dir);

      const error = await store.load("orders:Abc").catch((err) => err);

      expect(error.code).toBe("STORE_UNAVAILABLE");
      expect(error.key).toBe("orders:Abc");
      expect(error.message).toMatch(TWO_FILES);
      expect(error.message).not.toContain(dir);
      expect(existsSync(earlier)).toBe(true);
      expect(existsSync(current)).toBe(true);

      // Not remembered as done: the next attempt checks again, and succeeds once the
      // duplicate is gone.
      rmSync(earlier);
      expect((await store.load("orders:Abc"))?.seq).toBe(0);
    });

    it("refuses an entity's directory over an earlier file whose key no longer fits in a name", async () => {
      const dir = freshDir();
      const long = `orders:${"A".repeat(100)}`;
      const earlier = writeEarlier(dir, long);
      const store = fileStore(dir);

      const error = await store.load("orders:1").catch((err) => err);

      expect(error.code).toBe("STORE_UNAVAILABLE");
      expect(error.key).toBe(long);
      expect(error.message).toMatch(TOO_LONG_TO_RENAME);
      expect(error.message).not.toContain(dir);
      expect(existsSync(earlier)).toBe(true);

      rmSync(earlier);
      expect(await store.load("orders:1")).toBeUndefined();
    });

    it("refuses it over an earlier file that is too long under a name both schemes share", async () => {
      const dir = freshDir();
      // Lowercase letters are written the same way by both schemes, and an earlier
      // version had no limit on how many.
      const long = `orders:${"a".repeat(232)}`;
      const earlier = writeEarlier(dir, long);
      const store = fileStore(dir);

      const error = await store.load("orders:1").catch((err) => err);

      expect(error.code).toBe("STORE_UNAVAILABLE");
      expect(error.key).toBe(long);
      expect(error.message).toMatch(TOO_LONG_AS_IT_IS);
      expect(existsSync(earlier)).toBe(true);

      rmSync(earlier);
      expect(await store.load("orders:1")).toBeUndefined();
    });

    it("leaves alone a file whose home is the same path in another case", async () => {
      const dir = freshDir();
      mkdirSync(join(dir, "Orders"));
      const path = join(dir, "Orders", "orders%3Ab.jsonl");
      writeFileSync(path, `${JSON.stringify(created("orders:b"))}\n`);

      expect(await fileStore(dir).load("Orders:1")).toBeUndefined();
      expect(existsSync(path)).toBe(true);
    });

    it("ignores names it did not give", async () => {
      const dir = freshDir();
      const store = fileStore(dir);
      await store.append("orders:1", created("orders:1"), EMPTY_SEQ);

      const strays = [
        "README.jsonl",
        "100%zz.jsonl",
        "orders%3a2.jsonl",
        "invoices%3A1.jsonl",
        "café.jsonl",
        "orders%3A1.jsonl.tmp",
      ];
      for (const stray of strays) {
        writeFileSync(join(dir, "orders", stray), "{}\n");
      }

      const reopened = fileStore(dir);
      expect(reopened.keys).toEqual(["orders:1"]);
      expect(
        (await reopened.scan({ entity: "orders", now: 0 })).matches
      ).toHaveLength(1);
      expect(readdirSync(join(dir, "orders")).sort()).toEqual(
        [...strays, "orders%3A1.jsonl"].sort()
      );
    });
  });

  describe("permissions", () => {
    const bitsOf = (path: string): number =>
      statSync(path).mode % PERMISSION_RANGE;

    it.skipIf(process.platform === "win32")(
      "creates files and directories for their owner only",
      async () => {
        const dir = join(freshDir(), "logs");
        const store = fileStore(dir);

        await store.append("orders:1", created("orders:1"), EMPTY_SEQ);
        await store.snapshot("orders:1", {
          key: "orders:1",
          entity: "orders",
          state: "a",
          values: {},
          seq: 0,
          at: 0,
          enteredAt: 0,
        });

        expect(bitsOf(dir)).toBe(OWNER_ONLY_DIR);
        expect(bitsOf(join(dir, "orders"))).toBe(OWNER_ONLY_DIR);
        expect(bitsOf(logPathOf(dir, "orders:1"))).toBe(OWNER_ONLY_FILE);
        expect(bitsOf(snapshotPathOf(dir, "orders:1"))).toBe(OWNER_ONLY_FILE);
      }
    );

    it.skipIf(process.platform === "win32")(
      "uses the modes it was given",
      async () => {
        const dir = join(freshDir(), "logs");
        const store = fileStore(dir, {
          mode: { file: GROUP_READABLE_FILE, dir: GROUP_READABLE_DIR },
        });

        await store.append("orders:1", created("orders:1"), EMPTY_SEQ);

        expect(bitsOf(join(dir, "orders"))).toBe(GROUP_READABLE_DIR);
        expect(bitsOf(logPathOf(dir, "orders:1"))).toBe(GROUP_READABLE_FILE);
      }
    );

    it.each([-1, 0o1000, 1.5, Number.NaN])(
      "refuses %s as permission bits",
      (bits) => {
        expect(() => fileStore(freshDir(), { mode: { file: bits } })).toThrow(
          PERMISSION_BITS
        );
        expect(() => fileStore(freshDir(), { mode: { dir: bits } })).toThrow(
          PERMISSION_BITS
        );
      }
    );
  });

  describe("options it does not have", () => {
    it.each([
      ["at the top level", { retenton: {} }],
      ["under retention", { retention: { perLogByte: 1 } }],
      ["under mode", { mode: { files: 0o600 } }],
    ])("are refused %s", (_where, options) => {
      const attempt = () => fileStore(freshDir(), options as object);

      expect(attempt).toThrow(UNKNOWN_OPTION);
      expect(attempt).toThrow(
        expect.objectContaining({ code: "INVALID_CONFIG" })
      );
    });

    it("are refused by the memory store too", () => {
      expect(() => memoryStore({ nmae: "cache" } as object)).toThrow(
        UNKNOWN_OPTION
      );
    });

    it("are refused through the runtime's store config", () => {
      expect(
        () =>
          new Ekman({
            store: { kind: "file", dir: freshDir(), retenton: {} } as never,
          })
      ).toThrow(UNKNOWN_OPTION);
    });
  });
});

describe("retention", () => {
  const move = (key: string, seq: number, values: Values): EkmanEvent => ({
    type: "transition",
    key,
    from: seq === 0 ? null : "a",
    to: "a",
    seq,
    at: seq,
    cause: { type: "poke", id: `t${seq}` },
    values,
  });

  /** Append `count` events to one key, each padded so the log grows predictably. */
  async function fill(
    store: FileStore,
    key: string,
    count: number,
    pad = 200
  ): Promise<void> {
    for (let seq = 0; seq < count; seq += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequence numbers have to land in order
      await store.append(
        key,
        move(key, seq, { blob: "x".repeat(pad) }),
        seq - 1
      );
    }
  }

  describe("what a bad configuration is told", () => {
    it("refuses a policy with no budget to act on", () => {
      expect(() =>
        fileStore(freshDir(), { retention: { policy: "reject" } })
      ).toThrow(NEEDS_BUDGET);
    });

    it("refuses a total budget that is not a byte count", () => {
      expect(() =>
        fileStore(freshDir(), { retention: { totalBytes: 10.5 } })
      ).toThrow(NEEDS_BYTE_COUNT);
    });

    it("refuses a policy it does not recognize", () => {
      expect(() =>
        fileStore(freshDir(), {
          retention: {
            totalBytes: 1024,
            policy: "evict" as RetentionPolicy,
          },
        })
      ).toThrow(NOT_A_POLICY);
    });

    it("does not offer to delete instances to make room", () => {
      // A store sees bytes and keys. Which instances no longer matter is a domain
      // question, so the policy that answered it from here is gone rather than inert:
      // a word that validates and does nothing is the failure this whole config refuses.
      expect(() =>
        fileStore(freshDir(), {
          retention: {
            totalBytes: 1024,
            policy: "forget" as RetentionPolicy,
          },
        })
      ).toThrow(NOT_A_POLICY);
    });

    it("refuses a byte count that is not one", () => {
      expect(() =>
        fileStore(freshDir(), { retention: { perLogBytes: -1 } })
      ).toThrow(NEEDS_BYTE_COUNT);
    });

    it("accepts a budget with no policy, which measures without enforcing", () => {
      const store = fileStore(freshDir(), { retention: { totalBytes: 1024 } });
      expect(store.usage.maxBytes).toBe(1024);
    });
  });

  describe("compaction", () => {
    it("folds an oversized log into a snapshot and keeps the state", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: 512 } });

      await fill(store, "orders:1", 12);
      await turn();

      // The state is whatever the last event said, regardless of what was folded away.
      const loaded = await store.load("orders:1");
      const current = replay(loaded as LoadResult);
      expect(current?.seq).toBe(11);
      expect(current?.values.blob).toBe("x".repeat(200));

      // And the log itself is now shorter than everything that was written to it.
      const events = await store.read("orders:1");
      expect(events.length).toBeLessThan(12);
      expect(loaded?.snapshot?.seq).toBeGreaterThan(0);
    });

    it("survives a reopen, so compaction is not a resident-only trick", async () => {
      const dir = freshDir();
      await fill(
        fileStore(dir, { retention: { perLogBytes: 512 } }),
        "orders:1",
        12
      );

      const reopened = fileStore(dir);
      const current = replay((await reopened.load("orders:1")) as LoadResult);

      expect(current?.seq).toBe(11);
      expect(current?.values.blob).toBe("x".repeat(200));

      // The sequence continues from where it was, rather than restarting at what survived.
      await reopened.append("orders:1", move("orders:1", 12, {}), 11);
      expect((await reopened.load("orders:1"))?.seq).toBe(12);
    });

    it("leaves a log alone when it holds nothing that could be snapshotted", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: 64 } });

      // Refusals only, so there is no state to fold into a snapshot. Dropping them would
      // destroy the only record that any of it happened.
      for (let seq = 0; seq < 6; seq += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: appends have to land in order
        await store.append(
          "orders:1",
          {
            type: "rejected",
            key: "orders:1",
            seq: EMPTY_SEQ,
            at: seq,
            code: "UNKNOWN_TRIGGER",
            reason: "never declared",
            cause: { type: "nonsense", id: `t${seq}` },
          },
          EMPTY_SEQ
        );
      }

      expect(await store.read("orders:1")).toHaveLength(6);
    });

    it("carries refusals through compaction and keeps the total honest", async () => {
      const dir = freshDir();
      // Bounded, so the byte accounting is live while compaction runs.
      const store = fileStore(dir, {
        retention: { perLogBytes: 512, totalBytes: 1024 * 1024 },
      });

      await store.append(
        "orders:1",
        {
          type: "rejected",
          key: "orders:1",
          seq: EMPTY_SEQ,
          at: 0,
          code: "UNKNOWN_TRIGGER",
          reason: "never declared",
          cause: { type: "nonsense", id: "t0" },
        },
        EMPTY_SEQ
      );
      await fill(store, "orders:1", 10);
      await turn();

      const events = await store.read("orders:1");

      // The transitions were folded into the snapshot. The refusal was not: it is not a
      // transition, so nothing about the snapshot accounts for it, and losing it would
      // erase the only record that the trigger was ever turned away.
      expect(events.filter((event) => event.type === "rejected")).toHaveLength(
        1
      );
      expect(
        events.filter((event) => event.type === "transition").length
      ).toBeLessThan(10);

      // And the accounted size followed the files rather than only ever growing. Both
      // files: compaction moves bytes out of the log and into the snapshot, so a total
      // that watched the log alone would report that move as space reclaimed while the
      // disk gave back nothing.
      expect(store.usage.bytes).toBe(onDisk(dir, "orders:1"));
    });

    it("reclaims across keys on a sweep, without a per-log limit to trigger it", async () => {
      const dir = freshDir();
      // `perLogBytes: 0` switches the per-log check off entirely, so nothing here compacts
      // on the commit path. The budget is the only thing that can act, and it acts on a
      // sweep. This is the case that used to validate and then do nothing.
      const store = fileStore(dir, {
        retention: { perLogBytes: 0, totalBytes: 2000, policy: "compact" },
      });

      for (const key of ["orders:1", "orders:2", "orders:3"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one key at a time keeps the byte totals predictable
        await fill(store, key, 8);
      }

      const before = store.usage.bytes;
      expect(before).toBeGreaterThan(2000);

      const swept = await store.compact();

      expect(swept.logs).toBeGreaterThan(0);
      expect(swept.reclaimed).toBeGreaterThan(0);
      expect(swept.withinBudget).toBe(true);
      expect(store.usage.bytes).toBeLessThan(before);
      expect(store.usage.bytes).toBeLessThanOrEqual(2000);

      // History is what it cost. State is not: every key still replays to where it was.
      for (const key of ["orders:1", "orders:2", "orders:3"]) {
        // biome-ignore lint/performance/noAwaitInLoops: one key at a time keeps failures attributable
        const current = replay((await store.load(key)) as LoadResult);
        expect(current?.seq).toBe(7);
        expect(current?.values.blob).toBe("x".repeat(200));
      }
    });

    it("says so when it reaches the floor still over budget", async () => {
      const dir = freshDir();
      // A budget below what the snapshots alone weigh. Compaction has a floor: folding a
      // log empties it but writes the state into a snapshot beside it, and that snapshot
      // is bytes on the same disk. A store that has hit the floor cannot sweep its way
      // under, and the number that proves it is only visible because the total counts
      // snapshots as well as logs.
      const store = fileStore(dir, {
        retention: { perLogBytes: 0, totalBytes: 1, policy: "compact" },
      });

      await fill(store, "orders:1", 6);
      await fill(store, "orders:2", 6);

      const first = await store.compact();
      expect(first.reclaimed).toBeGreaterThan(0);
      expect(first.withinBudget).toBe(false);

      // The second pass has nothing left to fold and reports that rather than spinning.
      const second = await store.compact();
      expect(second.logs).toBe(0);
      expect(second.reclaimed).toBe(0);
      expect(second.withinBudget).toBe(false);
    });

    it("counts a snapshot an earlier run left behind", async () => {
      const dir = freshDir();
      const first = fileStore(dir, { retention: { totalBytes: 4096 } });
      await fill(first, "orders:1", 3);
      await first.snapshot("orders:1", {
        key: "orders:1",
        entity: "orders",
        state: "moved",
        values: { blob: "x".repeat(200) },
        seq: 2,
        at: 2000,
        enteredAt: 2000,
      });

      // A store opened over the same directory counts nothing until something asks, and
      // then it walks the tree. Both files are there, and a walk that found only the logs
      // would report room the disk does not have.
      const reopened = fileStore(dir, { retention: { totalBytes: 4096 } });

      expect(reopened.usage.bytes).toBe(onDisk(dir, "orders:1"));
      expect(reopened.usage.bytes).toBeGreaterThan(
        readFileSync(logPathOf(dir, "orders:1")).byteLength
      );
    });

    it("reclaims nothing under a policy that was not asked to", async () => {
      const dir = freshDir();
      // `reject` refuses new keys at the budget and never rewrites what is there. Sweeping
      // it is not an error, because the runtime sweeps every layer without asking each one
      // what it was configured for.
      // Wide enough to admit the first key and far too small for four commits of it, so
      // the store is genuinely over budget without the first append being refused.
      const store = fileStore(dir, {
        retention: { perLogBytes: 0, totalBytes: 400, policy: "reject" },
      });
      await fill(store, "orders:1", 4);

      const swept = await store.compact();

      expect(swept.logs).toBe(0);
      expect(swept.reclaimed).toBe(0);
      // Measured from the real numbers rather than from an empty table, so an over-budget
      // store says so even though this policy will not act on it.
      expect(swept.withinBudget).toBe(false);
      expect(await store.read("orders:1")).toHaveLength(4);
    });

    it("replaces both files whole, and loses neither the state nor a violation", async () => {
      const dir = freshDir();
      const store = fileStore(dir, {
        retention: { totalBytes: 1, policy: "compact", perLogBytes: 0 },
      });
      await fill(store, "orders:1", 6);
      await store.append(
        "orders:1",
        {
          type: "violation",
          key: "orders:1",
          seq: 5,
          at: 99,
          constraint: { kind: "invariant", name: "bounded" },
          policy: "warn",
          reason: "over the line",
          cause: { type: "poke", id: "t99" },
        },
        5
      );
      const before = replay((await store.load("orders:1")) as LoadResult);

      const swept = await store.compact();

      expect(swept.logs).toBe(1);
      expect(readdirSync(join(dir, "orders")).sort()).toEqual([
        "orders%3A1.jsonl",
        "orders%3A1.snapshot.json",
      ]);
      const loaded = (await fileStore(dir).load("orders:1")) as LoadResult;
      expect(replay(loaded)).toEqual(before);
      expect(loaded.snapshot?.seq).toBe(5);
      expect((await store.read("orders:1")).map((event) => event.type)).toEqual(
        ["violation"]
      );
    });

    it("recovers from a compaction that stopped partway, at either file", async () => {
      const dir = freshDir();
      const store = fileStore(dir, {
        retention: { totalBytes: 1, policy: "compact", perLogBytes: 0 },
      });
      await fill(store, "orders:1", 6);
      await store.append(
        "orders:1",
        {
          type: "rejected",
          key: "orders:1",
          seq: 5,
          at: 99,
          code: "UNKNOWN_TRIGGER",
          reason: "nobody handles that",
          cause: { type: "nonsense", id: "t99" },
        },
        5
      );
      const before = replay((await store.load("orders:1")) as LoadResult);
      const log = logPathOf(dir, "orders:1");
      const snapshot = snapshotPathOf(dir, "orders:1");
      const reopened = async () => {
        const fresh = fileStore(dir);
        return {
          state: replay((await fresh.load("orders:1")) as LoadResult),
          kinds: (await fresh.read("orders:1")).map((event) => event.type),
          keys: fresh.keys,
        };
      };

      // A crash while the snapshot's temporary file was half written: the name is taken
      // and what is under it is not a snapshot.
      writeFileSync(temporaryOf(snapshot), '{"key":"orders:1","sta');
      expect(await reopened()).toEqual({
        state: before,
        kinds: [...new Array(6).fill("transition"), "rejected"],
        keys: ["orders:1"],
      });

      // The snapshot is replaced and then the log cannot be: a directory is in the way of
      // its temporary name. This is the state a crash between the two renames leaves.
      mkdirSync(temporaryOf(log));
      const failure = await store.compact().then(
        () => undefined,
        (error: EkmanError) => error
      );
      expect(failure?.code).toBe("STORE_UNAVAILABLE");
      expect(JSON.parse(readFileSync(snapshot, "utf8")).seq).toBe(5);
      expect(existsSync(temporaryOf(snapshot))).toBe(false);
      expect(await reopened()).toEqual({
        state: before,
        kinds: [...new Array(6).fill("transition"), "rejected"],
        keys: ["orders:1"],
      });

      // With the way clear the same compaction finishes, and the refusal is still there.
      rmdirSync(temporaryOf(log));
      expect((await store.compact()).logs).toBe(1);
      expect(await reopened()).toEqual({
        state: before,
        kinds: ["rejected"],
        keys: ["orders:1"],
      });
    });

    it.skipIf(process.platform === "win32")(
      "keeps a file as private as it was when compaction replaces it",
      async () => {
        const dir = freshDir();
        const store = fileStore(dir, {
          retention: { totalBytes: 1, policy: "compact", perLogBytes: 0 },
        });
        await fill(store, "orders:1", 4);
        await store.compact();
        for (let seq = 4; seq < 8; seq += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: appends have to land in order
          await store.append("orders:1", move("orders:1", seq, {}), seq - 1);
        }
        const log = logPathOf(dir, "orders:1");
        const snapshot = snapshotPathOf(dir, "orders:1");
        chmodSync(log, 0o600);
        chmodSync(snapshot, 0o600);
        // Left by a crash, and readable by everyone.
        writeFileSync(temporaryOf(snapshot), "{}", { mode: 0o644 });
        chmodSync(temporaryOf(snapshot), 0o644);

        expect((await store.compact()).logs).toBe(1);

        expect(permissionsOf(log)).toBe(0o600);
        expect(permissionsOf(snapshot)).toBe(0o600);
        expect((await store.load("orders:1"))?.snapshot?.seq).toBe(7);
      }
    );

    it("stops rewriting a log that holds nothing left to fold", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: 256 } });
      const refuse = (at: number): EkmanEvent => ({
        type: "rejected",
        key: "orders:1",
        seq: 0,
        at,
        code: "UNKNOWN_TRIGGER",
        reason: "x".repeat(200),
        cause: { type: "nonsense", id: `t${at}` },
      });
      await store.append("orders:1", move("orders:1", 0, {}), EMPTY_SEQ);
      await store.append("orders:1", refuse(1), 0);
      await store.append("orders:1", refuse(2), 0);
      await turn();
      const path = logPathOf(dir, "orders:1");
      expect((await store.load("orders:1"))?.snapshot?.seq).toBe(0);
      const { ino } = statSync(path);

      for (let at = 3; at < 13; at += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: appends have to land in order
        await store.append("orders:1", refuse(at), 0);
      }

      await turn();
      expect(statSync(path).ino).toBe(ino);
      expect(await store.read("orders:1")).toHaveLength(12);

      await store.append("orders:1", move("orders:1", 1, {}), 0);
      await turn();
      expect((await store.load("orders:1"))?.snapshot?.seq).toBe(1);
      expect(statSync(path).ino).not.toBe(ino);
    });

    it("keeps every event when compaction is switched off", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: 0 } });

      await fill(store, "orders:1", 12);

      expect(await store.read("orders:1")).toHaveLength(12);
    });

    it("keeps refusals that share a sequence with the snapshotted transition", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: 512 } });

      await fill(store, "orders:1", 10);
      // A rejection carries the sequence it followed rather than a new one, so it must not
      // be mistaken for something the snapshot already accounts for.
      await store.append(
        "orders:1",
        {
          type: "rejected",
          key: "orders:1",
          seq: 9,
          at: 99,
          code: "UNKNOWN_TRIGGER",
          reason: "the entity never declared this trigger",
          cause: { type: "nonsense", id: "t99" },
        },
        9
      );
      await fill(store, "orders:1", 0);

      const events = await store.read("orders:1");
      expect(events.some((event) => event.type === "rejected")).toBe(true);
    });
  });

  describe("the total budget", () => {
    it("reports what it holds, unbounded by default", async () => {
      const dir = freshDir();
      const store = fileStore(dir);

      expect(store.usage).toEqual({ bytes: 0, logs: 0, maxBytes: null });

      await fill(store, "orders:1", 3);

      expect(store.usage.logs).toBe(1);
      expect(store.usage.bytes).toBeGreaterThan(0);
    });

    it("counts a write once when a budget makes it start counting mid-flight", async () => {
      const dir = freshDir();
      // Bounded, so accounting switches on. Compaction off, so nothing can quietly correct
      // the total afterwards: the number has to be right the first time.
      const store = fileStore(dir, {
        retention: { totalBytes: 1024 * 1024, perLogBytes: 0 },
      });

      await fill(store, "orders:1", 1);

      expect(store.usage.bytes).toBe(
        readFileSync(logPathOf(dir, "orders:1")).byteLength
      );
    });

    it("gives the bytes back when a key is forgotten", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { totalBytes: 1024 * 1024 } });

      await fill(store, "orders:1", 3);
      await fill(store, "orders:2", 3);
      const both = store.usage.bytes;

      await store.forget("orders:1");

      // The budget has to fall as well as rise, or a store that churns keys would report
      // itself full while holding almost nothing.
      expect(store.usage.logs).toBe(1);
      expect(store.usage.bytes).toBeLessThan(both);
      expect(store.usage.bytes).toBe(
        readFileSync(logPathOf(dir, "orders:2")).byteLength
      );
    });

    it("lets a forgotten key be created again under a full budget", async () => {
      const dir = freshDir();
      const store = fileStore(dir, {
        retention: { totalBytes: 600, policy: "reject", perLogBytes: 0 },
      });

      await fill(store, "orders:1", 3);
      await expect(
        store.append("orders:2", move("orders:2", 0, {}), EMPTY_SEQ)
      ).rejects.toThrow(WHEN_FULL);

      // Forgetting the key that filled it makes room again, which is the whole point of
      // pairing a budget with retention rather than just refusing forever.
      await store.forget("orders:1");
      await expect(
        store.append("orders:2", move("orders:2", 0, {}), EMPTY_SEQ)
      ).resolves.toBeUndefined();
    });

    it("counts what was already on disk when it is first asked", async () => {
      const dir = freshDir();
      await fill(fileStore(dir), "orders:1", 3);

      // A brand new store over the same directory has counted nothing yet. Reading usage
      // is what seeds it, and it has to see the logs it inherited.
      const reopened = fileStore(dir);
      expect(reopened.usage.logs).toBe(1);
      expect(reopened.usage.bytes).toBeGreaterThan(0);
    });

    it("refuses a new instance once full, and lets existing ones continue", async () => {
      const dir = freshDir();
      const store = fileStore(dir, {
        retention: { totalBytes: 600, policy: "reject", perLogBytes: 0 },
      });

      await fill(store, "orders:1", 3);
      expect(store.usage.bytes).toBeGreaterThan(600);

      // The instance that already exists is untouched by the budget.
      await expect(
        store.append("orders:1", move("orders:1", 3, {}), 2)
      ).resolves.toBeUndefined();

      // A key this store has never seen is refused, and says so.
      await expect(
        store.append("orders:2", move("orders:2", 0, {}), EMPTY_SEQ)
      ).rejects.toThrow(WHEN_FULL);
    });

    it("does not count anything when nobody is measuring", async () => {
      // The accounting seeds lazily on purpose: a store with no budget that is never asked
      // about should not pay for a walk of every file it owns.
      const store = fileStore(freshDir());
      await fill(store, "orders:1", 2);

      expect(store.usage.logs).toBe(1);
    });
  });
});

describe("where a file store puts itself", () => {
  it("takes the directory it was given", () => {
    const dir = freshDir();
    expect(fileStore(dir).dir).toBe(dir);
  });

  it("takes a directory and options together", () => {
    const dir = freshDir();
    const store = fileStore(dir, { name: "cold" });
    expect(store.dir).toBe(dir);
    expect(store.name).toBe("cold");
  });

  it("defaults to the project's log directory, and creates it", () => {
    const store = fileStore();

    // `.ekman/logs`, not `.ekman`: the first level inside the namespace names what kind of
    // thing is kept there, so later features get a sibling rather than a nested surprise.
    expect(store.dir).toBe(defaultLogDir());
    expect(defaultLogDir()).toBe(join(defaultStoreDir(), "logs"));
    expect(existsSync(store.dir)).toBe(true);

    // Removed non-recursively, so this can only ever delete the empty directory it just
    // created and never a demo's or the example app's output.
    try {
      rmdirSync(store.dir);
    } catch {
      // Already holds something somebody else wrote. Leaving it is the correct outcome.
    }
  });

  it("names itself and claims authority without being given a directory", () => {
    const store = fileStore({ name: "hot", authority: true });

    expect(store.name).toBe("hot");
    expect(store.authority).toBe(true);
    expect(store.dir).toBe(defaultLogDir());

    try {
      rmdirSync(store.dir);
    } catch {
      // As above.
    }
  });
});

// An append that did not finish, which is what a full disk or a lost process leaves behind.
// The event it was writing never resolved to anyone, so losing it costs nothing; letting it
// make the whole key unreadable would cost everything.
describe("a log whose last append did not finish", () => {
  const event = (key: string, seq: number): EkmanEvent => ({
    type: "transition",
    key,
    from: null,
    to: "a",
    seq,
    at: 0,
    cause: { type: "init", id: `t${seq}` },
    values: {},
  });

  async function tornLog(): Promise<{ dir: string; path: string }> {
    const dir = freshDir();
    const store = fileStore(dir);
    await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);

    const path = logPathOf(dir, "orders:1");
    // A half-written line, exactly as a short write would leave it: no trailing newline.
    appendFileSync(path, '{"type":"transi', "utf8");
    return { dir, path };
  }

  it("reads the events that were written whole", async () => {
    const { dir } = await tornLog();

    const loaded = await fileStore(dir).load("orders:1");

    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.seq).toBe(0);
  });

  it("repairs the file, so the next append is not written onto the fragment", async () => {
    const { dir, path } = await tornLog();

    const store = fileStore(dir);
    await store.load("orders:1");
    await store.append("orders:1", event("orders:1", 1), 0);

    // Two whole lines and nothing else. Had the fragment survived, the second append would
    // have concatenated onto it and produced a corrupt line that was no longer last.
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((line: string) => JSON.parse(line).seq)).toEqual([0, 1]);
  });

  it("still refuses a corrupt line that was written whole", async () => {
    const dir = freshDir();
    const store = fileStore(dir);
    await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);

    // Newline-terminated, so it landed intact and something else damaged it. Reporting that
    // as a healthy shorter log would hide real corruption.
    appendFileSync(logPathOf(dir, "orders:1"), "not json at all\n", "utf8");

    const refusal = await fileStore(dir)
      .load("orders:1")
      .catch((error: unknown) => error as EkmanError);

    expect(refusal).toMatchObject({
      code: "STORE_UNAVAILABLE",
      key: "orders:1",
    });
    expect((refusal as EkmanError).message).toContain(
      'log for "orders:1" is corrupt at line 2'
    );
    expect((refusal as EkmanError).message).not.toContain(dir);
  });

  it.skipIf(CANNOT_DENY)(
    "trims the fragment its own failed write left, before appending again",
    async () => {
      const dir = freshDir();
      const store = fileStore(dir);
      await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);
      const path = logPathOf(dir, "orders:1");

      // Closed, so the next append has to open the log and is refused.
      await store.close();
      chmodSync(path, 0o400);
      const failed = await store
        .append("orders:1", event("orders:1", 1), 0)
        .catch((error: unknown) => error as EkmanError);
      chmodSync(path, 0o600);
      appendFileSync(path, '{"type":"transi', "utf8");

      expect(failed).toMatchObject({ code: "STORE_UNAVAILABLE" });
      await store.append("orders:1", event("orders:1", 1), 0);

      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      expect(lines.map((line: string) => JSON.parse(line).seq)).toEqual([0, 1]);
    }
  );
});

describe("the memory store's key list", () => {
  it("includes a key it holds only a snapshot of, once", async () => {
    const store = memoryStore();
    const snapshot: StoreSnapshot = {
      key: "orders:1",
      entity: "orders",
      state: "a",
      values: {},
      seq: 0,
      at: 0,
      enteredAt: 0,
    };
    await store.snapshot("orders:1", snapshot);
    await store.snapshot("orders:2", { ...snapshot, key: "orders:2" });
    await store.append(
      "orders:2",
      {
        type: "transition",
        key: "orders:2",
        from: "a",
        to: "a",
        seq: 1,
        at: 0,
        cause: { type: "tick", id: "t1" },
        values: {},
      },
      0
    );

    expect([...store.keys].sort()).toEqual(["orders:1", "orders:2"]);
    await store.forget("orders:1");
    expect(store.keys).toEqual(["orders:2"]);
  });
});

describe("a scan told which keys to leave out", () => {
  const stores: [string, () => Store][] = [
    ["memory", () => memoryStore()],
    ["file", () => fileStore(freshDir())],
  ];

  it.each(stores)("%s: does not load them", async (_name, make) => {
    const store = make();
    for (const key of ["orders:1", "orders:2", "orders:3"]) {
      // biome-ignore lint/performance/noAwaitInLoops: three appends, in order
      await store.append(
        key,
        {
          type: "transition",
          key,
          from: null,
          to: "a",
          seq: 0,
          at: 0,
          cause: { type: "init", id: "t0" },
          values: {},
        },
        EMPTY_SEQ
      );
    }

    const load = vi.spyOn(store, "load");
    const found = await store.scan({
      entity: "orders",
      now: 0,
      skip: new Set(["orders:2"]),
    });

    expect(found.matches.map((match) => match.key)).toEqual([
      "orders:1",
      "orders:3",
    ]);
    expect(found.complete).toBe(true);
    expect(load.mock.calls.map(([key]) => key)).toEqual([
      "orders:1",
      "orders:3",
    ]);
  });
});

describe("loading a key that has a snapshot", () => {
  const KEY = "orders:1";

  const event = (seq: number): EkmanEvent => ({
    type: "transition",
    key: KEY,
    from: seq === 0 ? null : "a",
    to: "a",
    seq,
    at: seq,
    cause: { type: "tick", id: `t${seq}` },
    // Multibyte on purpose: the place a load resumes from is a byte offset.
    values: { n: seq, note: "héllo ✓" },
  });

  const snapshotAt = (seq: number): StoreSnapshot => ({
    key: KEY,
    entity: "orders",
    state: "a",
    values: { n: seq, note: "héllo ✓" },
    seq,
    at: seq,
    enteredAt: 0,
  });

  /** A store holding events 0 to `last`, and a snapshot when asked for one. */
  async function filled(
    last: number,
    snapshot?: number
  ): Promise<{ dir: string; store: FileStore }> {
    const dir = freshDir();
    const store = fileStore(dir);
    for (let seq = 0; seq <= last; seq += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a log is written in order
      await store.append(KEY, event(seq), seq - 1);
    }
    if (snapshot !== undefined) {
      await store.snapshot(KEY, snapshotAt(snapshot));
    }
    return { dir, store };
  }

  /** Load, reporting how many documents were parsed to do it. */
  async function parsedBy(
    store: FileStore
  ): Promise<{ loaded: LoadResult | undefined; parsed: number }> {
    const parse = vi.spyOn(JSON, "parse");
    try {
      const loaded = await store.load(KEY);
      return { loaded, parsed: parse.mock.calls.length };
    } finally {
      parse.mockRestore();
    }
  }

  const seqs = (loaded: LoadResult | undefined): number[] =>
    (loaded?.events ?? []).map((found) => found.seq);

  it("returns the events after the snapshot", async () => {
    const { store } = await filled(9, 4);

    const loaded = await store.load(KEY);

    expect(loaded?.snapshot?.seq).toBe(4);
    expect(seqs(loaded)).toEqual([5, 6, 7, 8, 9]);
    expect(loaded?.seq).toBe(9);
  });

  it("parses the whole log once, and after that only what the snapshot does not cover", async () => {
    const { store } = await filled(9, 4);

    const first = await parsedBy(store);
    const second = await parsedBy(store);

    // The snapshot is one document. Then ten lines the first time and five the second.
    expect(first.parsed).toBe(11);
    expect(second.parsed).toBe(6);
    expect(second.loaded).toEqual(first.loaded);
  });

  it("reads none of the log when the snapshot covers all of it", async () => {
    const { store } = await filled(9, 9);
    await store.load(KEY);

    const { loaded, parsed } = await parsedBy(store);

    expect(parsed).toBe(1);
    expect(loaded?.events).toEqual([]);
    expect(loaded?.seq).toBe(9);
  });

  it("picks up its own appends, and stops reading them once a snapshot covers them", async () => {
    const { store } = await filled(9, 9);
    await store.load(KEY);

    await store.append(KEY, event(10), 9);
    const afterAppend = await parsedBy(store);
    expect(seqs(afterAppend.loaded)).toEqual([10]);
    expect(afterAppend.parsed).toBe(2);

    await store.snapshot(KEY, snapshotAt(10));
    // Read once more to learn the new snapshot covers it, then never again.
    expect((await parsedBy(store)).parsed).toBe(2);
    const settled = await parsedBy(store);
    expect(settled.parsed).toBe(1);
    expect(settled.loaded?.events).toEqual([]);
    expect(settled.loaded?.seq).toBe(10);
  });

  it("reads the whole log again when another store has written to it", async () => {
    const { dir, store } = await filled(9, 4);
    await store.load(KEY);

    await fileStore(dir).append(KEY, event(10), 9);

    const loaded = await store.load(KEY);
    expect(seqs(loaded)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(loaded?.seq).toBe(10);
  });

  it("leaves the next append knowing where the key is", async () => {
    const { dir, store } = await filled(1);
    await fileStore(dir).append(KEY, event(2), 1);

    // This store last saw the key at 1. Loading is what tells it otherwise.
    await store.load(KEY);

    await expect(store.append(KEY, event(3), 2)).resolves.toBeUndefined();
  });

  it("reads the whole log again when the snapshot is older than the one it remembers", async () => {
    const { dir, store } = await filled(9, 5);
    await store.load(KEY);

    writeFileSync(snapshotPathOf(dir, KEY), JSON.stringify(snapshotAt(2)));

    expect(seqs(await store.load(KEY))).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it("reports damage in the part it would have skipped to, by its real line", async () => {
    const { dir, store } = await filled(9, 4);
    await store.load(KEY);

    // The last line replaced by one of the same length, so the log's size says nothing.
    const path = logPathOf(dir, KEY);
    const lines = readFileSync(path, "utf8").split("\n");
    const last = lines.at(-2) ?? "";
    lines[lines.length - 2] = "x".repeat(Buffer.byteLength(last, "utf8"));
    writeFileSync(path, lines.join("\n"));

    const refusal = await store
      .load(KEY)
      .catch((error: unknown) => error as EkmanError);

    expect(refusal).toMatchObject({ code: "STORE_UNAVAILABLE", key: KEY });
    expect((refusal as EkmanError).message).toContain("corrupt at line 10");
  });

  it("answers from the snapshot alone when the log is gone", async () => {
    const { dir, store } = await filled(9, 9);
    await store.load(KEY);

    rmSync(logPathOf(dir, KEY));

    const loaded = await store.load(KEY);
    expect(loaded?.snapshot?.seq).toBe(9);
    expect(loaded?.events).toEqual([]);
    expect(loaded?.seq).toBe(9);
  });

  it("lists and counts a key it holds only a snapshot of, once", async () => {
    const dir = freshDir();
    const first = fileStore(dir);
    await first.snapshot("orders:only", {
      ...snapshotAt(3),
      key: "orders:only",
    });
    await first.append(KEY, event(0), EMPTY_SEQ);
    await first.snapshot(KEY, snapshotAt(0));

    // Wide enough for what is there and not for another key.
    const held =
      readFileSync(snapshotPathOf(dir, "orders:only")).byteLength +
      onDisk(dir, KEY);
    const store = fileStore(dir, {
      retention: { totalBytes: held, policy: "reject" },
    });

    expect(store.keys).toEqual([KEY, "orders:only"].sort());
    expect(store.usage.bytes).toBe(held);
    // It exists, so under a full budget it still commits where a new key is refused.
    await store.append("orders:only", { ...event(4), key: "orders:only" }, 3);
    const refused = await store
      .append("orders:new", { ...event(0), key: "orders:new" }, EMPTY_SEQ)
      .catch((error: EkmanError) => error.code);
    expect(refused).toBe("STORE_FULL");
  });

  it("starts over for a key that was forgotten and created again", async () => {
    const { store } = await filled(9, 4);
    await store.load(KEY);

    await store.forget(KEY);
    await store.append(KEY, event(0), EMPTY_SEQ);
    await store.append(KEY, event(1), 0);
    await store.snapshot(KEY, snapshotAt(0));

    const loaded = await store.load(KEY);
    expect(seqs(loaded)).toEqual([1]);
    expect(loaded?.seq).toBe(1);
  });

  it("starts over after compaction rewrites the log", async () => {
    const dir = freshDir();
    const width = Buffer.byteLength(`${JSON.stringify(event(0))}\n`, "utf8");
    const store = fileStore(dir, { retention: { perLogBytes: width * 4 } });
    for (let seq = 0; seq <= 2; seq += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a log is written in order
      await store.append(KEY, event(seq), seq - 1);
    }
    await store.snapshot(KEY, snapshotAt(1));
    expect(seqs(await store.load(KEY))).toEqual([2]);

    // Past the limit on the fifth line, so the log is folded into a snapshot at 4.
    await store.append(KEY, event(3), 2);
    await store.append(KEY, event(4), 3);
    await turn();
    await store.append(KEY, event(5), 4);

    const loaded = await store.load(KEY);
    expect(loaded?.snapshot?.seq).toBe(4);
    expect(seqs(loaded)).toEqual([5]);
    expect(replay(loaded as LoadResult)).toMatchObject({
      seq: 5,
      values: { n: 5 },
    });
  });
});

describe("the file store's commit path", () => {
  const event = (key: string, seq: number): TransitionEvent => ({
    type: "transition",
    key,
    from: seq === 0 ? null : "a",
    to: "a",
    seq,
    at: 0,
    cause: { type: "tick", id: `t${seq}` },
    values: { n: seq },
  });
  const WIDTH = Buffer.byteLength(
    `${JSON.stringify(event("orders:1", 0))}\n`,
    "utf8"
  );
  const lineCount = (dir: string, key: string): number =>
    readFileSync(logPathOf(dir, key), "utf8").split("\n").filter(Boolean)
      .length;

  describe("open logs", () => {
    it("never holds more open than it was told to", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { maxOpenLogs: 16 });
      let most = 0;

      for (let n = 0; n < 300; n += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one key at a time, so the count is read after each
        await store.append(`orders:${n}`, event(`orders:${n}`, 0), EMPTY_SEQ);
        most = Math.max(most, store.openLogs);
      }

      expect(most).toBe(16);
      expect(store.keys).toHaveLength(300);
      // The first key's log was closed long ago, and is opened again without being asked.
      await store.append("orders:0", event("orders:0", 1), 0);
      expect(lineCount(dir, "orders:0")).toBe(2);
      expect(store.openLogs).toBe(16);
      await store.close();
    });

    it("closes the log that has waited longest, not the one just used", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { maxOpenLogs: 2 });
      await store.append("orders:a", event("orders:a", 0), EMPTY_SEQ);
      await store.append("orders:b", event("orders:b", 0), EMPTY_SEQ);
      await store.append("orders:a", event("orders:a", 1), 0);
      await store.append("orders:c", event("orders:c", 0), EMPTY_SEQ);

      // `b` was the one closed, so removing its file and appending makes a new one. Had
      // it still been open, the append would have gone to the file that was removed.
      rmSync(logPathOf(dir, "orders:b"));
      await store.append("orders:b", event("orders:b", 1), 0);
      expect(lineCount(dir, "orders:b")).toBe(1);
      await store.close();
    });

    it.skipIf(CANNOT_DENY)(
      "makes room before it opens a log, so it never needs one descriptor past its limit",
      async () => {
        const dir = freshDir();
        const store = fileStore(dir, { maxOpenLogs: 1 });
        await store.append("orders:a", event("orders:a", 0), EMPTY_SEQ);
        await store.append("orders:b", event("orders:b", 0), EMPTY_SEQ);
        expect(store.openLogs).toBe(1);

        chmodSync(logPathOf(dir, "orders:a"), 0o400);
        try {
          const refused = await store
            .append("orders:a", event("orders:a", 1), 0)
            .catch((error: EkmanError) => error.code);
          expect(refused).toBe("STORE_UNAVAILABLE");
          // `b` had already been closed when opening `a` was tried and failed.
          expect(store.openLogs).toBe(0);
        } finally {
          chmodSync(logPathOf(dir, "orders:a"), 0o600);
        }

        await store.append("orders:a", event("orders:a", 1), 0);
        expect(lineCount(dir, "orders:a")).toBe(2);
        await store.close();
      }
    );

    it.each([0, -1, 1.5, "8"])("refuses a maxOpenLogs of %s", (maxOpenLogs) => {
      expect(() =>
        fileStore(freshDir(), { maxOpenLogs: maxOpenLogs as number })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_CONFIG",
          message: expect.stringContaining("positive integer"),
        })
      );
    });

    it("starts a fresh file for a key that was forgotten", async () => {
      const dir = freshDir();
      const store = fileStore(dir);
      await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);
      await store.append("orders:1", event("orders:1", 1), 0);

      await store.forget("orders:1");
      expect(store.openLogs).toBe(0);
      await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);

      expect(lineCount(dir, "orders:1")).toBe(1);
      expect((await store.load("orders:1"))?.seq).toBe(0);
      await store.close();
    });

    it("closes everything on close, and opens again when written to", async () => {
      const dir = freshDir();
      const store = fileStore(dir);
      await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);
      await store.append("orders:2", event("orders:2", 0), EMPTY_SEQ);
      expect(store.openLogs).toBe(2);

      await store.close();
      expect(store.openLogs).toBe(0);

      await store.append("orders:1", event("orders:1", 1), 0);
      expect(store.openLogs).toBe(1);
      expect(lineCount(dir, "orders:1")).toBe(2);
      await store.close();
      await store.close();
    });

    it("makes an entity's directory again if it has gone", async () => {
      const dir = freshDir();
      const store = fileStore(dir);
      await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);
      await store.close();

      rmSync(join(dir, "orders"), { recursive: true });
      await store.append("orders:2", event("orders:2", 0), EMPTY_SEQ);

      expect(lineCount(dir, "orders:2")).toBe(1);
      await store.close();
    });
  });

  describe("a log that passes its limit", () => {
    const LIMIT = WIDTH * 4;

    /** Append events `from` to `to` in order, with no turn of the event loop between. */
    async function append(
      store: FileStore,
      from: number,
      to: number
    ): Promise<void> {
      for (let seq = from; seq <= to; seq += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: a log is written in order
        await store.append("orders:1", event("orders:1", seq), seq - 1);
      }
    }

    it("is compacted after the commit that crossed it, not inside it", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: LIMIT } });

      await append(store, 0, 4);
      expect(existsSync(snapshotPathOf(dir, "orders:1"))).toBe(false);
      expect(lineCount(dir, "orders:1")).toBe(5);

      await turn();
      expect((await store.load("orders:1"))?.snapshot?.seq).toBe(4);
      expect(lineCount(dir, "orders:1")).toBe(0);
      await store.close();
    });

    it("keeps an append that landed while the compaction was waiting", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: LIMIT } });

      await append(store, 0, 5);
      await turn();
      await append(store, 6, 6);

      const loaded = await store.load("orders:1");
      expect(loaded?.snapshot?.seq).toBe(5);
      expect(loaded?.events.map((found) => found.seq)).toEqual([6]);
      expect(lineCount(dir, "orders:1")).toBe(1);
      await store.close();
    });

    it("is compacted inside a commit once it reaches twice its limit with no turn given", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: LIMIT } });
      let longest = 0;

      for (let seq = 0; seq < 40; seq += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: the point is a loop that never yields
        await store.append("orders:1", event("orders:1", seq), seq - 1);
        longest = Math.max(longest, lineCount(dir, "orders:1"));
      }

      // The limit is four lines, so the ninth is the first past twice that, and the commit
      // that writes it is the one that folds the log.
      expect(longest).toBeLessThanOrEqual(9);
      expect((await store.load("orders:1"))?.seq).toBe(39);
      await store.close();
    });

    it("is compacted by close, which leaves nothing scheduled", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: LIMIT } });
      await append(store, 0, 4);

      await store.close();

      expect(existsSync(snapshotPathOf(dir, "orders:1"))).toBe(true);
      expect(lineCount(dir, "orders:1")).toBe(0);
    });

    it("is compacted first by a sweep, whatever the policy, and counted in what it reports", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: LIMIT } });
      await append(store, 0, 4);
      const before = onDisk(dir, "orders:1");

      const swept = await store.compact();

      expect(existsSync(snapshotPathOf(dir, "orders:1"))).toBe(true);
      expect(swept.logs).toBe(1);
      expect(swept.reclaimed).toBe(before - onDisk(dir, "orders:1"));
      expect(swept.reclaimed).toBeGreaterThan(0);
      await store.close();
    });

    it.skipIf(CANNOT_DENY)(
      "has the new size written down even when the compacted log cannot be opened again",
      async () => {
        const dir = freshDir();
        const first = fileStore(dir);
        await first.append("orders:1", event("orders:1", 0), EMPTY_SEQ);
        await first.close();
        // The log exists and can be written to. What replaces it will be read-only.
        const store = fileStore(dir, {
          mode: { file: 0o400 },
          retention: { perLogBytes: LIMIT },
        });
        await append(store, 1, 4);
        expect(store.usage.bytes).toBe(onDisk(dir, "orders:1"));

        await turn();

        expect(store.lastHousekeepingError?.code).toBe("STORE_UNAVAILABLE");
        expect(lineCount(dir, "orders:1")).toBe(0);
        expect(store.usage.bytes).toBe(onDisk(dir, "orders:1"));
        expect(store.openLogs).toBe(0);
        await store.close();
      }
    );

    it("is not queued again after being forgotten", async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: LIMIT } });
      await append(store, 0, 4);

      await store.forget("orders:1");
      await turn();

      expect(store.lastHousekeepingError).toBeUndefined();
      expect(existsSync(snapshotPathOf(dir, "orders:1"))).toBe(false);
      await store.close();
    });

    it.skipIf(CANNOT_DENY)(
      "keeps the failure of a compaction that could not be done, and fails the sweep that tries again",
      async () => {
        const dir = freshDir();
        const store = fileStore(dir, { retention: { perLogBytes: LIMIT } });
        await append(store, 0, 4);
        chmodSync(join(dir, "orders"), 0o500);

        try {
          await turn();
          expect(store.lastHousekeepingError).toMatchObject({
            code: "STORE_UNAVAILABLE",
            key: "orders:1",
            message: expect.stringContaining("compact the log"),
          });

          await append(store, 5, 5);
          await expect(store.compact()).rejects.toMatchObject({
            code: "STORE_UNAVAILABLE",
            key: "orders:1",
          });
          // A sweep with nothing waiting says nothing about the failure before it.
          await store.compact();
          expect(store.lastHousekeepingError).toBeDefined();
        } finally {
          chmodSync(join(dir, "orders"), 0o700);
        }

        await append(store, 6, 6);
        await turn();
        expect(store.lastHousekeepingError).toBeUndefined();
        expect((await store.load("orders:1"))?.snapshot?.seq).toBe(6);
        await store.close();
      }
    );

    it.skipIf(CANNOT_DENY)(
      "keeps a landed append when the accounting after it fails",
      async () => {
        const dir = freshDir();
        const store = fileStore(dir, {
          retention: { totalBytes: 1024 * 1024 },
        });
        // Writable and searchable, not listable, so the first sum of the tree fails.
        chmodSync(dir, 0o300);

        try {
          await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);
          expect(store.lastHousekeepingError).toMatchObject({
            code: "STORE_UNAVAILABLE",
            key: "orders:1",
            message: expect.stringContaining("account for the log"),
          });
        } finally {
          chmodSync(dir, 0o700);
        }

        await store.append("orders:1", event("orders:1", 1), 0);
        expect(store.lastHousekeepingError).toBeUndefined();
        expect(store.usage.bytes).toBe(onDisk(dir, "orders:1"));
        await store.close();
      }
    );
  });
});

describe("a file store whose filesystem fails", () => {
  const init = (key: string): TransitionEvent => ({
    type: "transition",
    key,
    from: null,
    to: "a",
    seq: 0,
    at: 0,
    cause: { type: "init", id: "t0" },
    values: {},
  });

  it.skipIf(CANNOT_DENY)(
    "refuses an append with its own code and without the path",
    async () => {
      const dir = freshDir();
      const store = fileStore(dir);

      chmodSync(dir, 0o500);
      const refusal = await store
        .append("orders:1", init("orders:1"), EMPTY_SEQ)
        .catch((error: unknown) => error as EkmanError);
      chmodSync(dir, 0o700);

      expect(refusal).toMatchObject({
        code: "STORE_UNAVAILABLE",
        key: "orders:1",
      });
      expect((refusal as EkmanError).message).toContain('"orders:1" (EACCES)');
      expect((refusal as EkmanError).message).not.toContain(dir);
      expect(((refusal as EkmanError).cause as Error).message).toContain(dir);
    }
  );

  it.skipIf(CANNOT_DENY)("rejects a scan it cannot list", async () => {
    const dir = freshDir();
    const store = fileStore(dir);
    await store.append("orders:1", init("orders:1"), EMPTY_SEQ);

    chmodSync(join(dir, "orders"), 0o000);
    const refusal = await store
      .scan({ entity: "orders", now: 0 })
      .catch((error: unknown) => error as EkmanError);
    chmodSync(join(dir, "orders"), 0o700);

    expect(refusal).toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect((refusal as EkmanError).key).toBeUndefined();
  });

  it("wraps a failure that carries no system code", async () => {
    const store = fileStore(freshDir());

    const refusal = await store
      .append(
        "orders:1",
        { ...init("orders:1"), values: { count: 1n as unknown as number } },
        EMPTY_SEQ
      )
      .catch((error: unknown) => error as EkmanError);

    expect(refusal).toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect((refusal as EkmanError).message).toBe(
      'the file store could not append to the log of "orders:1".'
    );
    expect(await store.load("orders:1")).toBeUndefined();
  });

  it("refuses a snapshot that does not parse", async () => {
    const dir = freshDir();
    const store = fileStore(dir);
    await store.append("orders:1", init("orders:1"), EMPTY_SEQ);
    writeFileSync(snapshotPathOf(dir, "orders:1"), "{", "utf8");

    await expect(fileStore(dir).load("orders:1")).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
      message: 'the file store\'s snapshot for "orders:1" is corrupt.',
    });
  });

  it("refuses a directory it cannot create, and says which", () => {
    const dir = freshDir();
    const blocked = join(dir, "taken");
    writeFileSync(blocked, "", "utf8");

    expect(() => fileStore(join(blocked, "logs"))).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message: expect.stringContaining(join(blocked, "logs")),
      })
    );
  });

  it.skipIf(CANNOT_DENY)(
    "keeps a landed append when the compaction that follows it fails",
    async () => {
      const dir = freshDir();
      const store = fileStore(dir, { retention: { perLogBytes: 1 } });
      const step = (seq: number): TransitionEvent => ({
        ...init("orders:1"),
        from: "a",
        seq,
      });
      mkdirSync(join(dir, "orders"));
      writeFileSync(logPathOf(dir, "orders:1"), "", "utf8");
      chmodSync(join(dir, "orders"), 0o500);

      try {
        await store.append("orders:1", init("orders:1"), EMPTY_SEQ);
        await store.append("orders:1", step(1), 0);
        await turn();

        expect(store.lastHousekeepingError).toMatchObject({
          code: "STORE_UNAVAILABLE",
          key: "orders:1",
        });
        expect(store.lastHousekeepingError?.message).not.toContain(dir);
        expect((await store.load("orders:1"))?.events).toHaveLength(2);
      } finally {
        chmodSync(join(dir, "orders"), 0o700);
      }

      await store.append("orders:1", step(2), 1);
      await turn();
      expect(store.lastHousekeepingError).toBeUndefined();
      expect((await store.load("orders:1"))?.snapshot?.seq).toBe(2);
    }
  );
});
