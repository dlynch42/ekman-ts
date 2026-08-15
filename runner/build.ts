import type {
  AnyEntityDefinition,
  ConstraintCheck,
  ConstraintsConfig,
  ErrorHandler,
  Handler,
  HandlerResult,
  InstanceSnapshot,
  ProposedCommit,
  Trigger,
} from "../src/index";
import {
  defineEntity,
  fail,
  statesFromEntries,
  stay,
  transitionTo,
} from "../src/index";
import type {
  CheckSpec,
  ConstraintsSpec,
  DoSpec,
  EntitySpec,
  Given,
  StateSpec,
} from "./scenario";

/**
 * Compile a scenario's declarative entity spec into a real entity definition.
 *
 * Everything the runner drives goes through the library's public API, so a scenario
 * exercises the same surface an application would.
 */
export function buildEntity(spec: EntitySpec): AnyEntityDefinition {
  const states = statesFromEntries(
    spec.name,
    spec.states.map(
      (state) =>
        [
          state.state,
          // A state declaring a policy compiles to the object form, which is the same
          // choice an application author makes when a state needs its own policy.
          state.policy === undefined
            ? compileState(state)
            : { handler: compileState(state), ...state.policy },
        ] as const
    )
  );

  return defineEntity(spec.name, {
    initial: spec.initial,
    states,
    ...(spec.values === undefined ? {} : { values: spec.values }),
    ...(spec.unknown === undefined ? {} : { unknown: spec.unknown }),
    ...(spec.triggers === undefined ? {} : { triggers: spec.triggers }),
    ...(spec.policy === undefined ? {} : { policy: spec.policy }),
    ...(spec.constraints === undefined
      ? {}
      : { constraints: buildConstraints(spec.constraints) }),
    ...(spec.onError === undefined
      ? {}
      : { onError: buildErrorHandlers(spec.onError) }),
  }) as AnyEntityDefinition;
}

/**
 * Compile the declarative constraint spec into the real configuration.
 *
 * Only the checks need translating. Everything else in a constraint is already data, which
 * is the point: a port reimplements `compileCheck` and inherits every constraint scenario.
 */
function buildConstraints(spec: ConstraintsSpec): ConstraintsConfig {
  return {
    ...(spec.transitions === undefined
      ? {}
      : { transitions: spec.transitions }),
    ...(spec.temporal === undefined ? {} : { temporal: spec.temporal }),
    ...(spec.guards === undefined
      ? {}
      : {
          guards: spec.guards.map((guard) => ({
            ...guard,
            check: compileCheck(guard.check),
          })),
        }),
    ...(spec.invariants === undefined
      ? {}
      : {
          invariants: spec.invariants.map((invariant) => ({
            ...invariant,
            check: compileCheck(invariant.check),
          })),
        }),
  };
}

/** One source, one predicate. See `CheckSpec` for why it is this small. */
function compileCheck(spec: CheckSpec): ConstraintCheck {
  return (next, _instance, trigger) => {
    if (spec.throw !== undefined) {
      throw new Error(spec.throw);
    }

    const subject = readSubject(spec, next, trigger);
    return holds(spec, subject) ? true : (spec.reason ?? false);
  };
}

function readSubject(
  spec: CheckSpec,
  next: ProposedCommit,
  trigger: Trigger
): unknown {
  if (spec.state === true) {
    return next.state;
  }
  if (spec.trigger !== undefined) {
    return read(trigger, spec.trigger);
  }
  if (spec.values !== undefined) {
    return read(next.values, spec.values);
  }
  throw new Error(
    `check declares no source: ${JSON.stringify(spec)}. Use values, trigger or state.`
  );
}

function holds(spec: CheckSpec, subject: unknown): boolean {
  if (spec.exists !== undefined) {
    return (subject !== undefined) === spec.exists;
  }
  if (spec.equals !== undefined) {
    return Object.is(subject, spec.equals);
  }
  if (spec.gte !== undefined) {
    return typeof subject === "number" && subject >= spec.gte;
  }
  if (spec.lte !== undefined) {
    return typeof subject === "number" && subject <= spec.lte;
  }
  throw new Error(
    `check declares no predicate: ${JSON.stringify(spec)}. Use exists, equals, gte or lte.`
  );
}

function buildErrorHandlers(
  spec: Readonly<Record<string, DoSpec>>
): Record<string, ErrorHandler> {
  return Object.fromEntries(
    Object.entries(spec).map(([classification, action]) => [
      classification,
      ((instance, _error, _ctx) =>
        toResult(action, instance, EMPTY_TRIGGER)) as ErrorHandler,
    ])
  );
}

/**
 * An error handler receives no trigger, so a `$trigger` reference in its result has
 * nothing to read. This stands in for one so the same `do` shape works in both places.
 */
const EMPTY_TRIGGER: Trigger = { type: "error" };

export function buildEntities(given: Given): AnyEntityDefinition[] {
  return given.entities.map(buildEntity);
}

/**
 * A clock a scenario controls.
 *
 * `now` advances `stepMs` on every read, which is what makes an event's `at` assertable.
 * `advance` moves it by an arbitrary amount, which is how a scenario ages an instance past
 * a temporal bound without waiting for real time to pass. A `stepMs` of 0 gives a frozen
 * clock that only `advance` moves, and that is the right setting for anything measuring
 * elapsed time, because otherwise the answer depends on how many times the runtime happens
 * to read its own clock.
 */
export interface ScenarioClock {
  now: () => number;
  advance: (ms: number) => void;
}

export function buildClock(given: Given): ScenarioClock | undefined {
  const clock = given.runtime?.clock;
  if (clock === undefined) {
    return;
  }

  let current = clock.start - clock.stepMs;
  return {
    now: () => {
      current += clock.stepMs;
      return current;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function compileState(spec: StateSpec): Handler {
  return async (instance, trigger, ctx) => {
    // Every declared condition must match. `attempt` is what lets a scenario say
    // "fail the first time, commit the second", which is the whole of retry behaviour.
    const matched = spec.cases?.find(
      (candidate) =>
        (candidate.when?.trigger === undefined ||
          candidate.when.trigger === trigger.type) &&
        (candidate.when?.attempt === undefined ||
          candidate.when.attempt === ctx.attempt)
    );

    const action = matched?.do ?? spec.else;
    // No case matched and no `else`: ordinary handler logic that changes nothing.
    if (action === undefined) {
      return stay();
    }

    if (action.delayMs !== undefined && action.delayMs > 0) {
      await new Promise((done) => setTimeout(done, action.delayMs));
    }

    if (action.throw !== undefined) {
      throw named(new Error(action.throw), action.errorName);
    }

    return toResult(action, instance, trigger);
  };
}

function toResult(
  action: DoSpec,
  instance: InstanceSnapshot,
  trigger: Trigger
): HandlerResult {
  const context = { trigger, values: instance.values, key: instance.key };

  switch (action.result) {
    case "transitionTo": {
      // Resolvable, not just a literal, because an escalation carries its target on the
      // trigger and the handler is what applies it.
      const target = resolve(action.to, context);
      if (typeof target !== "string") {
        throw new Error(
          `transitionTo target must resolve to a state name, got ${JSON.stringify(target)}`
        );
      }
      return action.values === undefined
        ? transitionTo(target)
        : transitionTo(target, resolveValues(action.values, context));
    }
    case "stay":
      return action.values === undefined
        ? stay()
        : stay(resolveValues(action.values, context));
    case "fail":
      return fail(named(new Error(action.error ?? "failed"), action.errorName));
    default:
      throw new Error(
        `scenario declares no result and no throw: ${JSON.stringify(action)}`
      );
  }
}

function named(error: Error, name: string | undefined): Error {
  if (name !== undefined) {
    error.name = name;
  }
  return error;
}

interface ResolveContext {
  trigger: Trigger;
  values: Readonly<Record<string, unknown>>;
  key: string;
}

function resolveValues(
  expr: unknown,
  context: ResolveContext
): Record<string, unknown> {
  const resolved = resolve(expr, context);
  if (
    typeof resolved !== "object" ||
    resolved === null ||
    Array.isArray(resolved)
  ) {
    throw new Error(
      `values expression must resolve to an object, got ${JSON.stringify(resolved)}`
    );
  }
  return resolved as Record<string, unknown>;
}

/**
 * Resolve a value expression. Any single-key object whose key starts with `$` is a
 * reference into the current dispatch; everything else is a literal.
 */
export function resolve(expr: unknown, context: ResolveContext): unknown {
  if (Array.isArray(expr)) {
    return expr.map((item) => resolve(item, context));
  }
  if (typeof expr !== "object" || expr === null) {
    return expr;
  }

  const entries = Object.entries(expr as Record<string, unknown>);
  const [first] = entries;

  if (entries.length === 1 && first !== undefined && first[0].startsWith("$")) {
    return dereference(first[0], String(first[1]), context);
  }

  return Object.fromEntries(
    entries.map(([key, value]) => [key, resolve(value, context)])
  );
}

function dereference(
  reference: string,
  path: string,
  context: ResolveContext
): unknown {
  switch (reference) {
    case "$trigger":
      return read(context.trigger, path);
    case "$values":
      return read(context.values, path);
    case "$key":
      return path === "" ? context.key : read({ key: context.key }, path);
    default:
      throw new Error(`unknown value reference "${reference}"`);
  }
}

function read(source: unknown, path: string): unknown {
  if (path === "") {
    return source;
  }

  let current = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
