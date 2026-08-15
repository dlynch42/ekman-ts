import { EkmanError } from "./errors"

/** The separator between an entity name and its segments. */
export const KEY_SEPARATOR = ":"

export interface ParsedKey {
  /** The key exactly as given. This is the public identity, never normalized. */
  readonly key: string
  /** The first segment, which names the entity. */
  readonly entity: string
  /** Every segment after the entity name. Always at least one. */
  readonly segments: readonly string[]
}

/**
 * A key is `<entity>:<segment>(:<segment>)*`. Segments are non-empty and contain no
 * separator and no whitespace.
 *
 * Keys are treated as opaque public identities: they are not normalized, lowercased, or
 * hashed. Whatever is passed here is what shows up in history, queries, and events.
 */
export function parseKey(key: string): ParsedKey {
  if (typeof key !== "string") {
    throw new EkmanError("INVALID_KEY", `key must be a string, received ${typeof key}`)
  }

  const parts = key.split(KEY_SEPARATOR)

  if (parts.length < 2) {
    throw new EkmanError(
      "INVALID_KEY",
      `key ${JSON.stringify(key)} must be "<entity>:<segment>", it has no segment`,
      { key },
    )
  }

  for (const part of parts) {
    if (part.length === 0) {
      throw new EkmanError(
        "INVALID_KEY",
        `key ${JSON.stringify(key)} has an empty segment`,
        { key },
      )
    }
    if (/\s/.test(part)) {
      throw new EkmanError(
        "INVALID_KEY",
        `key ${JSON.stringify(key)} has whitespace in segment ${JSON.stringify(part)}`,
        { key },
      )
    }
  }

  // Checked above: length >= 2 and every part is non-empty.
  const [entity, ...segments] = parts as [string, ...string[]]

  return { key, entity, segments }
}

/**
 * Build a key from an entity name and an id. The id may itself contain separators to
 * address a multi-segment key.
 *
 * The result is validated, so a bad id fails here rather than producing a key that only
 * breaks later at `send()`.
 */
export function buildKey(entity: string, id: string): string {
  const key = `${entity}${KEY_SEPARATOR}${id}`
  parseKey(key)
  return key
}
