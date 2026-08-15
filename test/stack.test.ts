import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isEkmanError } from "../src/errors";
import { resolveStack } from "../src/stack";
import type { Store } from "../src/store";
import { fileStore } from "../src/stores/file";
import { memoryStore } from "../src/stores/memory";

const dirs: string[] = [];
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
