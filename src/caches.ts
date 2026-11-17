import type { EkmanEvent } from "./events";
import type { LoadResult, ReplayedState, Store, StoreSnapshot } from "./store";
import { EMPTY_SEQ, entityOf, previousSeq, replay } from "./store";

/** A cache layer that could not be read, written or cleared, for the runtime to report. */
export interface CacheFailure {
  readonly key: string;
  readonly store: string;
  readonly error: string;
  readonly seq: number;
}

/** What a load found, and the state it replays to, so nobody replays it twice. */
export interface Loaded {
  readonly loaded: LoadResult | undefined;
  readonly current: ReplayedState | undefined;
}

/**
 * Why a layer is not being used for a key.
 *
 * - `dropped`: a write to it failed, so the key was deleted from it. It holds nothing for
 *   the key, and takes no more appends until it is filled again from a load.
 * - `distrusted`: the delete failed too, so nobody knows what it holds. It is neither
 *   read nor written for the key until a delete of the key succeeds.
 */
type Standing = "dropped" | "distrusted";

/**
 * The cache layers of a store stack: read first, written after the commit authority.
 *
 * A cache is only worth reading if it can be believed, and it can be believed only while
 * it holds exactly what the authority accepted for a key, or nothing. Everything here
 * exists to keep it at one of those two. A layer that misses is filled from whatever
 * answered. A layer whose write fails has the key deleted from it, so its next read is a
 * miss and not a stale answer. A layer that cannot even be cleared is left out for that
 * key.
 *
 * All of it runs on a chain per key, apart from the store-write chain a commit waits on.
 * Order within a key holds, so a fill is never overtaken by the append that follows it,
 * and no commit ever waits for a cache.
 *
 * A layer that is behind the authority can still answer a read if something outside this
 * runtime moved the key. The authority's conditional append refuses the commit built on
 * that answer, and the refusal is what clears the key here.
 */
export class Caches {
  readonly #layers: readonly Store[];
  readonly #now: () => number;
  readonly #failed: (failure: CacheFailure) => void;
  /** Tail of each key's chain, kept only while something is queued on it. */
  readonly #chains = new Map<string, Promise<void>>();
  readonly #standing = new Map<Store, Map<string, Standing>>();

  constructor(
    layers: readonly Store[],
    options: {
      now: () => number;
      failed: (failure: CacheFailure) => void;
    }
  ) {
    this.#layers = layers;
    this.#now = options.now;
    this.#failed = options.failed;
    for (const layer of layers) {
      this.#standing.set(layer, new Map());
    }
  }

  /** Whether there is any cache layer at all. */
  get any(): boolean {
    return this.#layers.length > 0;
  }

  /** Resolves once everything queued for a key has been tried. Never rejects. */
  settled(key: string): Promise<void> {
    return this.#chains.get(key) ?? Promise.resolve();
  }

  /**
   * Load a key from the first cache that holds it, or from the authority.
   *
   * Waits for the key's queued writes first, so a cache is never read while it is behind
   * what this runtime has already sent it. A cache that throws, and one whose answer does
   * not replay to a state, are misses: only the authority may say a key is new. Every
   * layer that missed is filled from the answer.
   */
  async read(
    key: string,
    fromAuthority: () => Promise<LoadResult | undefined>
  ): Promise<Loaded> {
    await this.settled(key);

    const missed: Store[] = [];
    for (const layer of this.#layers) {
      if (this.#standingOf(layer, key) === "distrusted") {
        continue;
      }

      // biome-ignore lint/performance/noAwaitInLoops: layers are asked in order, fastest first, and the first answer ends the walk
      const hit = await layer.load(key).catch((error: unknown): undefined => {
        this.#report(layer, key, EMPTY_SEQ, error);
      });
      const current = hit === undefined ? undefined : replay(hit);
      if (current !== undefined) {
        this.#fill(key, current, missed);
        return { loaded: hit, current };
      }
      missed.push(layer);
    }

    const loaded = await fromAuthority();
    const current = loaded === undefined ? undefined : replay(loaded);
    this.#fill(key, current, missed);
    return { loaded, current };
  }

  /** Fill every usable layer with a state the authority just answered with. */
  refill(key: string, current: ReplayedState): void {
    this.#fill(key, current, this.#layers);
  }

  /**
   * Send an event the authority has accepted to every layer that is in step for its key.
   *
   * Conditional on the sequence before it, so a layer that has fallen behind refuses the
   * write, and is cleared, where an unconditional write would leave a hole.
   */
  mirror(event: EkmanEvent): void {
    const { key } = event;
    const expected = previousSeq(event);

    this.#enqueue(key, () =>
      this.#each(this.#layers, (layer) => {
        const standing = this.#standingOf(layer, key);
        if (standing === "dropped" && expected === EMPTY_SEQ) {
          // The layer holds nothing for the key and this is the key's first event, so
          // the two agree again.
          this.#standing.get(layer)?.delete(key);
        } else if (standing !== undefined) {
          return;
        }

        return layer
          .append(key, event, expected)
          .catch((error: unknown) => this.#clear(layer, key, event.seq, error));
      })
    );
  }

  /**
   * Delete a key from every layer, because what they hold for it can no longer be believed.
   *
   * Called when the authority refuses a commit as conflicting: something moved the key,
   * and a cache that answered the load is the first suspect.
   */
  drop(key: string, seq: number): void {
    this.#enqueue(key, () =>
      this.#each(this.#layers, (layer) => this.#delete(layer, key, seq))
    );
  }

  /**
   * Delete a key from every layer because the caller asked for it to be forgotten.
   *
   * Queued behind the key's writes, so none of them lands afterwards and brings the
   * stream back. Every layer is tried. A layer that fails is left out for the key from
   * then on, and the first failure is the caller's to hear.
   */
  forget(key: string): Promise<void> {
    return this.#enqueue(key, async () => {
      const outcomes = await Promise.allSettled(
        this.#layers.map(async (layer) => {
          try {
            await layer.forget?.(key);
            this.#standing.get(layer)?.delete(key);
          } catch (error) {
            this.#standing.get(layer)?.set(key, "distrusted");
            throw error;
          }
        })
      );

      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed !== undefined) {
        throw failed.reason;
      }
    });
  }

  /**
   * Write a snapshot of a state into layers that do not hold the key.
   *
   * A snapshot and never the events: it puts the layer at the authority's sequence in one
   * write whatever shape the authority's own stream is in, compacted or not.
   */
  #fill(
    key: string,
    current: ReplayedState | undefined,
    layers: readonly Store[]
  ): void {
    if (current === undefined || layers.length === 0) {
      return;
    }

    const snapshot: StoreSnapshot = Object.freeze({
      key,
      entity: entityOf(key),
      state: current.state,
      values: current.values,
      seq: current.seq,
      enteredAt: current.enteredAt,
      at: this.#now(),
    });

    this.#enqueue(key, () =>
      this.#each(layers, (layer) => {
        if (this.#standingOf(layer, key) === "distrusted") {
          return;
        }
        return layer.snapshot(key, snapshot).then(
          () => {
            this.#standing.get(layer)?.delete(key);
          },
          (error: unknown) => this.#clear(layer, key, snapshot.seq, error)
        );
      })
    );
  }

  /** Report a failed write, then delete the key from the layer it failed on. */
  #clear(
    layer: Store,
    key: string,
    seq: number,
    error: unknown
  ): Promise<void> {
    this.#report(layer, key, seq, error);
    return this.#delete(layer, key, seq);
  }

  /** Delete a key from one layer, leaving the layer out for the key if that fails too. */
  async #delete(layer: Store, key: string, seq: number): Promise<void> {
    if (this.#standingOf(layer, key) === "distrusted") {
      return;
    }

    this.#standing.get(layer)?.set(key, "dropped");
    try {
      await layer.forget?.(key);
    } catch (error) {
      this.#standing.get(layer)?.set(key, "distrusted");
      this.#report(layer, key, seq, error);
    }
  }

  #standingOf(layer: Store, key: string): Standing | undefined {
    return this.#standing.get(layer)?.get(key);
  }

  #report(layer: Store, key: string, seq: number, error: unknown): void {
    this.#failed({
      key,
      store: layer.name,
      error: error instanceof Error ? error.message : String(error),
      seq,
    });
  }

  /** Run one step against several layers at once. The step must not reject. */
  async #each(
    layers: readonly Store[],
    step: (layer: Store) => Promise<void> | undefined
  ): Promise<void> {
    await Promise.all(layers.map(step));
  }

  /**
   * Put work at the end of a key's chain and return its outcome.
   *
   * The chain itself never rejects, so one failure cannot poison what is queued behind
   * it, and its entry is removed once nothing is.
   */
  #enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const result = this.settled(key).then(work);
    const tail = result.then(ignore, ignore);
    this.#chains.set(key, tail);
    tail.then(() => {
      if (this.#chains.get(key) === tail) {
        this.#chains.delete(key);
      }
    });
    return result;
  }
}

function ignore(): void {
  // Deliberately empty: this exists to keep a key's chain from rejecting.
}
