import { EkmanError } from "./errors";
import type { Values } from "./types";

/**
 * The memory budget.
 *
 * An unbounded map of resident instances is the default failure mode of every homegrown
 * version of this, and it fails at the worst possible moment. A budget with explicit
 * eviction makes the working set fit the environment rather than the other way around.
 *
 * Two rules hold everything else together. Only idle instances can be evicted, because
 * evicting one mid-handler would mean losing a commit that is already in flight. And the
 * accounting basis is documented and stable, because an approximate number nobody can
 * reason about is worse than no number.
 */

/** What happens when the budget is full. */
export type EvictionPolicy = "lru" | "reject" | "none";

export const EVICTION_POLICIES: readonly EvictionPolicy[] = [
  "lru",
  "reject",
  "none",
];

export interface EvictionConfig {
  /**
   * - `lru`: release the least recently used idle instances until back under budget.
   * - `reject`: refuse to materialize new instances instead of evicting. Resident ones
   *   keep working.
   * - `none`: account and report, never act. The budget becomes a measurement rather than
   *   a limit, which is how you find out what your real working set is before enforcing
   *   one. The same argument `warn` makes for constraints.
   *
   * Defaults to `lru`.
   */
  readonly policy?: EvictionPolicy;
  /**
   * Persist before releasing, so a reloaded instance does not have to replay its whole
   * stream. Defaults to on whenever a durable store is configured.
   *
   * Turning it off trades replay cost for write volume, which is the right trade on a
   * workload that evicts constantly. Asking for it with no durable store is refused rather
   * than quietly ignored.
   */
  readonly snapshotOnEvict?: boolean;
  /**
   * Permit eviction to throw state away because there is no durable store to put it in.
   *
   * Off by default, and required to be explicit: silently discarding committed state is
   * the one thing eviction must never do by accident.
   */
  readonly allowDiscard?: boolean;
}

export interface MemoryConfig {
  /**
   * The resident budget in bytes. Omitted means unlimited.
   *
   * `0` means no residency at all: every instance is released as soon as it goes idle, and
   * every trigger loads through the store. That needs a durable store, and is refused
   * without one.
   */
  readonly maxBytes?: number;
  /**
   * Measure values yourself instead of serializing them.
   *
   * Worth supplying on a hot path, or when values hold something whose serialized size is
   * a poor proxy for its cost. Whatever you return has to be stable for the same input.
   */
  readonly sizeOf?: (values: Values) => number;
  readonly eviction?: EvictionConfig;
}

export interface ResolvedMemoryConfig {
  /** `Number.POSITIVE_INFINITY` when unlimited. */
  readonly maxBytes: number;
  readonly sizeOf: ((values: Values) => number) | undefined;
  readonly policy: EvictionPolicy;
  readonly snapshotOnEvict: boolean;
  readonly allowDiscard: boolean;
  /** Whether the budget can ever force anything out. */
  readonly bounded: boolean;
}

const encoder = new TextEncoder();

/**
 * The accounting basis, stated once so it can be relied on.
 *
 * Serialized UTF-8 byte length of the key, the state name, and the values, measured at
 * commit. Values are being serialized at that moment anyway, so this costs nothing extra
 * on the path that matters, and it is a number an operator can reason about: it is roughly
 * what the instance costs to persist.
 *
 * It is approximate as a measure of heap. It is exact and reproducible as a measure of
 * itself, which is the property that matters for a budget you can test against.
 */
export function accountBytes(
  key: string,
  state: string,
  values: Values,
  sizeOf: ((values: Values) => number) | undefined
): number {
  const valueBytes =
    sizeOf === undefined
      ? encoder.encode(JSON.stringify(values)).length
      : sizeOf(values);

  return encoder.encode(key).length + encoder.encode(state).length + valueBytes;
}

/**
 * Resolve the budget against what the stores can offer.
 *
 * The question every check below asks is "is there somewhere to put state that is being
 * released", and the answer is `hasStore`, not `durable`. An ephemeral store is somewhere:
 * an evicted instance reloads from it perfectly well within one process. What ephemeral
 * costs you is surviving a restart, which is a durability question and not an eviction one.
 */
export function resolveMemoryConfig(
  config: MemoryConfig | undefined,
  context: { hasStore: boolean }
): ResolvedMemoryConfig {
  const maxBytes = config?.maxBytes ?? Number.POSITIVE_INFINITY;
  const policy = config?.eviction?.policy ?? "lru";

  if (
    !(
      maxBytes === Number.POSITIVE_INFINITY ||
      (Number.isInteger(maxBytes) && maxBytes >= 0)
    )
  ) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `memory maxBytes must be a non-negative integer number of bytes, received ${JSON.stringify(maxBytes)}. ` +
        "Omit it for an unlimited budget, or use 0 for no resident state at all."
    );
  }

  if (!EVICTION_POLICIES.includes(policy)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `eviction policy ${JSON.stringify(policy)} is not recognized. ` +
        `Expected one of: ${EVICTION_POLICIES.join(", ")}`
    );
  }

  const bounded = maxBytes !== Number.POSITIVE_INFINITY;

  if (maxBytes === 0 && !context.hasStore) {
    throw new EkmanError(
      "INVALID_CONFIG",
      "memory maxBytes of 0 means every instance loads through a store, but no store is " +
        "configured, so there would be nothing to load from."
    );
  }

  const snapshotOnEvict = config?.eviction?.snapshotOnEvict ?? context.hasStore;

  if (snapshotOnEvict && !context.hasStore) {
    throw new EkmanError(
      "INVALID_CONFIG",
      "eviction snapshotOnEvict is set, but no store is configured, so there is nowhere " +
        "to snapshot to. Configure a store, or remove the setting."
    );
  }

  const allowDiscard = config?.eviction?.allowDiscard ?? false;

  // Only a bounded budget with a policy that actually releases things can discard, and
  // only when there is nowhere for the released state to go.
  if (bounded && policy === "lru" && !(context.hasStore || allowDiscard)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      "eviction would discard committed state, because the budget is bounded and no " +
        "store is configured. Set eviction.allowDiscard to accept that, use " +
        'eviction.policy "reject" to refuse new instances instead, or configure a store.'
    );
  }

  return Object.freeze({
    maxBytes,
    sizeOf: config?.sizeOf,
    policy,
    snapshotOnEvict,
    allowDiscard,
    bounded,
  });
}

/**
 * What is resident and what it costs, in least-recently-used order.
 *
 * A `Map` preserves insertion order, so re-inserting on every touch makes iteration order
 * exactly LRU order with no separate list to keep in step. The running total is maintained
 * incrementally because the alternative, summing on every commit, turns the budget check
 * into the most expensive thing on the commit path.
 */
export class MemoryLedger {
  readonly #bytes = new Map<string, number>();
  #total = 0;

  get total(): number {
    return this.#total;
  }

  get size(): number {
    return this.#bytes.size;
  }

  /** Keys from least to most recently used. */
  get lru(): readonly string[] {
    return [...this.#bytes.keys()];
  }

  has(key: string): boolean {
    return this.#bytes.has(key);
  }

  bytesFor(key: string): number {
    return this.#bytes.get(key) ?? 0;
  }

  /** Record what a key costs now, and mark it as most recently used. */
  record(key: string, bytes: number): void {
    this.#total += bytes - (this.#bytes.get(key) ?? 0);
    this.#bytes.delete(key);
    this.#bytes.set(key, bytes);
  }

  /** Mark a key as most recently used without changing what it costs. */
  touch(key: string): void {
    const bytes = this.#bytes.get(key);
    if (bytes !== undefined) {
      this.#bytes.delete(key);
      this.#bytes.set(key, bytes);
    }
  }

  /** Drop a key, returning what it was costing. */
  release(key: string): number {
    const bytes = this.#bytes.get(key) ?? 0;
    this.#bytes.delete(key);
    this.#total -= bytes;
    return bytes;
  }
}
