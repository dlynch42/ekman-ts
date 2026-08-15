import type {
  AnyEntityDefinition,
  Handler,
  HandlerResult,
  InstanceSnapshot,
  Trigger,
} from "../src/index";
import {
  defineEntity,
  fail,
  statesFromEntries,
  stay,
  transitionTo,
} from "../src/index";
import type { DoSpec, EntitySpec, Given, StateSpec } from "./scenario";

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
  }) as AnyEntityDefinition;
}

export function buildEntities(given: Given): AnyEntityDefinition[] {
  return given.entities.map(buildEntity);
}

/**
 * A clock that starts at `start` and advances `stepMs` on every read, so scenarios can
 * assert on event timestamps.
 */
export function buildClock(given: Given): (() => number) | undefined {
  const clock = given.runtime?.clock;
  if (clock === undefined) {
    return;
  }

  let current = clock.start - clock.stepMs;
  return () => {
    current += clock.stepMs;
    return current;
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
      const target = action.to as string;
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
