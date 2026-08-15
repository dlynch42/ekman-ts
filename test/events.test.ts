import { describe, expect, it } from "vitest"
import { isTransitionEvent, rejectedEvent, transitionEvent } from "../src/events"
import type { EkmanEvent } from "../src/events"

const cause = { type: "approve", id: "t1" }

describe("transitionEvent", () => {
  it("tags itself and keeps every field", () => {
    const event = transitionEvent({
      key: "orders:1",
      from: "pending",
      to: "approved",
      seq: 1,
      at: 1000,
      cause,
      values: { by: "amy" },
    })

    expect(event).toEqual({
      type: "transition",
      key: "orders:1",
      from: "pending",
      to: "approved",
      seq: 1,
      at: 1000,
      cause,
      values: { by: "amy" },
    })
  })

  it("is frozen, because history must not be editable after the fact", () => {
    const event = transitionEvent({
      key: "orders:1",
      from: null,
      to: "pending",
      seq: 0,
      at: 0,
      cause,
      values: {},
    })
    expect(Object.isFrozen(event)).toBe(true)
  })

  it("accepts a null from, which is how initialization is represented", () => {
    const event = transitionEvent({
      key: "orders:1",
      from: null,
      to: "pending",
      seq: 0,
      at: 0,
      cause: { type: "init", id: "t1" },
      values: {},
    })
    expect(event.from).toBeNull()
  })
})

describe("rejectedEvent", () => {
  it("tags itself and carries the code and reason", () => {
    const event = rejectedEvent({
      key: "orders:1",
      seq: 3,
      at: 1000,
      cause,
      code: "UNKNOWN_STATE",
      reason: "no handler",
    })

    expect(event).toMatchObject({ type: "rejected", code: "UNKNOWN_STATE", reason: "no handler", seq: 3 })
    expect(Object.isFrozen(event)).toBe(true)
  })
})

describe("isTransitionEvent", () => {
  const transition: EkmanEvent = transitionEvent({
    key: "orders:1",
    from: null,
    to: "pending",
    seq: 0,
    at: 0,
    cause,
    values: {},
  })
  const rejected: EkmanEvent = rejectedEvent({
    key: "orders:1",
    seq: 0,
    at: 0,
    cause,
    code: "UNKNOWN_STATE",
    reason: "no handler",
  })

  it("selects transitions", () => {
    expect(isTransitionEvent(transition)).toBe(true)
  })

  it("excludes everything else, which is what makes replay safe", () => {
    expect(isTransitionEvent(rejected)).toBe(false)
  })

  it("narrows the type so replay can read `to` without a cast", () => {
    const stream: EkmanEvent[] = [transition, rejected]
    const states = stream.filter(isTransitionEvent).map((event) => event.to)
    expect(states).toEqual(["pending"])
  })
})
