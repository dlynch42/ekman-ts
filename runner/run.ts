import { Ekman } from "../src/index"
import type { EkmanError } from "../src/index"
import { buildClock, buildEntities } from "./build"
import { isSendStep } from "./scenario"
import type { Scenario, SendExpectation, StateExpectation, Step } from "./scenario"

export interface ScenarioResult {
  readonly scenario: Scenario
  readonly status: "passed" | "failed"
  readonly failures: readonly string[]
}

interface Outcome {
  outcome: "committed" | "rejected"
  state?: string
  seq?: number
  values?: Record<string, unknown>
  code?: string
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const failures: string[] = []

  try {
    await execute(scenario, failures)
  } catch (error) {
    failures.push(`threw outside the scenario: ${(error as Error).stack ?? String(error)}`)
  }

  return {
    scenario,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  }
}

async function execute(scenario: Scenario, failures: string[]): Promise<void> {
  const expectBuildError = scenario.then?.buildError

  // A scenario may assert that its own `given` is invalid and must be refused at build
  // time, before any trigger is sent.
  if (expectBuildError !== undefined) {
    try {
      buildRuntime(scenario)
      failures.push(`expected building to fail with ${expectBuildError.code}, but it succeeded`)
    } catch (error) {
      const code = (error as EkmanError).code
      if (code !== expectBuildError.code) {
        failures.push(
          `expected build error ${expectBuildError.code}, got ${code ?? "a non-Ekman error"}: ${(error as Error).message}`,
        )
      }
    }
    return
  }

  const ekman = buildRuntime(scenario)
  const outcomes = await deliver(ekman, scenario.when ?? [])

  assertSends(scenario.then?.sends, outcomes, failures)
  assertEvents(scenario, ekman, failures)
  assertState(scenario.then?.state, ekman, failures)
}

function buildRuntime(scenario: Scenario): Ekman {
  const now = buildClock(scenario.given)
  return new Ekman({
    entities: buildEntities(scenario.given),
    ...(now === undefined ? {} : { now }),
    // A scenario asserts on outcomes, so a stray post() failure must not print noise.
    onUnhandled: () => {},
  })
}

async function deliver(ekman: Ekman, steps: readonly Step[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = []
  const inFlight: Promise<void>[] = []
  let index = 0

  for (const step of steps) {
    if (!isSendStep(step)) {
      await Promise.all(inFlight)
      continue
    }

    const slot = index
    index += 1

    const settled = ekman.send(step.send.key, step.send.trigger).then(
      (result) => {
        outcomes[slot] = {
          outcome: "committed",
          state: result.state,
          seq: result.seq,
          values: result.values as Record<string, unknown>,
        }
      },
      (error: EkmanError) => {
        outcomes[slot] = { outcome: "rejected", code: error.code }
      },
    )

    inFlight.push(settled)

    // `await: false` leaves the send in flight so a later step can overlap it.
    if (step.await !== false) await settled
  }

  await Promise.all(inFlight)
  return outcomes
}

function assertSends(
  expected: readonly SendExpectation[] | undefined,
  actual: readonly Outcome[],
  failures: string[],
): void {
  if (expected === undefined) return

  if (expected.length !== actual.length) {
    failures.push(`then.sends expects ${expected.length} send steps, scenario ran ${actual.length}`)
    return
  }

  expected.forEach((want, i) => {
    const got = actual[i]
    if (got === undefined) {
      failures.push(`sends[${i}]: no outcome recorded`)
      return
    }

    if (want.outcome !== got.outcome) {
      failures.push(
        `sends[${i}]: expected ${want.outcome}, got ${got.outcome}${got.code === undefined ? "" : ` (${got.code})`}`,
      )
      return
    }

    for (const field of ["state", "seq", "code"] as const) {
      if (want[field] !== undefined && want[field] !== got[field]) {
        failures.push(`sends[${i}].${field}: expected ${String(want[field])}, got ${String(got[field])}`)
      }
    }

    if (want.values !== undefined) {
      failures.push(...diff(`sends[${i}].values`, got.values, want.values))
    }
  })
}

function assertEvents(scenario: Scenario, ekman: Ekman, failures: string[]): void {
  const expected = scenario.then?.events
  if (expected === undefined) return

  // `at` is only deterministic when the scenario declares a clock.
  const ignore = scenario.given.runtime?.clock === undefined ? new Set(["at"]) : new Set<string>()

  for (const [key, wantEvents] of Object.entries(expected)) {
    const gotEvents = ekman.history(key)

    if (wantEvents.length !== gotEvents.length) {
      failures.push(
        `events["${key}"]: expected ${wantEvents.length} events, got ${gotEvents.length} ` +
          `(${gotEvents.map(describeEvent).join(", ")})`,
      )
      continue
    }

    wantEvents.forEach((want, i) => {
      failures.push(
        ...diff(`events["${key}"][${i}]`, gotEvents[i] as unknown as Record<string, unknown>, want, ignore),
      )
    })
  }
}

function assertState(
  expected: Readonly<Record<string, StateExpectation | null>> | undefined,
  ekman: Ekman,
  failures: string[],
): void {
  if (expected === undefined) return

  for (const [key, want] of Object.entries(expected)) {
    const got = ekman.inspect(key)

    if (want === null) {
      if (got !== undefined) failures.push(`state["${key}"]: expected no instance, got ${got.state}`)
      continue
    }

    if (got === undefined) {
      failures.push(`state["${key}"]: expected an instance, found none`)
      continue
    }

    if (want.state !== undefined && want.state !== got.state) {
      failures.push(`state["${key}"].state: expected ${want.state}, got ${got.state}`)
    }
    if (want.seq !== undefined && want.seq !== got.seq) {
      failures.push(`state["${key}"].seq: expected ${want.seq}, got ${got.seq}`)
    }
    if (want.values !== undefined) {
      failures.push(...diff(`state["${key}"].values`, got.values, want.values))
    }
  }
}

/**
 * Compare `want` against `got` as a subset: only the fields the scenario names are
 * asserted, so scenarios stay narrow and do not break when an event gains a field.
 */
function diff(
  path: string,
  got: unknown,
  want: unknown,
  ignore: ReadonlySet<string> = new Set(),
): string[] {
  if (want === null || typeof want !== "object") {
    return Object.is(got, want) ? [] : [`${path}: expected ${json(want)}, got ${json(got)}`]
  }

  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return [`${path}: expected an array, got ${json(got)}`]
    if (got.length !== want.length) {
      return [`${path}: expected ${want.length} items, got ${got.length}`]
    }
    return want.flatMap((item, i) => diff(`${path}[${i}]`, got[i], item, ignore))
  }

  if (typeof got !== "object" || got === null || Array.isArray(got)) {
    return [`${path}: expected an object, got ${json(got)}`]
  }

  return Object.entries(want as Record<string, unknown>)
    .filter(([field]) => !ignore.has(field))
    .flatMap(([field, value]) =>
      diff(`${path}.${field}`, (got as Record<string, unknown>)[field], value, ignore),
    )
}

function describeEvent(event: { type: string; seq: number }): string {
  return `${event.type}@${event.seq}`
}

function json(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value)
}
