import { EkmanError } from "./errors";
import type { Values } from "./types";

/**
 * Values at the boundaries where they become committed state.
 *
 * Committed values are a deep copy, frozen all the way down. The copy means a handler that
 * keeps a reference to what it returned cannot change committed state afterwards. The
 * freeze means one that reaches into `instance.values` cannot either, at any depth: a
 * nested object in an entity's initial values is one reference shared by the definition
 * and every instance created from it, so a write to it would reach all of them.
 *
 * Only plain objects and arrays are frozen. Anything else structured clone carries (a
 * `Date`, a `Map`, binary data) is copied and left as it is, because freezing a typed
 * array throws and freezing a `Map` does not stop it being written to.
 */

/**
 * Deep-copy and freeze the values of a handler result.
 *
 * Structured clone also enforces that values are serializable, so a function or a symbol
 * fails here, against the key, rather than at the first attempt to persist it.
 *
 * @param values the values a handler returned
 * @param key the instance they were returned for, named in the error and carried on it
 * @returns a frozen copy
 */
export function sealValues<V extends Values>(
  values: V,
  key: string
): Readonly<V> {
  try {
    return freezeValues(structuredClone(values));
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: EkmanError takes `cause` in its options bag and forwards it to the Error constructor
    throw new EkmanError(
      "HANDLER_FAILED",
      `values committed for ${key} are not serializable. Values must be a plain, ` +
        "serializable map: no functions, class instances, or symbols.",
      { key, cause }
    );
  }
}

/**
 * Deep-copy and freeze an entity's declared initial values.
 *
 * Held to a stricter rule than a commit: they must be plain JSON data, checked before
 * anything is copied. Every instance of the entity shares these values, so anything in
 * them that cannot be frozen (a `Map`, a `Date`, binary data) would be mutable state shared
 * across instances, and would not come back the same from a store. A `BigInt` or a
 * function would be accepted here and fail every instance on its first trigger instead.
 *
 * @param values the entity's `values`, or an empty object when it declares none
 * @param entity the entity name, for the error
 * @returns a frozen copy, safe to share between every instance of the entity
 */
export function sealInitialValues<V extends Values>(
  values: V,
  entity: string
): Readonly<V> {
  try {
    assertPlainJson(values, "values", []);
    return freezeValues(structuredClone(values));
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: EkmanError takes `cause` in its options bag and forwards it to the Error constructor
    throw new EkmanError(
      "INVALID_CONFIG",
      `the initial values of entity "${entity}" are not serializable: ` +
        `${(cause as Error).message}. Values must be plain JSON data: no functions, ` +
        "class instances, symbols or BigInts.",
      { cause }
    );
  }
}

/**
 * Freeze values in place, at every depth.
 *
 * For values nothing else holds a reference to: a fresh copy, or what a store handed back
 * on a load. Objects already visited are remembered rather than inferred from being
 * frozen: a store may hand back something frozen only at the top, and what is below it
 * still has to be walked. Remembering them is also what ends the walk for a value that
 * refers to itself.
 *
 * @returns the same object, frozen
 */
export function freezeValues<V>(values: V): Readonly<V> {
  freezeWithin(values, new WeakSet());
  return values;
}

function freezeWithin(value: unknown, visited: WeakSet<object>): void {
  if (!isPlain(value) || visited.has(value)) {
    return;
  }

  visited.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    freezeWithin(nested, visited);
  }
}

/**
 * Throw unless a value is plain JSON data all the way down, naming where it is not.
 *
 * `ancestors` is the chain of objects currently being walked, so a value that contains
 * itself is reported instead of followed.
 */
function assertPlainJson(
  value: unknown,
  path: string,
  ancestors: readonly object[]
): void {
  const kind = typeof value;
  if (kind === "function" || kind === "symbol" || kind === "bigint") {
    throw new TypeError(`${path} is a ${kind}`);
  }
  if (kind !== "object" || value === null) {
    return;
  }
  if (!isPlain(value)) {
    throw new TypeError(
      `${path} is a ${(value as object).constructor?.name ?? "non-plain object"}`
    );
  }
  if (ancestors.includes(value)) {
    throw new TypeError(`${path} contains itself`);
  }

  const within = [...ancestors, value];
  for (const [key, nested] of Object.entries(value)) {
    assertPlainJson(nested, `${path}.${key}`, within);
  }
}

function isPlain(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
