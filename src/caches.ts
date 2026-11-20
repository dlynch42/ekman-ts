import { EkmanError } from "./errors";
import type { EkmanEvent } from "./events";
import type { LoadResult, ReplayedState, Store, StoreSnapshot } from "./store";
import {
  EMPTY_SEQ,
  entityOf,
  lastCommitOf,
  previousSeq,
  replay,
} from "./store";

/** A cache layer that could not be read, written or cleared, for the runtime to report. */
export interface CacheFailure {
  readonly key: string;
  readonly store: string;
  readonly error: string;
  readonly seq: number;
}

/** A cache layer that will not be used again by this runtime, for the runtime to report. */
export interface CacheSuspension {
  readonly store: string;
  /** How many calls in a row went unanswered. */
  readonly timeouts: number;
}

/** How long a call into a cache layer may take when nothing is configured. */
export const DEFAULT_CACHE_TIMEOUT_MS = 5000;

/** How many calls of one kind in a row may go unanswered before a layer is given up on. */
const SUSPEND_AFTER = 3;

/**
 * The two kinds of call into a layer, counted apart.
 *
 * A layer whose reads never answer may go on taking writes, and every read that runs out
 * is followed by a fill. Counted together, that fill would clear the count each time and
 * the layer would cost every load its whole time bound for good.
 */
type Call = "read" | "write";

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
 * and neither a commit nor a load ever waits for a cache.
 *
 * Every call into a layer has a time bound, because a layer is somebody else's code and
 * may never answer. A read that runs out is a miss. A write that runs out is a failed
 * write that may still land, so the layer is left out for the key until it has settled
 * and the key has been deleted. A layer whose reads, or whose writes, run out three times
 * in a row is given up on for the life of the runtime, and whatever was queued for it is
 * passed over.
 *
 * A layer that is behind the authority can still answer a read if something outside this
 * runtime moved the key. The authority's conditional append refuses the commit built on
 * that answer, and the refusal is what clears the key here.
 */
export class Caches {
  readonly #layers: readonly Store[];
  readonly #now: () => number;
  readonly #failed: (failure: CacheFailure) => void;
  readonly #timeoutMs: number;
  readonly #suspended: (suspension: CacheSuspension) => void;
  /**
   * Calls in a row that went unanswered, per layer and kind. An answer clears its kind.
   * Holds a layer only once a call to it has run out.
   */
  readonly #unanswered = new Map<Store, Record<Call, number>>();
  /** Layers given up on. Never read, written or cleared again. */
  readonly #abandoned = new Set<Store>();
  /** Tail of each key's chain, kept only while something is queued on it. */
  readonly #chains = new Map<string, Promise<void>>();
  readonly #standing = new Map<Store, Map<string, Standing>>();
  /** Whether the layers are closing. An object, so it reads as something that changes. */
  readonly #lifetime: { closed: boolean } = { closed: false };

  constructor(
    layers: readonly Store[],
    options: {
      now: () => number;
      failed: (failure: CacheFailure) => void;
      /** How long one call into a layer may take. */
      timeoutMs?: number;
      suspended?: (suspension: CacheSuspension) => void;
    }
  ) {
    this.#layers = layers;
    this.#now = options.now;
    this.#failed = options.failed;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CACHE_TIMEOUT_MS;
    this.#suspended = options.suspended ?? ignore;
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
   * Stop writing to the layers, because they are about to be closed.
   *
   * Whatever is still queued is skipped when its turn comes, and a write already under way
   * that fails afterwards is not cleared up after. Running either against a closed layer
   * would open it again behind the back of whoever closed it.
   */
  close(): void {
    this.#lifetime.closed = true;
  }

  /**
   * Load a key from the first cache that holds it, or from the authority.
   *
   * A cache is never read while it is behind what this runtime has already sent it. So
   * while anything is still queued for the key, the caches are passed over and the
   * authority answers. Waiting would hand a load to the slowest cache, and a cache write
   * that never settles would hold the key for good. The answer is queued as a fill behind
   * that work, so the layers end up holding it.
   *
   * A cache that throws, one that does not answer in time, and one whose answer does not
   * replay to a state, are misses: only the authority may say a key is new. Every layer that missed is filled from the
   * answer.
   */
  async read(
    key: string,
    fromAuthority: () => Promise<LoadResult | undefined>
  ): Promise<Loaded> {
    if (this.#chains.has(key)) {
      return this.#readAuthority(key, fromAuthority, this.#layers);
    }

    const missed: Store[] = [];
    for (const layer of this.#layers) {
      if (this.#standingOf(layer, key) === "distrusted") {
        continue;
      }

      // biome-ignore lint/performance/noAwaitInLoops: layers are asked in order, fastest first, and the first answer ends the walk
      const hit = await this.#bounded(layer, "read", () =>
        layer.load(key)
      ).catch((error: unknown): undefined => {
        this.#report(layer, key, EMPTY_SEQ, error);
      });
      const current = hit === undefined ? undefined : replay(hit);
      if (current !== undefined) {
        this.#fill(key, current, missed);
        return { loaded: hit, current };
      }
      missed.push(layer);
    }

    return this.#readAuthority(key, fromAuthority, missed);
  }

  /** Load a key from the authority, and fill the given layers with what it answered. */
  async #readAuthority(
    key: string,
    fromAuthority: () => Promise<LoadResult | undefined>,
    fill: readonly Store[]
  ): Promise<Loaded> {
    const loaded = await fromAuthority();
    const current = loaded === undefined ? undefined : replay(loaded);
    this.#fill(key, current, fill);
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

        return this.#bounded(layer, "write", () =>
          layer.append(key, event, expected)
        ).catch((error: unknown) => this.#clear(layer, key, event.seq, error));
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
   * then on, and the first failure is the caller's to hear. A layer that has been given
   * up on is not asked, and that is a failure too: it may still hold the key. A deletion
   * still waiting when the layers close is refused, and never run against a closed layer.
   */
  forget(key: string): Promise<void> {
    return this.#enqueue(key, async () => {
      if (this.#lifetime.closed) {
        throw new EkmanError(
          "RUNTIME_CLOSED",
          `${JSON.stringify(key)} was not deleted from the cache layers, because the runtime ` +
            "closed them while the deletion was waiting behind an earlier write.",
          { key }
        );
      }

      const outcomes = await Promise.allSettled(
        this.#layers.map(async (layer) => {
          try {
            if (this.#abandoned.has(layer)) {
              throw new EkmanError(
                "STORE_UNAVAILABLE",
                `${JSON.stringify(key)} was not deleted from cache layer "${layer.name}", which ` +
                  "stopped answering and is no longer used. It may still hold the key.",
                { key }
              );
            }
            await this.#bounded(layer, "write", () => forgetting(layer, key));
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
      ...lastCommitOf(current),
      ...(current.temporal === undefined ? {} : { temporal: current.temporal }),
    });

    this.#enqueue(key, () =>
      this.#each(layers, (layer) => {
        if (this.#standingOf(layer, key) === "distrusted") {
          return;
        }
        return this.#bounded(layer, "write", () =>
          layer.snapshot(key, snapshot)
        ).then(
          () => {
            this.#standing.get(layer)?.delete(key);
          },
          (error: unknown) => this.#clear(layer, key, snapshot.seq, error)
        );
      })
    );
  }

  /**
   * Report a failed write, then delete the key from the layer it failed on.
   *
   * Not once the layers are closing: a write that was under way when its layer was closed
   * fails for that reason alone, and deleting from a closed layer is more work against it.
   *
   * A write that ran out of time has not failed yet. It may still land, after a delete
   * sent now, and leave the layer holding something nobody is tracking. So the layer is
   * left out for the key, and the delete is sent once the write has settled either way.
   * If it never does, the layer stays left out.
   */
  #clear(
    layer: Store,
    key: string,
    seq: number,
    error: unknown
  ): Promise<void> | undefined {
    if (this.#lifetime.closed) {
      return;
    }
    this.#report(layer, key, seq, error);
    if (!(error instanceof Unanswered)) {
      return this.#delete(layer, key, seq);
    }

    this.#standing.get(layer)?.set(key, "distrusted");
    error.settled.then(() => {
      this.#enqueue(key, () => this.#delete(layer, key, seq, true));
    });
  }

  /**
   * Delete a key from one layer, leaving the layer out for the key if that fails too.
   *
   * A layer already left out for the key is not asked, unless `again` says this is the
   * delete that could bring it back.
   */
  async #delete(
    layer: Store,
    key: string,
    seq: number,
    again = false
  ): Promise<void> {
    if (
      this.#lifetime.closed ||
      this.#abandoned.has(layer) ||
      (this.#standingOf(layer, key) === "distrusted" && !again)
    ) {
      return;
    }

    this.#standing.get(layer)?.set(key, "dropped");
    try {
      await this.#bounded(layer, "write", () => forgetting(layer, key));
    } catch (error) {
      this.#standing.get(layer)?.set(key, "distrusted");
      this.#report(layer, key, seq, error);
    }
  }

  /** Where a layer stands for a key. One that was given up on is distrusted for all. */
  #standingOf(layer: Store, key: string): Standing | undefined {
    return this.#abandoned.has(layer)
      ? "distrusted"
      : this.#standing.get(layer)?.get(key);
  }

  /**
   * Call into a layer, and stop waiting for it after the time bound.
   *
   * A layer that settles on the turn it was called, as one held in memory does, is known
   * to have answered one microtask later, and no timer is ever set for it. That keeps the
   * bound off the path of a commit for every layer that does not need it.
   *
   * Running out rejects with `Unanswered`, which carries the call so its caller can act
   * once it does settle. Nothing can stop the call itself.
   */
  async #bounded<T>(
    layer: Store,
    kind: Call,
    call: () => Promise<T>
  ): Promise<T> {
    const answer = calling(call);
    let answered = false;
    const settled = answer.then(
      () => {
        answered = true;
      },
      () => {
        answered = true;
      }
    );

    await undefined;
    if (!answered) {
      await this.#within(layer, kind, settled);
    }
    const unanswered = this.#unanswered.get(layer);
    if (unanswered !== undefined) {
      unanswered[kind] = 0;
    }
    return answer;
  }

  /** Wait for a call to settle, or reject with `Unanswered` when the time bound passes. */
  #within(layer: Store, kind: Call, settled: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#strike(layer, kind);
        reject(new Unanswered(layer.name, this.#timeoutMs, settled));
      }, this.#timeoutMs);
      // A process with nothing left to do but wait on a cache should be free to exit.
      timer.unref();
      settled.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Count a call that went unanswered, and give up on the layer after enough of them. */
  #strike(layer: Store, kind: Call): void {
    const unanswered = this.#unanswered.get(layer) ?? { read: 0, write: 0 };
    this.#unanswered.set(layer, unanswered);
    unanswered[kind] += 1;
    const timeouts = unanswered[kind];
    if (timeouts < SUSPEND_AFTER || this.#abandoned.has(layer)) {
      return;
    }

    this.#abandoned.add(layer);
    this.#unanswered.delete(layer);
    this.#standing.get(layer)?.clear();
    this.#suspended({ store: layer.name, timeouts });
  }

  #report(layer: Store, key: string, seq: number, error: unknown): void {
    this.#failed({
      key,
      store: layer.name,
      error: error instanceof Error ? error.message : String(error),
      seq,
    });
  }

  /**
   * Run one step against several layers at once. The step must not reject.
   *
   * Nothing is run once the layers are closing.
   */
  async #each(
    layers: readonly Store[],
    step: (layer: Store) => Promise<void> | undefined
  ): Promise<void> {
    if (!this.#lifetime.closed) {
      await Promise.all(layers.map(step));
    }
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

/**
 * A call into a cache layer that was not answered inside the time bound.
 *
 * Not an `EkmanError`: it never reaches a caller, only the telemetry that reports it.
 */
class Unanswered extends Error {
  /** Resolves when the call does settle, whichever way. It may never. */
  readonly settled: Promise<void>;

  constructor(store: string, timeoutMs: number, settled: Promise<void>) {
    super(
      `cache layer "${store}" did not answer within ${timeoutMs}ms, so it was not waited for`
    );
    this.name = "Unanswered";
    this.settled = settled;
  }
}

/**
 * Call into a layer so that a throw and a rejection come back the same way.
 *
 * A store is somebody else's code. One written without `async` throws where it stands,
 * past a `catch` chained onto the promise it never returned. A promise the layer made is
 * handed back as it is, so one that has already settled is seen to have on the next
 * microtask.
 */
function calling<T>(call: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(call());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Delete a key from a layer. Every cache layer declares `forget`, or it was refused. */
function forgetting(layer: Store, key: string): Promise<void> {
  return layer.forget?.(key) ?? Promise.resolve();
}

function ignore(): void {
  // Deliberately empty: this exists to keep a key's chain from rejecting.
}
