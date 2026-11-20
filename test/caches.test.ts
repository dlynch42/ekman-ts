import { describe, expect, it, vi } from "vitest";
import type { CacheFailure, CacheSuspension } from "../src/caches";
import { Caches } from "../src/caches";
import type { EkmanEvent } from "../src/events";
import type { LoadResult, ReplayedState, Store } from "../src/store";
import { memoryStore } from "../src/stores/memory";

const STATE: ReplayedState = {
  state: "open",
  values: { n: 3 },
  seq: 3,
  enteredAt: 0,
};

/** A cache layer whose delete fails, so the first thing that goes wrong leaves it distrusted. */
function unclearable(): {
  layer: Store;
  snapshot: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
} {
  const inner = memoryStore({ name: "cache" });
  const snapshot = vi.fn(() => Promise.reject(new Error("no room")));
  const forget = vi.fn(() => Promise.reject(new Error("cannot delete")));
  const layer: Store = {
    name: inner.name,
    capabilities: inner.capabilities,
    append: inner.append.bind(inner),
    load: inner.load.bind(inner),
    read: inner.read.bind(inner),
    scan: inner.scan.bind(inner),
    snapshot,
    forget,
  };
  return { layer, snapshot, forget };
}

describe("a cache layer nobody can vouch for", () => {
  it("is not cleared again, and not filled again, for that key", async () => {
    const { layer, snapshot, forget } = unclearable();
    const failures: CacheFailure[] = [];
    const caches = new Caches([layer], {
      now: () => 0,
      failed: (failure) => failures.push(failure),
    });

    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");
    expect(failures.map((failure) => failure.error)).toEqual([
      "no room",
      "cannot delete",
    ]);

    caches.drop("orders:1", 3);
    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(2);
  });

  it("is still used for every other key", async () => {
    const { layer, snapshot } = unclearable();
    const caches = new Caches([layer], {
      now: () => 0,
      failed: () => undefined,
    });

    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");
    caches.refill("orders:2", STATE);
    await caches.settled("orders:2");

    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});

const committed = (seq: number): EkmanEvent => ({
  type: "transition",
  key: "orders:1",
  from: seq === 0 ? null : "open",
  to: "open",
  seq,
  at: 0,
  cause: { type: "touch", id: `t${seq}` },
  values: { n: seq },
});

/** One turn of the event loop, by which a queued write has reached its layer. */
const started = (): Promise<void> =>
  new Promise((done) => {
    setImmediate(done);
  });

/** A cache layer whose appends wait to be let go, one at a time, in the order they came. */
function held(): {
  layer: Store;
  append: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  release: (outcome?: Error) => void;
} {
  const inner = memoryStore({ name: "cache" });
  const waiting: ((outcome?: Error) => void)[] = [];
  const append = vi.fn(
    (key: string, event: EkmanEvent, expectedSeq: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        waiting.push((outcome) => {
          if (outcome === undefined) {
            inner.append(key, event, expectedSeq).then(resolve, reject);
          } else {
            reject(outcome);
          }
        });
      })
  );
  const load = vi.fn(inner.load.bind(inner));
  const snapshot = vi.fn(inner.snapshot.bind(inner));
  const forget = vi.fn(inner.forget.bind(inner));
  const layer: Store = {
    name: inner.name,
    capabilities: inner.capabilities,
    append,
    load,
    read: inner.read.bind(inner),
    scan: inner.scan.bind(inner),
    snapshot,
    forget,
  };
  return {
    layer,
    append,
    load,
    snapshot,
    forget,
    release: (outcome) => waiting.shift()?.(outcome),
  };
}

describe("a cache layer with writes still queued", () => {
  const answer: LoadResult = {
    snapshot: undefined,
    events: [committed(0)],
    seq: 0,
  };

  it("is passed over by a load, which the authority answers without waiting", async () => {
    const { layer, load, snapshot, release } = held();
    const caches = new Caches([layer], {
      now: () => 0,
      failed: () => undefined,
    });
    const fromAuthority = vi.fn(() => Promise.resolve(answer));
    caches.mirror(committed(0));

    const found = await caches.read("orders:1", fromAuthority);

    expect(found.current).toMatchObject({ state: "open", seq: 0 });
    expect(fromAuthority).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();

    // What the authority answered is filled in behind the write that was in the way.
    release();
    await caches.settled("orders:1");
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect((await layer.load("orders:1"))?.seq).toBe(0);
  });

  it("is asked again once nothing is queued", async () => {
    const { layer, load, release } = held();
    const caches = new Caches([layer], {
      now: () => 0,
      failed: () => undefined,
    });
    const fromAuthority = vi.fn(() => Promise.resolve(answer));
    caches.mirror(committed(0));
    await started();
    release();
    await caches.settled("orders:1");

    const found = await caches.read("orders:1", fromAuthority);

    expect(found.current).toMatchObject({ state: "open", seq: 0 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(fromAuthority).not.toHaveBeenCalled();
  });
});

describe("a cache layer that throws where it stands", () => {
  /** A store written without `async`: its failures are throws, not rejections. */
  function throwing(method: "append" | "snapshot" | "load"): {
    layer: Store;
    forget: ReturnType<typeof vi.fn>;
  } {
    const inner = memoryStore({ name: "cache" });
    const forget = vi.fn(inner.forget.bind(inner));
    const layer: Store = {
      name: inner.name,
      capabilities: inner.capabilities,
      append: inner.append.bind(inner),
      load: inner.load.bind(inner),
      read: inner.read.bind(inner),
      scan: inner.scan.bind(inner),
      snapshot: inner.snapshot.bind(inner),
      forget,
      [method]: () => {
        throw new Error(`${method} threw`);
      },
    };
    return { layer, forget };
  }
  const watched = (layer: Store) => {
    const failures: CacheFailure[] = [];
    const caches = new Caches([layer], {
      now: () => 0,
      failed: (failure) => failures.push(failure),
    });
    return { caches, failures };
  };

  it("is reported and cleared when the throw is from a write", async () => {
    const { layer, forget } = throwing("append");
    const { caches, failures } = watched(layer);

    caches.mirror(committed(0));
    await caches.settled("orders:1");

    expect(failures.map((failure) => failure.error)).toEqual(["append threw"]);
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("is reported and cleared when the throw is from a fill", async () => {
    const { layer, forget } = throwing("snapshot");
    const { caches, failures } = watched(layer);

    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");

    expect(failures.map((failure) => failure.error)).toEqual([
      "snapshot threw",
    ]);
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("is a miss when the throw is from a read, and the authority answers", async () => {
    const { layer } = throwing("load");
    const { caches, failures } = watched(layer);

    const found = await caches.read("orders:1", () =>
      Promise.resolve({ snapshot: undefined, events: [committed(0)], seq: 0 })
    );

    expect(found.current).toMatchObject({ state: "open", seq: 0 });
    expect(failures.map((failure) => failure.error)).toEqual(["load threw"]);
  });
});

describe("cache layers that are closing", () => {
  it("refuse a deletion that was still waiting, and do not run it", async () => {
    const { layer, forget, release } = held();
    const caches = new Caches([layer], {
      now: () => 0,
      failed: () => undefined,
    });
    caches.mirror(committed(0));
    await started();
    const forgotten = caches.forget("orders:1").catch((error) => error.code);

    caches.close();
    release();

    expect(await forgotten).toBe("RUNTIME_CLOSED");
    expect(forget).not.toHaveBeenCalled();
  });

  it("are not sent what was still queued for them", async () => {
    const { layer, append, release } = held();
    const caches = new Caches([layer], {
      now: () => 0,
      failed: () => undefined,
    });
    caches.mirror(committed(0));
    caches.mirror(committed(1));
    await started();
    expect(append).toHaveBeenCalledTimes(1);

    caches.close();
    release();
    await caches.settled("orders:1");

    expect(append).toHaveBeenCalledTimes(1);
  });

  it("are not cleared up after when a write under way fails", async () => {
    const { layer, forget, release } = held();
    const failures: CacheFailure[] = [];
    const caches = new Caches([layer], {
      now: () => 0,
      failed: (failure) => failures.push(failure),
    });
    caches.mirror(committed(0));
    await started();

    caches.close();
    release(new Error("closed underneath"));
    await caches.settled("orders:1");

    expect(failures).toEqual([]);
    expect(forget).not.toHaveBeenCalled();
  });
});

describe("a cache layer that does not answer", () => {
  const BOUND_MS = 5;
  /** Long enough for a call to have run out of time, and for what follows to settle. */
  const outlasted = (): Promise<void> =>
    new Promise((done) => {
      setTimeout(done, BOUND_MS * 4);
    });

  /** A cache layer whose named calls stay pending until they are let go. */
  function silent(...methods: ("append" | "snapshot" | "load" | "forget")[]): {
    layer: Store;
    inner: Store;
    calls: Record<"append" | "snapshot" | "load" | "forget", number>;
    answer: () => void;
  } {
    const inner = memoryStore({ name: "silent" });
    const calls = { append: 0, snapshot: 0, load: 0, forget: 0 };
    const waiting: (() => void)[] = [];
    const through =
      <A extends unknown[], R>(
        method: "append" | "snapshot" | "load" | "forget",
        call: (...args: A) => Promise<R>
      ) =>
      (...args: A): Promise<R> => {
        calls[method] += 1;
        if (!methods.includes(method)) {
          return call(...args);
        }
        return new Promise<R>((resolve, reject) => {
          waiting.push(() => call(...args).then(resolve, reject));
        });
      };
    const layer: Store = {
      name: inner.name,
      capabilities: inner.capabilities,
      append: through("append", inner.append.bind(inner)),
      load: through("load", inner.load.bind(inner)),
      read: inner.read.bind(inner),
      scan: inner.scan.bind(inner),
      snapshot: through("snapshot", inner.snapshot.bind(inner)),
      forget: through("forget", inner.forget.bind(inner)),
    };
    return { layer, inner, calls, answer: () => waiting.shift()?.() };
  }

  const watched = (...layers: Store[]) => {
    const failures: CacheFailure[] = [];
    const suspensions: CacheSuspension[] = [];
    const caches = new Caches(layers, {
      now: () => 0,
      failed: (failure) => failures.push(failure),
      timeoutMs: BOUND_MS,
      suspended: (suspension) => suspensions.push(suspension),
    });
    return { caches, failures, suspensions };
  };

  const answer: LoadResult = {
    snapshot: undefined,
    events: [committed(0)],
    seq: 0,
  };

  it("is a miss when a read runs out of time, and the authority answers", async () => {
    const { layer } = silent("load");
    const { caches, failures } = watched(layer);

    const found = await caches.read("orders:1", () => Promise.resolve(answer));

    expect(found.current).toMatchObject({ state: "open", seq: 0 });
    expect(failures).toEqual([
      {
        key: "orders:1",
        store: "silent",
        error: `cache layer "silent" did not answer within ${BOUND_MS}ms, so it was not waited for`,
        seq: -1,
      },
    ]);
  });

  it("does not hold up the layers beside it, or the writes behind it", async () => {
    const { layer, calls } = silent("append");
    const healthy = memoryStore({ name: "healthy" });
    const { caches, failures } = watched(layer, healthy);

    caches.mirror(committed(0));
    caches.mirror(committed(1));
    await caches.settled("orders:1");

    expect((await healthy.load("orders:1"))?.seq).toBe(1);
    expect(failures.map((failure) => failure.store)).toEqual(["silent"]);
    // The write that ran out left the layer out for the key, so the next was not sent.
    expect(calls.append).toBe(1);
  });

  it("is not read for the key while its write may still land", async () => {
    const { layer, calls } = silent("append");
    const { caches } = watched(layer);
    caches.mirror(committed(0));
    await caches.settled("orders:1");

    await caches.read("orders:1", () => Promise.resolve(answer));
    await caches.settled("orders:1");

    expect(calls.load).toBe(0);
    expect(calls.snapshot).toBe(0);
    expect(calls.forget).toBe(0);
  });

  it("is cleared once a late write lands, and filled again by the next load", async () => {
    const { layer, inner, calls, answer: land } = silent("append");
    const { caches } = watched(layer);
    caches.mirror(committed(0));
    await caches.settled("orders:1");

    land();
    await started();
    await caches.settled("orders:1");

    expect(calls.forget).toBe(1);
    expect(await inner.load("orders:1")).toBeUndefined();

    await caches.read("orders:1", () => Promise.resolve(answer));
    await caches.settled("orders:1");
    expect((await inner.load("orders:1"))?.seq).toBe(0);
  });

  it("stays left out after a deletion the caller asked for, until its late write lands", async () => {
    const { layer, inner, calls, answer: land } = silent("append");
    const { caches } = watched(layer);
    caches.mirror(committed(0));
    await caches.settled("orders:1");

    await caches.forget("orders:1");
    // The write is still out there, so the layer is not filled or read for the key.
    await caches.read("orders:1", () => Promise.resolve(answer));
    await caches.settled("orders:1");
    expect(calls.load).toBe(0);
    expect(calls.snapshot).toBe(0);

    // It lands after the deletion, and is deleted again.
    land();
    await started();
    await caches.settled("orders:1");
    expect(calls.forget).toBe(2);
    expect(await inner.load("orders:1")).toBeUndefined();

    await caches.read("orders:1", () => Promise.resolve(answer));
    await caches.settled("orders:1");
    expect((await inner.load("orders:1"))?.seq).toBe(0);
  });

  it("is left out for a key whose delete ran out of time", async () => {
    const { layer, calls } = silent("forget");
    const { caches, failures } = watched(layer);

    caches.drop("orders:1", 0);
    await caches.settled("orders:1");
    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");

    expect(failures).toHaveLength(1);
    expect(calls.snapshot).toBe(0);
  });

  it("fails a deletion the caller asked for, when that runs out of time", async () => {
    const { layer, calls } = silent("forget");
    const { caches } = watched(layer);

    await expect(caches.forget("orders:1")).rejects.toThrow(
      "did not answer within"
    );

    caches.refill("orders:1", STATE);
    await caches.settled("orders:1");
    expect(calls.snapshot).toBe(0);
  });

  it("is given up on after three reads in a row, and told about once", async () => {
    const { layer, calls, answer: land } = silent("append", "load");
    const { caches, suspensions } = watched(layer);
    const fromAuthority = () => Promise.resolve(answer);

    await caches.read("orders:1", fromAuthority);
    await caches.read("orders:2", fromAuthority);
    expect(suspensions).toEqual([]);
    await caches.read("orders:3", fromAuthority);
    await caches.read("orders:4", fromAuthority);
    await outlasted();

    expect(suspensions).toEqual([{ store: "silent", timeouts: 3 }]);
    expect(calls.load).toBe(3);
    // The first two misses were filled. Nothing was sent once it was given up on, and
    // nothing is sent afterwards.
    expect(calls.snapshot).toBe(2);
    caches.mirror(committed(0));
    caches.drop("orders:1", 0);
    await caches.settled("orders:1");
    expect(calls.append).toBe(0);
    expect(calls.forget).toBe(0);

    // A call that settles after all changes nothing.
    land();
    await outlasted();
    expect(calls.forget).toBe(0);
  });

  it("refuses to say it deleted a key from a layer it gave up on", async () => {
    const { layer, calls } = silent("load");
    const { caches } = watched(layer);
    const fromAuthority = () => Promise.resolve(answer);
    await caches.read("orders:1", fromAuthority);
    await caches.read("orders:2", fromAuthority);
    await caches.read("orders:3", fromAuthority);

    await expect(caches.forget("orders:1")).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
      key: "orders:1",
    });
    expect(calls.forget).toBe(0);
  });

  it("is not worth a shutdown waiting for once it is given up on", async () => {
    const { layer } = silent("load");
    const lasting: Store = {
      ...layer,
      capabilities: { ...layer.capabilities, durability: "durable" },
    };
    const { caches } = watched(lasting);
    const fromAuthority = () => Promise.resolve(answer);
    expect(caches.outlasting).toBe(true);

    await caches.read("orders:1", fromAuthority);
    await caches.read("orders:2", fromAuthority);
    await caches.read("orders:3", fromAuthority);

    expect(caches.outlasting).toBe(false);
  });

  it("is kept when an answer comes between the calls that ran out", async () => {
    const { layer, answer: land } = silent("load");
    const { caches, suspensions } = watched(layer);
    const fromAuthority = () => Promise.resolve(answer);

    await caches.read("orders:1", fromAuthority);
    await caches.read("orders:2", fromAuthority);
    const reading = caches.read("orders:3", fromAuthority);
    land();
    land();
    land();
    await reading;
    await caches.read("orders:4", fromAuthority);
    await caches.read("orders:5", fromAuthority);

    expect(suspensions).toEqual([]);
  });

  it("does not clear up after a write that ran out once the layers are closing", async () => {
    const { layer, calls, answer: land } = silent("append");
    const { caches } = watched(layer);
    caches.mirror(committed(0));
    await caches.settled("orders:1");

    caches.close();
    land();
    await outlasted();

    expect(calls.forget).toBe(0);
  });
});

describe("a cache layer with no way to delete", () => {
  it("is left as it is by a deletion, which a stack would have refused it for", async () => {
    const inner = memoryStore({ name: "cache" });
    const layer: Store = {
      name: inner.name,
      capabilities: inner.capabilities,
      append: inner.append.bind(inner),
      load: inner.load.bind(inner),
      read: inner.read.bind(inner),
      scan: inner.scan.bind(inner),
      snapshot: inner.snapshot.bind(inner),
    };
    const caches = new Caches([layer], {
      now: () => 0,
      failed: () => undefined,
    });
    caches.mirror(committed(0));

    await expect(caches.forget("orders:1")).resolves.toBeUndefined();

    expect((await inner.load("orders:1"))?.seq).toBe(0);
  });
});

describe("a runtime with no cache layers", () => {
  it("has nothing queued for any key", async () => {
    const caches = new Caches([], { now: () => 0, failed: () => undefined });

    expect(caches.any).toBe(false);
    await expect(caches.settled("orders:1")).resolves.toBeUndefined();
  });
});
