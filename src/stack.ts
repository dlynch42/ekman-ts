import { EkmanError } from "./errors";
import type { Store } from "./store";
import type { FileStoreOptions } from "./stores/file";
import { fileStore } from "./stores/file";
import { memoryStore } from "./stores/memory";

/**
 * A store described rather than constructed.
 *
 * The built-ins are named, so configuring durability needs no imports and no call. What
 * this deliberately does not become is an open registry: an adapter that carries its own
 * dependency, such as Redis or Postgres, is passed as an instance instead, so that core
 * never has to import a database client to understand a config object.
 */
export type StoreSpec =
  | { readonly kind: "none" }
  | {
      readonly kind: "memory";
      readonly name?: string;
      readonly authority?: boolean;
    }
  | ({ readonly kind: "file"; readonly dir?: string } & FileStoreOptions);

/** The shorthand for a spec that needs no options. */
export type StoreKind = StoreSpec["kind"];

/** One layer of the stack: named, described, or handed over already built. */
export type StoreLayer = StoreKind | StoreSpec | Store;

const STORE_KINDS: readonly StoreKind[] = ["none", "memory", "file"];

/**
 * Build one of the built-in stores from its spec.
 *
 * The seam for composition. Configuring a store is done by naming it, so the constructors
 * themselves are not public, but wrapping one is a real thing to want: a layer that adds
 * encryption, or latency in a test, has to have something to delegate to. This is that,
 * and it is deliberately the whole of it.
 *
 * `"none"` has no store to build, so it is not accepted here.
 */
export function createStore(
  spec: Exclude<StoreSpec, { kind: "none" }> | Exclude<StoreKind, "none">
): Store {
  const [store] = toLayers([spec]);
  if (store === undefined) {
    throw new EkmanError(
      "INVALID_CONFIG",
      'createStore was given "none", which names the absence of a store rather than one ' +
        "that could be built. Omit the layer instead."
    );
  }
  return store;
}

/**
 * Turn whatever `store` was configured as into layers.
 *
 * `"none"` produces no layer at all, which is not the same as an empty list. An empty list
 * is a mistake and stays refused; `"none"` is somebody saying out loud that this runtime
 * keeps nothing, and saying it is the point. For the same reason it cannot appear beside
 * other layers: "no store, and also this store" has no meaning worth guessing at.
 */
function toLayers(configured: readonly StoreLayer[]): Store[] {
  const layers: Store[] = [];
  for (const entry of configured) {
    const spec: StoreSpec | Store =
      typeof entry === "string" ? ({ kind: entry } as StoreSpec) : entry;

    if (!("kind" in spec)) {
      // Already a Store. Nothing to build.
      layers.push(spec);
      continue;
    }

    if (!STORE_KINDS.includes(spec.kind)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `store kind ${JSON.stringify(spec.kind)} is not one this runtime builds. ` +
          `Expected one of: ${STORE_KINDS.join(", ")}. Any other adapter is configured by ` +
          "passing the store itself rather than naming it."
      );
    }

    if (spec.kind === "none") {
      if (configured.length > 1) {
        throw new EkmanError(
          "INVALID_CONFIG",
          'store "none" says this runtime keeps nothing, so it cannot be combined with ' +
            "other layers. Remove it, or make it the only entry."
        );
      }
      continue;
    }

    if (spec.kind === "memory") {
      const { kind: _kind, ...options } = spec;
      layers.push(memoryStore(options));
      continue;
    }

    const { kind: _kind, dir, ...options } = spec;
    layers.push(
      dir === undefined ? fileStore(options) : fileStore(dir, options)
    );
  }

  return layers;
}

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

/**
 * How many runtimes are expected to write to this store.
 *
 * `single` is the default and is what one embedded runtime owning its own storage means.
 * `multi` says other processes write the same keys, which is a promise only the store can
 * keep: the conditional append has to be atomic *between processes*, not just within one. A
 * store that cannot say yes to that makes this configuration a refusal rather than a slower
 * path, because the failure it would otherwise produce is two runtimes both believing they
 * hold a key, which no amount of care in the runtime can detect afterwards.
 */
export type Coordination = "single" | "multi";

const COORDINATIONS: readonly Coordination[] = ["single", "multi"];

/**
 * Refuse a coordination the configured stores cannot honour.
 *
 * The declaration is the safety mechanism. An adapter says whether its conditional append
 * holds across processes, and this is the one place that answer is acted on: without it the
 * capability would be documentation, and asking for multi-runtime operation on a store that
 * cannot provide it would appear to work right up until two runtimes disagreed.
 */
export function assertCoordination(
  stack: ResolvedStack,
  coordination: Coordination | undefined
): void {
  if (coordination === undefined) {
    return;
  }

  if (!COORDINATIONS.includes(coordination)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `coordination ${JSON.stringify(coordination)} is not recognized. ` +
        `Expected one of: ${COORDINATIONS.join(", ")}.`
    );
  }

  if (coordination === "single") {
    return;
  }

  const { authority } = stack;
  if (authority === undefined) {
    throw new EkmanError(
      "INVALID_CONFIG",
      'coordination "multi" means other processes write these keys, but no store ' +
        "is configured, so there is nothing for them to write to or to arbitrate between " +
        "them."
    );
  }

  if (!authority.capabilities.multiWriter) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `coordination "multi" needs the commit authority to detect a concurrent ` +
        `writer, and store layer "${authority.name}" declares it cannot: its conditional ` +
        "append holds within one process and not across two. Two runtimes on it would " +
        "both believe their appends were conditional. Use a store that declares " +
        'multiWriter, or leave coordination at "single".'
    );
  }
}

export function resolveStack(
  store: StoreLayer | readonly StoreLayer[] | undefined
): ResolvedStack {
  if (store === undefined) {
    return EMPTY_STACK;
  }

  const configured = Array.isArray(store)
    ? (store as readonly StoreLayer[])
    : [store as StoreLayer];

  if (configured.length === 0) {
    // An empty array is a configuration mistake, not a request for memory-only operation.
    // Omitting `store` says that, and says it unambiguously.
    throw new EkmanError(
      "INVALID_CONFIG",
      "store was configured as an empty list. Omit it entirely for a memory-only runtime."
    );
  }

  const layers = toLayers(configured);

  // `"none"` is the one input that legitimately produces no layer. Everything below reasons
  // about an authority, and there is not one to reason about.
  if (layers.length === 0) {
    return EMPTY_STACK;
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
