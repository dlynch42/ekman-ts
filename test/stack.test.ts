import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isEkmanError } from "../src/errors";
import { createStore, resolveStack } from "../src/stack";
import type { Store } from "../src/store";
import { defaultLogDir, fileStore } from "../src/stores/file";
import { memoryStore } from "../src/stores/memory";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ekman-stack-"));
  dirs.push(dir);
  return dir;
}
const durable = (name?: string, authority?: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "ekman-stack-"));
  dirs.push(dir);
  return fileStore(dir, {
    ...(name === undefined ? {} : { name }),
    ...(authority === undefined ? {} : { authority }),
  });
};

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isEkmanError(error) ? error.code : "not-an-ekman-error";
  }
  return "no-throw";
};

describe("resolving a store stack", () => {
  it("is empty when no store is configured, which is a valid mode", () => {
    const stack = resolveStack(undefined);
    expect(stack.authority).toBeUndefined();
    expect(stack.layers).toEqual([]);
    expect(stack.durable).toBe(false);
  });

  it("refuses an empty list, which says nothing clearly", () => {
    // Omitting `store` says "memory only" unambiguously. An empty array is a mistake.
    expect(code(() => resolveStack([]))).toBe("INVALID_CONFIG");
  });

  it("makes a single layer the authority", () => {
    const only = memoryStore();
    const stack = resolveStack(only);

    expect(stack.authority).toBe(only);
    expect(stack.caches).toEqual([]);
    expect(stack.durable).toBe(false);
  });

  it("picks the last durable layer as the authority", () => {
    const cache = memoryStore();
    const truth = durable();
    const stack = resolveStack([cache, truth]);

    // A stack reads fastest to slowest, and the truth lives at the slow end.
    expect(stack.authority).toBe(truth);
    expect(stack.caches).toEqual([cache]);
    expect(stack.durable).toBe(true);
  });

  it("picks the last layer when none is durable", () => {
    const first = memoryStore({ name: "a" });
    const second = memoryStore({ name: "b" });

    expect(resolveStack([first, second]).authority).toBe(second);
    expect(resolveStack([first, second]).durable).toBe(false);
  });

  it("lets a layer claim authority explicitly", () => {
    const claimed = memoryStore({ name: "claimed", authority: true });
    const later = memoryStore({ name: "later" });
    const stack = resolveStack([claimed, later]);

    expect(stack.authority).toBe(claimed);
    expect(stack.caches).toEqual([later]);
  });

  it("refuses two layers both claiming authority", () => {
    expect(
      code(() =>
        resolveStack([
          memoryStore({ name: "a", authority: true }),
          memoryStore({ name: "b", authority: true }),
        ])
      )
    ).toBe("INVALID_CONFIG");
  });

  it("refuses two layers sharing a name", () => {
    // Names appear in telemetry and in query results, so they have to tell layers apart.
    expect(code(() => resolveStack([memoryStore(), memoryStore()]))).toBe(
      "INVALID_CONFIG"
    );
  });

  it("refuses an ephemeral authority sitting in front of a durable layer", () => {
    // This would make a durable store a cache of an ephemeral one: a restart silently
    // loses everything while a perfectly good store sits right there.
    expect(
      code(() =>
        resolveStack([
          durable("truth"),
          memoryStore({ name: "cache", authority: true }),
        ])
      )
    ).toBe("INVALID_CONFIG");
  });

  it("allows an ephemeral authority when nothing durable is configured", () => {
    const stack = resolveStack([
      memoryStore({ name: "a", authority: true }),
      memoryStore({ name: "b" }),
    ]);
    expect(stack.durable).toBe(false);
  });

  it("keeps the declared order in layers", () => {
    const a = memoryStore({ name: "a" });
    const b = memoryStore({ name: "b" });
    const c = durable("c");

    expect(resolveStack([a, b, c]).layers.map((l: Store) => l.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

// Naming a store instead of constructing one. The validation underneath is the same, so
// these cover the normalization rather than re-testing authority picking.
describe("stores described rather than constructed", () => {
  it("builds a named built-in", () => {
    const stack = resolveStack("memory");
    expect(stack.layers).toHaveLength(1);
    expect(stack.layers[0]?.name).toBe("memory");
    expect(stack.durable).toBe(false);
  });

  it("builds a layered stack from names, and still picks the durable authority", () => {
    const stack = resolveStack(["memory", { kind: "file", dir: freshDir() }]);
    expect(stack.layers.map((layer) => layer.name)).toEqual(["memory", "file"]);
    expect(stack.authority?.name).toBe("file");
    expect(stack.durable).toBe(true);
  });

  it("passes options through to the store it builds", () => {
    const stack = resolveStack({
      kind: "memory",
      name: "hot",
      authority: true,
    });
    expect(stack.authority?.name).toBe("hot");
  });

  it("mixes a described layer with an adapter it was handed", () => {
    // The escape hatch that keeps Redis and Postgres out of the `kind` union.
    const stack = resolveStack(["memory", durable("custom")]);
    expect(stack.layers.map((layer) => layer.name)).toEqual([
      "memory",
      "custom",
    ]);
    expect(stack.authority?.name).toBe("custom");
  });

  it('treats "none" as keeping nothing at all', () => {
    const stack = resolveStack("none");
    expect(stack.layers).toEqual([]);
    expect(stack.authority).toBeUndefined();
    expect(stack.durable).toBe(false);
  });

  it('refuses "none" beside a real layer', () => {
    // "no store, and also this store" is not a thing worth guessing at.
    expect(() => resolveStack(["none", "memory"])).toThrow(
      /cannot be combined/
    );
  });

  it("refuses a kind it does not build", () => {
    // Naming an adapter core does not ship has to fail loudly, rather than look configured.
    const build = () => resolveStack("redis" as "memory");
    expect(build).toThrow(/is not one this runtime builds/);
    try {
      build();
    } catch (error) {
      expect(isEkmanError(error) && error.code).toBe("INVALID_CONFIG");
    }
  });

  it("still refuses an empty list, which is a mistake rather than a choice", () => {
    expect(() => resolveStack([])).toThrow(/empty list/);
  });
});

describe("createStore", () => {
  it("builds a store that can be wrapped", () => {
    // The one seam for composition, now that naming is how stores get configured.
    const inner = createStore("memory");
    expect(inner.capabilities.durability).toBe("ephemeral");
  });

  it("refuses to build the absence of a store", () => {
    expect(() => createStore("none" as "memory")).toThrow(/names the absence/);
  });
});

describe("a described file store with no directory", () => {
  it("takes the project's default log directory", () => {
    const stack = resolveStack("file");
    expect(stack.authority?.name).toBe("file");
    expect(stack.durable).toBe(true);

    // Removed non-recursively, so this can only ever delete the empty directory it just
    // created and never a demo's or the example app's output.
    try {
      rmdirSync(defaultLogDir());
    } catch {
      // Already holds something somebody else wrote. Leaving it is correct.
    }
  });
});
