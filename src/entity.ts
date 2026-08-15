import { EkmanError } from "./errors"
import { buildKey } from "./key"
import { ERROR_FALLBACK } from "./types"
import type {
  EntityConfig,
  EntityDefinition,
  ErrorHandler,
  Handler,
  Trigger,
  TriggerLike,
  Values,
} from "./types"

/**
 * Define an entity: its states, handlers, and policies for one domain.
 *
 * The result is runtime-free. It holds no reference to an `Ekman`, so it can be unit
 * tested on its own and registered with more than one runtime.
 *
 * Types are inferred: the state union comes from the keys of `states`, and the values
 * type from `values`. To pin all three type parameters explicitly, annotate the
 * binding instead of passing type arguments, which also keeps the name literal:
 *
 * ```ts
 * export const deployments: EntityDefinition<"deployments", State, Values, Trigger> =
 *   defineEntity("deployments", { initial: "pending", states: { ... } })
 * ```
 */
export function defineEntity<
  const N extends string,
  S extends string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
>(name: N, config: EntityConfig<S, V, T>): EntityDefinition<N, S, V, T> {
  assertEntityName(name)

  if (config.constraints !== undefined) {
    throw new EkmanError(
      "NOT_IMPLEMENTED",
      `entity "${name}" declares constraints, which are not implemented yet. ` +
        `Remove the field rather than leaving it set: a constraint that is configured ` +
        `but not enforced is worse than no constraint.`,
    )
  }

  const states = new Map<string, Handler<S, V, T>>(
    Object.entries(config.states) as [string, Handler<S, V, T>][],
  )

  if (states.size === 0) {
    throw new EkmanError("MISSING_INITIAL_STATE", `entity "${name}" declares no states`)
  }

  const initial = config.initial as S | undefined
  if (initial === undefined || initial === "") {
    throw new EkmanError("MISSING_INITIAL_STATE", `entity "${name}" declares no initial state`)
  }

  if (!states.has(initial)) {
    throw new EkmanError(
      "INITIAL_STATE_NOT_IN_STATES",
      `entity "${name}" declares initial state "${initial}", which has no handler. ` +
        `Declared states: ${[...states.keys()].join(", ")}`,
    )
  }

  const triggers =
    config.triggers === undefined ? null : new Set<string>(config.triggers)

  if (triggers !== null && triggers.size === 0) {
    throw new EkmanError(
      "UNKNOWN_TRIGGER",
      `entity "${name}" declares an empty trigger list, so every trigger would be ` +
        `refused. Omit the field to accept any trigger type.`,
    )
  }

  const errorHandlers = new Map<string, ErrorHandler<S, V>>(
    Object.entries(config.onError ?? {}) as [string, ErrorHandler<S, V>][],
  )

  const initialValues = Object.freeze({ ...(config.values ?? {}) }) as Readonly<V>
  const classify = config.classify ?? defaultClassify

  return Object.freeze({
    name,
    initial,
    initialValues,
    unknownPolicy: config.unknown ?? "reject",
    triggers,
    states,
    errorHandlers,
    classify,
    key: (id: string) => buildKey(name, id),
  })
}

/** Classification basis for `onError` lookup. */
function defaultClassify(error: Error): string {
  return error.name
}

/**
 * Resolve the handler for an error, falling back to `"*"`.
 *
 * Exported because dispatch and the error path both need the same lookup rule.
 */
export function resolveErrorHandler<S extends string, V extends Values>(
  definition: Pick<EntityDefinition<string, S, V>, "errorHandlers" | "classify">,
  error: Error,
): ErrorHandler<S, V> | undefined {
  const classification = definition.classify(error)
  return definition.errorHandlers.get(classification) ?? definition.errorHandlers.get(ERROR_FALLBACK)
}

/**
 * Build a `states` record from entries, refusing duplicates.
 *
 * A TypeScript object literal cannot declare one state twice, so this exists for callers
 * that build a config from data, notably the conformance runner reading a scenario file.
 */
export function statesFromEntries<S extends string, V extends Values, T extends TriggerLike>(
  entityName: string,
  entries: Iterable<readonly [S, Handler<S, V, T>]>,
): { readonly [K in S]: Handler<S, V, T> } {
  const out = {} as Record<string, Handler<S, V, T>>
  for (const [state, handler] of entries) {
    if (Object.prototype.hasOwnProperty.call(out, state)) {
      throw new EkmanError(
        "DUPLICATE_STATE_HANDLER",
        `entity "${entityName}" declares more than one handler for state "${state}"`,
      )
    }
    out[state] = handler
  }
  return out as { readonly [K in S]: Handler<S, V, T> }
}

/**
 * An entity name becomes the first segment of every one of its keys, so it has to obey
 * the same rules a segment does.
 */
function assertEntityName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new EkmanError("INVALID_KEY", "entity name must be a non-empty string")
  }
  if (name.includes(":") || /\s/.test(name)) {
    throw new EkmanError(
      "INVALID_KEY",
      `entity name ${JSON.stringify(name)} must not contain ":" or whitespace, ` +
        `because it is the first segment of every key it addresses`,
    )
  }
}
