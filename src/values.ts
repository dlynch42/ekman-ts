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
 * Held to what a commit is held to, plus the one thing a commit checks later: that JSON
 * can represent them. A `BigInt` survives structured clone and cannot be measured or
 * persisted, so without the second check the definition would be accepted and every
 * instance of it would fail on its first trigger.
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
    const sealed = freezeValues(structuredClone(values));
    JSON.stringify(sealed);
    return sealed;
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
 * on a load. An object that is already frozen is taken to have been walked, which is also
 * what stops a value that refers to itself from being walked forever.
 *
 * @returns the same object, frozen
 */
export function freezeValues<V>(values: V): Readonly<V> {
  if (!isPlain(values) || Object.isFrozen(values)) {
    return values;
  }

  Object.freeze(values);
  for (const nested of Object.values(values)) {
    freezeValues(nested);
  }
  return values;
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
