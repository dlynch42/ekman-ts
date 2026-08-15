import { describe, expect, it } from "vitest"
import { EkmanError } from "../src/errors.js"
import { buildKey, parseKey } from "../src/key.js"

const invalid = (key: string) => {
  try {
    parseKey(key)
  } catch (err) {
    return err as EkmanError
  }
  throw new Error(`expected parseKey(${JSON.stringify(key)}) to throw`)
}

describe("parseKey", () => {
  it("splits an entity name and one segment", () => {
    expect(parseKey("orders:1")).toEqual({
      key: "orders:1",
      entity: "orders",
      segments: ["1"],
    })
  })

  it("accepts many segments", () => {
    expect(parseKey("orders:tenant-a:42")).toEqual({
      key: "orders:tenant-a:42",
      entity: "orders",
      segments: ["tenant-a", "42"],
    })
  })

  it("keeps the key verbatim as the public identity", () => {
    // No normalizing, no lowercasing, no hashing. What you send is what appears in
    // history, queries and events.
    expect(parseKey("Orders:AbC-123").key).toBe("Orders:AbC-123")
  })

  it.each([
    ["no segment at all", "orders"],
    ["empty string", ""],
    ["trailing separator", "orders:"],
    ["leading separator", ":1"],
    ["empty middle segment", "orders::1"],
    ["space inside a segment", "orders:a b"],
    ["tab inside a segment", "orders:a\tb"],
    ["newline inside a segment", "orders:a\nb"],
    ["space inside the entity name", "my orders:1"],
    ["leading whitespace", " orders:1"],
    ["trailing whitespace", "orders:1 "],
  ])("rejects %s", (_why, key) => {
    const err = invalid(key)
    expect(err).toBeInstanceOf(EkmanError)
    expect(err.code).toBe("INVALID_KEY")
  })

  it("reports the offending key on the error", () => {
    expect(invalid("orders::1").key).toBe("orders::1")
  })

  it("rejects a non-string key", () => {
    const err = invalid(42 as unknown as string)
    expect(err.code).toBe("INVALID_KEY")
  })
})

describe("buildKey", () => {
  it("joins an entity name and an id", () => {
    expect(buildKey("orders", "1")).toBe("orders:1")
  })

  it("accepts a multi-segment id", () => {
    expect(buildKey("orders", "tenant-a:42")).toBe("orders:tenant-a:42")
  })

  it("validates the result rather than producing a broken key", () => {
    expect(() => buildKey("orders", "a b")).toThrow(EkmanError)
    expect(() => buildKey("orders", "")).toThrow(EkmanError)
  })

  it("round-trips with parseKey", () => {
    expect(parseKey(buildKey("orders", "tenant-a:42")).segments).toEqual(["tenant-a", "42"])
  })
})
