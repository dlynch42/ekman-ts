import { EkmanError } from "./errors";

/** The separator between an entity name and its segments. */
export const KEY_SEPARATOR = ":";

/**
 * The longest key accepted, in UTF-16 code units.
 *
 * A key is an identity that people type and read, and it becomes a filename in a durable
 * store. Refusing an oversized one here names the rule at `send()`, where the alternative
 * is a filesystem error at commit time.
 */
export const MAX_KEY_LENGTH = 512;

const WHITESPACE = /\s/;
const LAST_C0_CONTROL = 0x1f;
const DELETE = 0x7f;
const LAST_C1_CONTROL = 0x9f;
/**
 * A surrogate that is not half of a pair. With the `u` flag a pair is read as the one
 * character it encodes, so only an unpaired one is left to match.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Whether the text can be encoded as UTF-8 without loss. */
export function isWellFormed(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/**
 * Whether the text holds a control character: the ASCII ones, delete, and the second
 * block that follows delete, which holds the likes of next-line and has no printed form
 * either.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code <= LAST_C0_CONTROL ||
      (code >= DELETE && code <= LAST_C1_CONTROL)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The rule a segment breaks, phrased to follow the segment's name, or undefined when it
 * breaks none.
 *
 * The one statement of what a segment may be. A key's segments and an entity's name are
 * both held to it, because an entity name is the first segment of every key it addresses.
 *
 * `.` and `..` are refused because a segment can become a path component in a store, and
 * those two name a directory. Control characters and unpaired surrogates are refused
 * because a key is printed, logged and typed back in, and neither survives that.
 */
export function segmentFault(segment: string): string | undefined {
  if (segment.length === 0) {
    return "is empty";
  }
  if (segment === "." || segment === "..") {
    return "is a directory reference";
  }
  if (WHITESPACE.test(segment)) {
    return "contains whitespace";
  }
  if (hasControlCharacter(segment)) {
    return "contains a control character";
  }
  if (!isWellFormed(segment)) {
    return "contains half of a surrogate pair";
  }
}

export interface ParsedKey {
  /** The key exactly as given. This is the public identity, never normalized. */
  readonly key: string;
  /** The first segment, which names the entity. */
  readonly entity: string;
  /** Every segment after the entity name. Always at least one. */
  readonly segments: readonly string[];
}

/**
 * A key is `<entity>:<segment>(:<segment>)*`, at most `MAX_KEY_LENGTH` long. A segment is
 * non-empty, is not `.` or `..`, and contains no separator, whitespace, control character
 * or unpaired surrogate.
 *
 * Keys are treated as opaque public identities: they are not normalized, lowercased, or
 * hashed. Whatever is passed here is what shows up in history, queries, and events.
 */
export function parseKey(key: string): ParsedKey {
  if (typeof key !== "string") {
    throw new EkmanError(
      "INVALID_KEY",
      `key must be a string, received ${typeof key}`
    );
  }

  if (key.length > MAX_KEY_LENGTH) {
    throw new EkmanError(
      "INVALID_KEY",
      `key is ${key.length} characters long, and the limit is ${MAX_KEY_LENGTH}`
    );
  }

  const parts = key.split(KEY_SEPARATOR);

  if (parts.length < 2) {
    throw new EkmanError(
      "INVALID_KEY",
      `key ${JSON.stringify(key)} must be "<entity>:<segment>", it has no segment`,
      { key }
    );
  }

  for (const part of parts) {
    const fault = segmentFault(part);
    if (fault !== undefined) {
      throw new EkmanError(
        "INVALID_KEY",
        `key ${JSON.stringify(key)} has a segment ${JSON.stringify(part)} that ${fault}`,
        { key }
      );
    }
  }

  // Checked above: length >= 2 and every part is non-empty.
  const [entity, ...segments] = parts as [string, ...string[]];

  return { key, entity, segments };
}

/**
 * Build a key from an entity name and an id. The id may itself contain separators to
 * address a multi-segment key.
 *
 * The result is validated, so a bad id fails here rather than producing a key that only
 * breaks later at `send()`.
 */
export function buildKey(entity: string, id: string): string {
  const key = `${entity}${KEY_SEPARATOR}${id}`;
  parseKey(key);
  return key;
}
