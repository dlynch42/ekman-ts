import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EMPTY_SEQ, fileStore, memoryStore } from "../src/index";
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
});
