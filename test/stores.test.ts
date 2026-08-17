import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EkmanEvent } from "../src/events";
import {
  defaultLogDir,
  defaultStoreDir,
  EMPTY_SEQ,
  entityOf,
  fileStore,
  memoryStore,
  projectRoot,
  STORE_DIR_NAME,
} from "../src/index";
import { storeContract } from "./store-contract";

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

  /** Where a key's log lives: sharded by entity, filename still the encoded key. */
  const logPath = (dir: string, key: string): string =>
    join(dir, entityOf(key), `${encodeURIComponent(key)}.jsonl`);

  async function tornLog(): Promise<{ dir: string; path: string }> {
    const dir = freshDir();
    const store = fileStore(dir);
    await store.append("orders:1", event("orders:1", 0), EMPTY_SEQ);

    const path = logPath(dir, "orders:1");
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
    appendFileSync(logPath(dir, "orders:1"), "not json at all\n", "utf8");

    expect(() => fileStore(dir).load("orders:1")).toThrow(SyntaxError);
  });
});
