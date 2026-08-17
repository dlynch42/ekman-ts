import { expect, it } from "vitest";
import type { EkmanError, EkmanEvent, Store } from "../src/index";
import { EMPTY_SEQ } from "../src/index";

/**
 * The shared store contract.
 *
 * Every adapter runs exactly these, so "conforming adapter" is a thing you check rather
 * than a thing you claim. An adapter that passes can be swapped in without reading the
 * runtime, and one that fails is broken regardless of how reasonable it looks.
 *
 * `make` returns a fresh, empty store each call. Adapters that touch the filesystem get a
 * fresh directory per call, which is the point of taking a factory rather than an instance.
 */
export function storeContract(
  name: string,
  make: () => Store,
  expected: { durable: boolean }
): void {
  const commit = (
    key: string,
    seq: number,
    from: string | null,
    to: string,
    at = seq * 1000
  ): EkmanEvent =>
    Object.freeze({
      type: "transition" as const,
      key,
      from,
      to,
      seq,
      at,
      cause: { type: "test", id: `t${seq}` },
      values: { n: seq },
    });

  const violation = (key: string, seq: number): EkmanEvent =>
    Object.freeze({
      type: "violation" as const,
      key,
      seq,
      at: seq * 1000,
      cause: { type: "test", id: `v${seq}` },
      constraint: { kind: "guard" as const, name: "g" },
      policy: "warn" as const,
      reason: "nope",
    });

  const code = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      return (error as EkmanError).code;
    }
    throw new Error("expected a rejection");
  };

  it(`${name}: declares its durability honestly`, () => {
    expect(make().capabilities.durability).toBe(
      expected.durable ? "durable" : "ephemeral"
    );
  });

  it(`${name}: reports nothing for a key it has never seen`, async () => {
    expect(await make().load("orders:missing")).toBeUndefined();
  });

  it(`${name}: accepts a first append against the empty sequence`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending"),
      EMPTY_SEQ
    );

    const loaded = await store.load("orders:1");
    expect(loaded?.seq).toBe(0);
    expect(loaded?.events).toHaveLength(1);
  });

  it(`${name}: refuses an append whose expected sequence does not match`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending"),
      EMPTY_SEQ
    );

    expect(
      await code(
        store.append("orders:1", commit("orders:1", 1, "pending", "done"), 5)
      )
    ).toBe("STORE_CONFLICT");
  });

  it(`${name}: leaves nothing behind when an append is refused`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending"),
      EMPTY_SEQ
    );
    await code(
      store.append("orders:1", commit("orders:1", 9, "pending", "done"), 7)
    );

    // The whole value of a conditional append is that a caller seeing a conflict knows
    // exactly what state the store is in: the one it was in before.
    const loaded = await store.load("orders:1");
    expect(loaded?.seq).toBe(0);
    expect(loaded?.events).toHaveLength(1);
  });

  it(`${name}: refuses a first append when the key already exists`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending"),
      EMPTY_SEQ
    );

    expect(
      await code(
        store.append(
          "orders:1",
          commit("orders:1", 0, null, "pending"),
          EMPTY_SEQ
        )
      )
    ).toBe("STORE_CONFLICT");
  });

  it(`${name}: does not advance the sequence for a non-commit event`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending"),
      EMPTY_SEQ
    );
    await store.append("orders:1", violation("orders:1", 0), 0);
    // Still conditional on 0, because a violation is not a commit.
    await store.append("orders:1", commit("orders:1", 1, "pending", "done"), 0);

    const loaded = await store.load("orders:1");
    expect(loaded?.seq).toBe(1);
    expect(loaded?.events.map((e) => e.type)).toEqual([
      "transition",
      "violation",
      "transition",
    ]);
  });

  it(`${name}: replays a stream back to its current state`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending"),
      EMPTY_SEQ
    );
    await store.append(
      "orders:1",
      commit("orders:1", 1, "pending", "shipped"),
      0
    );
    await store.append(
      "orders:1",
      commit("orders:1", 2, "shipped", "shipped"),
      1
    );

    const loaded = await store.load("orders:1");
    expect(loaded?.seq).toBe(2);
    const last = loaded?.events.at(-1);
    expect(last).toMatchObject({ to: "shipped", seq: 2, values: { n: 2 } });
  });

  it(`${name}: keeps keys apart`, async () => {
    const store = make();
    await store.append("orders:1", commit("orders:1", 0, null, "a"), EMPTY_SEQ);
    await store.append("orders:2", commit("orders:2", 0, null, "a"), EMPTY_SEQ);
    await store.append("orders:1", commit("orders:1", 1, "a", "b"), 0);

    expect((await store.load("orders:1"))?.seq).toBe(1);
    expect((await store.load("orders:2"))?.seq).toBe(0);
  });

  it(`${name}: returns the full stream from read, snapshot or not`, async () => {
    const store = make();
    await store.append("orders:1", commit("orders:1", 0, null, "a"), EMPTY_SEQ);
    await store.append("orders:1", commit("orders:1", 1, "a", "b"), 0);
    await store.snapshot("orders:1", {
      key: "orders:1",
      entity: "orders",
      state: "b",
      values: { n: 1 },
      seq: 1,
      enteredAt: 1000,
      at: 1000,
    });

    // `load` may skip what the snapshot already folds in. `read` never does: history is
    // history.
    expect(await store.read("orders:1")).toHaveLength(2);
  });

  it(`${name}: loads from a snapshot plus only what came after it`, async () => {
    const store = make();
    await store.append("orders:1", commit("orders:1", 0, null, "a"), EMPTY_SEQ);
    await store.append("orders:1", commit("orders:1", 1, "a", "b"), 0);
    await store.snapshot("orders:1", {
      key: "orders:1",
      entity: "orders",
      state: "b",
      values: { n: 1 },
      seq: 1,
      enteredAt: 1000,
      at: 1000,
    });
    await store.append("orders:1", commit("orders:1", 2, "b", "c"), 1);

    const loaded = await store.load("orders:1");
    expect(loaded?.snapshot?.seq).toBe(1);
    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.seq).toBe(2);
  });

  it(`${name}: is idempotent when the same snapshot is written twice`, async () => {
    const store = make();
    await store.append("orders:1", commit("orders:1", 0, null, "a"), EMPTY_SEQ);
    const snapshot = {
      key: "orders:1",
      entity: "orders",
      state: "a",
      values: { n: 0 },
      seq: 0,
      enteredAt: 0,
      at: 0,
    };

    await store.snapshot("orders:1", snapshot);
    await store.snapshot("orders:1", snapshot);

    expect((await store.load("orders:1"))?.snapshot).toMatchObject({ seq: 0 });
  });

  it(`${name}: never lets a snapshot move backwards`, async () => {
    const store = make();
    await store.append("orders:1", commit("orders:1", 0, null, "a"), EMPTY_SEQ);
    await store.append("orders:1", commit("orders:1", 1, "a", "b"), 0);

    const base = {
      key: "orders:1",
      entity: "orders",
      values: {},
      enteredAt: 0,
      at: 0,
    };
    await store.snapshot("orders:1", { ...base, state: "b", seq: 1 });
    // A stale writer arriving late must not undo a newer snapshot.
    await store.snapshot("orders:1", { ...base, state: "a", seq: 0 });

    expect((await store.load("orders:1"))?.snapshot).toMatchObject({
      state: "b",
      seq: 1,
    });
  });

  it(`${name}: scans by entity and state`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending"),
      EMPTY_SEQ
    );
    await store.append(
      "orders:2",
      commit("orders:2", 0, null, "shipped"),
      EMPTY_SEQ
    );
    await store.append(
      "carts:1",
      commit("carts:1", 0, null, "pending"),
      EMPTY_SEQ
    );

    const all = await store.scan({ entity: "orders", now: 0 });
    expect(all.matches.map((m) => m.key).sort()).toEqual([
      "orders:1",
      "orders:2",
    ]);
    expect(all.complete).toBe(true);

    const pending = await store.scan({
      entity: "orders",
      state: "pending",
      now: 0,
    });
    expect(pending.matches.map((m) => m.key)).toEqual(["orders:1"]);
  });

  it(`${name}: scans by time in state`, async () => {
    const store = make();
    // Entered `pending` at 0 and never moved.
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "pending", 0),
      EMPTY_SEQ
    );
    // Entered `pending`, then moved to `shipped` at 9000, so it is young in `shipped`.
    await store.append(
      "orders:2",
      commit("orders:2", 0, null, "pending", 0),
      EMPTY_SEQ
    );
    await store.append(
      "orders:2",
      commit("orders:2", 1, "pending", "shipped", 9000),
      0
    );

    const stuck = await store.scan({
      entity: "orders",
      olderThanMs: 5000,
      now: 10_000,
    });

    expect(stuck.matches.map((m) => m.key)).toEqual(["orders:1"]);
  });

  it(`${name}: reports an answer it truncated as incomplete`, async () => {
    const store = make();
    await store.append("orders:1", commit("orders:1", 0, null, "a"), EMPTY_SEQ);
    await store.append("orders:2", commit("orders:2", 0, null, "a"), EMPTY_SEQ);

    const limited = await store.scan({ entity: "orders", now: 0, limit: 1 });
    expect(limited.matches).toHaveLength(1);
    // A truncated answer that claimed to be whole is the failure mode this flag exists for.
    expect(limited.complete).toBe(false);
  });

  it(`${name}: measures time in state from the move, not from the last commit`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "a", 0),
      EMPTY_SEQ
    );
    // A values-only commit at 9000. The instance has not gone anywhere.
    await store.append("orders:1", commit("orders:1", 1, "a", "a", 9000), 0);

    const stuck = await store.scan({
      entity: "orders",
      olderThanMs: 5000,
      now: 10_000,
    });

    expect(stuck.matches.map((m) => m.key)).toEqual(["orders:1"]);
  });

  it(`${name}: forgets a key completely, stream and snapshot alike`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "a", 0),
      EMPTY_SEQ
    );
    await store.append("orders:1", commit("orders:1", 1, "a", "b", 1000), 0);
    await store.snapshot("orders:1", {
      key: "orders:1",
      entity: "orders",
      state: "b",
      values: { n: 1 },
      seq: 1,
      at: 1000,
      enteredAt: 1000,
    });
    await store.append(
      "orders:2",
      commit("orders:2", 0, null, "a", 0),
      EMPTY_SEQ
    );

    await store.forget?.("orders:1");

    // Gone entirely, rather than reduced to a snapshot that would rebuild it on load.
    expect(await store.load("orders:1")).toBeUndefined();
    expect(await store.read("orders:1")).toEqual([]);

    // And the neighbour it shares a store with is untouched, so a scan sees exactly one.
    const found = await store.scan({ entity: "orders", now: 10_000 });
    expect(found.matches.map((match) => match.key)).toEqual(["orders:2"]);
  });

  it(`${name}: lets a forgotten key be created again from the beginning`, async () => {
    const store = make();
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "a", 0),
      EMPTY_SEQ
    );
    await store.append("orders:1", commit("orders:1", 1, "a", "b", 1000), 0);

    await store.forget?.("orders:1");

    // A genuinely new instance, back at the start. If the old sequence lingered anywhere
    // this conditional append would be refused as a conflict.
    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "a", 0),
      EMPTY_SEQ
    );
    expect((await store.load("orders:1"))?.seq).toBe(0);
  });

  it(`${name}: forgetting a key it never held is not an error`, async () => {
    const store = make();
    // So a sweep that dies halfway behaves the same way when it is retried.
    await expect(store.forget?.("orders:nobody")).resolves.toBeUndefined();
  });

  it(`${name}: says whether it can forget at all`, () => {
    // Declared rather than discovered by calling it: retention has to be refusable up
    // front on a store that cannot delete.
    const store = make();
    expect(store.capabilities.forget).toBe(typeof store.forget === "function");
  });

  it(`${name}: says whether it can compact at all`, () => {
    // Same rule as `forget`, and for the same reason: the runtime sweeps every layer
    // without asking each one what it was configured for, so what a layer can do has to
    // be readable before anything calls it.
    const store = make();
    expect(store.capabilities.compact).toBe(
      typeof store.compact === "function"
    );
  });

  it(`${name}: compacting costs history and never state`, async () => {
    const store = make();
    if (store.compact === undefined) {
      // Nothing to hold this adapter to. The declaration above is what it answers for.
      return;
    }

    await store.append(
      "orders:1",
      commit("orders:1", 0, null, "a", 0),
      EMPTY_SEQ
    );
    await store.append("orders:1", commit("orders:1", 1, "a", "b", 1000), 0);
    await store.append("orders:1", commit("orders:1", 2, "b", "c", 2000), 1);

    await store.compact();

    // Whatever a pass chose to fold, these have to survive it. A compacted key replays to
    // exactly where it was, and its next conditional append is against the same sequence,
    // which is what makes compaction safe to run behind a live runtime.
    const loaded = await store.load("orders:1");
    expect(loaded?.seq).toBe(2);
    await store.append("orders:1", commit("orders:1", 3, "c", "d", 3000), 2);
    expect((await store.load("orders:1"))?.seq).toBe(3);
  });
}
