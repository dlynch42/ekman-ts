import { EkmanError } from "./errors";
import type { Store } from "./store";

/**
 * The store stack: one commit authority, everything else a cache.
 *
 * Layering exists so a hot local layer can answer reads while a slower durable one owns the
 * truth. What it must never become is two things that both think they are the truth, which
 * is why exactly one layer is the authority and the rest are explicitly derived.
 *
 * A cache write that fails is reported and forgotten. A commit is already durable by the
 * time caches are touched, so a stale cache is a performance problem; treating it as a
 * commit failure would turn one into a correctness problem.
 */
export interface ResolvedStack {
  /** Owns the truth. Every commit goes here first, and reads fall back to it. */
  readonly authority: Store | undefined;
  /** Read-first, write-after layers, in declaration order. */
  readonly caches: readonly Store[];
  /** Every layer, in declaration order. */
  readonly layers: readonly Store[];
  /** Whether a commit survives the process. */
  readonly durable: boolean;
}

export const EMPTY_STACK: ResolvedStack = Object.freeze({
  authority: undefined,
  caches: Object.freeze([]),
  layers: Object.freeze([]),
  durable: false,
});

export function resolveStack(
  store: Store | readonly Store[] | undefined
): ResolvedStack {
  if (store === undefined) {
    return EMPTY_STACK;
  }

  const layers = Array.isArray(store) ? [...store] : [store as Store];

  if (layers.length === 0) {
    // An empty array is a configuration mistake, not a request for memory-only operation.
    // Omitting `store` says that, and says it unambiguously.
    throw new EkmanError(
      "INVALID_CONFIG",
      "store was configured as an empty list. Omit it entirely for a memory-only runtime."
    );
  }

  assertUniqueNames(layers);

  const claimed = layers.filter((layer) => layer.authority === true);
  if (claimed.length > 1) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${claimed.length} store layers claim to be the commit authority (${claimed
        .map((layer) => layer.name)
        .join(", ")}). Exactly one layer owns the truth.`
    );
  }

  const authority = claimed[0] ?? pickAuthority(layers);
  const caches = layers.filter((layer) => layer !== authority);

  if (
    authority.capabilities.durability === "ephemeral" &&
    caches.some((layer) => layer.capabilities.durability === "durable")
  ) {
    // Almost certainly a mistake: it makes a durable layer a cache of an ephemeral one, so
    // a restart silently loses everything while a durable store sits right there.
    throw new EkmanError(
      "INVALID_CONFIG",
      `store layer "${authority.name}" is the commit authority but is ephemeral, while a ` +
        "durable layer is configured behind it. The authority owns the truth, so this " +
        "would discard committed state on restart. Mark the durable layer as the authority."
    );
  }

  return Object.freeze({
    authority,
    caches: Object.freeze(caches),
    layers: Object.freeze(layers),
    durable: authority.capabilities.durability === "durable",
  });
}

/**
 * The last durable layer, or the last layer when none is durable.
 *
 * Last rather than first because a stack reads as fastest-to-slowest, and the slow end is
 * where the truth lives. A single-layer stack lands on that layer either way.
 */
function pickAuthority(layers: readonly Store[]): Store {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (layer !== undefined && layer.capabilities.durability === "durable") {
      return layer;
    }
  }
  return layers.at(-1) as Store;
}

function assertUniqueNames(layers: readonly Store[]): void {
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.name)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `two store layers are both named "${layer.name}". Layer names appear in telemetry ` +
          "and in query results, so they have to tell the layers apart."
      );
    }
    seen.add(layer.name);
  }
}
