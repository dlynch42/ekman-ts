import { assertKnownKeys } from "./config";
import type { CompiledTemporal } from "./constraints";
import { compileConstraints } from "./constraints";
import { EkmanError } from "./errors";
import { buildKey } from "./key";
import type { ExecutionPolicy } from "./policy";
import { assertPolicyKeys, POLICY_KEYS } from "./policy";
import { States } from "./states";
import type {
  EntityConfig,
  EntityDefinition,
  ErrorHandler,
  StateConfig,
  StateEntry,
  Trigger,
  TriggerLike,
  Values,
} from "./types";
import { ERROR_FALLBACK } from "./types";
import { sealInitialValues } from "./values";

const WHITESPACE = /\s/;

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
  assertEntityName(name);
  assertEntityConfig(name, config);

  const handlers = new Map<string, StateEntry<S, V, T>>(
    (Object.entries(config.states) as [string, StateConfig<S, V, T>][]).map(
      ([state, declared]) => [state, toStateEntry(declared, config.policy)]
    )
  );

  if (handlers.size === 0) {
    throw new EkmanError(
      "MISSING_INITIAL_STATE",
      `entity "${name}" declares no states`
    );
  }

  const initial = config.initial as S | undefined;
  if (initial === undefined || initial === "") {
    throw new EkmanError(
      "MISSING_INITIAL_STATE",
      `entity "${name}" declares no initial state`
    );
  }

  if (!handlers.has(initial)) {
    throw new EkmanError(
      "INITIAL_STATE_NOT_IN_STATES",
      `entity "${name}" declares initial state "${initial}", which has no handler. ` +
        `Declared states: ${[...handlers.keys()].join(", ")}`
    );
  }

  const triggers =
    config.triggers === undefined ? null : new Set<string>(config.triggers);

  if (triggers !== null && triggers.size === 0) {
    throw new EkmanError(
      "UNKNOWN_TRIGGER",
      `entity "${name}" declares an empty trigger list, so every trigger would be ` +
        "refused. Omit the field to accept any trigger type."
    );
  }

  const errorHandlers = new Map<string, ErrorHandler<S, V>>(
    Object.entries(config.onError ?? {}) as [string, ErrorHandler<S, V>][]
  );

  const initialValues = sealInitialValues((config.values ?? {}) as V, name);
  const classify = config.classify ?? defaultClassify;

  const states = new States(handlers.keys());

  // Compiled last, because every constraint names states and the check is worth making
  // against the states that survived validation rather than against the raw config.
  const constraints =
    config.constraints === undefined
      ? undefined
      : compileConstraints<S, V, T>(name, config.constraints, states);

  assertEscalationsRecognized(name, triggers, constraints?.temporal ?? []);

  return Object.freeze({
    name,
    initial,
    initialValues,
    unknownPolicy: config.unknown ?? "reject",
    triggers,
    states,
    handlers,
    errorHandlers,
    classify,
    constraints,
    key: (id: string) => buildKey(name, id),
  });
}

/**
 * Normalize the two ways a state may be declared into one shape.
 *
 * A bare handler inherits the entity's policy. An object form layers its own fields over
 * the entity's, field by field, so declaring only `timeoutMs` on a state does not discard
 * the entity's `maxAttempts`. The runtime's default is layered under both, later, because
 * a definition is runtime-free and cannot see it.
 */
function toStateEntry<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  declared: StateConfig<S, V, T>,
  entityPolicy: ExecutionPolicy | undefined
): StateEntry<S, V, T> {
  if (typeof declared === "function") {
    return { handler: declared, policy: entityPolicy };
  }

  const { handler, ...override } = declared;
  return { handler, policy: { ...entityPolicy, ...override } };
}

/** Classification basis for `onError` lookup. */
function defaultClassify(error: Error): string {
  return error.name;
}

/**
 * Resolve the handler for an error, falling back to `"*"`.
 *
 * Exported because dispatch and the error path both need the same lookup rule.
 */
export function resolveErrorHandler<S extends string, V extends Values>(
  definition: Pick<
    EntityDefinition<string, S, V>,
    "errorHandlers" | "classify"
  >,
  error: Error
): ErrorHandler<S, V> | undefined {
  const classification = definition.classify(error);
  return (
    definition.errorHandlers.get(classification) ??
    definition.errorHandlers.get(ERROR_FALLBACK)
  );
}

/**
 * Build a `states` record from entries, refusing duplicates.
 *
 * A TypeScript object literal cannot declare one state twice, so this exists for callers
 * that build a config from data, notably the conformance runner reading a scenario file.
 */
export function statesFromEntries<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  entityName: string,
  entries: Iterable<readonly [S, StateConfig<S, V, T>]>
): { readonly [K in S]: StateConfig<S, V, T> } {
  const out = {} as Record<string, StateConfig<S, V, T>>;
  for (const [state, declared] of entries) {
    if (Object.hasOwn(out, state)) {
      throw new EkmanError(
        "DUPLICATE_STATE_HANDLER",
        `entity "${entityName}" declares more than one handler for state "${state}"`
      );
    }
    out[state] = declared;
  }
  return out as { readonly [K in S]: StateConfig<S, V, T> };
}

/**
 * An entity name becomes the first segment of every one of its keys, so it has to obey
 * the same rules a segment does.
 */
function assertEntityName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new EkmanError(
      "INVALID_KEY",
      "entity name must be a non-empty string"
    );
  }
  if (name.includes(":") || WHITESPACE.test(name)) {
    throw new EkmanError(
      "INVALID_KEY",
      `entity name ${JSON.stringify(name)} must not contain ":" or whitespace, ` +
        "because it is the first segment of every key it addresses"
    );
  }
}

/**
 * Refuse a time bound whose escalation the entity would refuse on arrival.
 *
 * An escalation is delivered as a trigger. An entity that declares which trigger types it
 * recognizes and leaves this one out would refuse it as unknown, and the instance the bound
 * was watching would stay exactly where it was stuck. A bound that only warns delivers
 * nothing, so it is not held to this.
 */
function assertEscalationsRecognized(
  entity: string,
  triggers: ReadonlySet<string> | null,
  bounds: readonly CompiledTemporal[]
): void {
  if (triggers === null) {
    return;
  }

  for (const bound of bounds) {
    if (bound.policy !== "warn" && !triggers.has(bound.trigger)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `entity "${entity}": temporal constraint "${bound.name}" delivers trigger type ` +
          `"${bound.trigger}", which is not in the declared triggers list. Add it to ` +
          "`triggers`, or set `trigger` on the constraint to one that is declared."
      );
    }
  }
}

const ENTITY_KEYS = [
  "initial",
  "values",
  "unknown",
  "triggers",
  "states",
  "policy",
  "onError",
  "classify",
  "constraints",
] as const;

const CONSTRAINT_KEYS = [
  "transitions",
  "guards",
  "invariants",
  "temporal",
] as const;

const STATE_KEYS = ["handler", ...POLICY_KEYS] as const;

/** The options each kind of constraint declaration takes, by the key it is declared under. */
const DECLARATION_KEYS = {
  transitions: ["allow", "policy"],
  guards: ["name", "on", "from", "policy", "check"],
  invariants: ["name", "in", "policy", "check"],
  temporal: ["name", "in", "within", "escalateTo", "trigger", "policy"],
} as const;

/**
 * Refuse an unrecognized option on any single constraint declaration.
 *
 * The same reasoning as for every other level, with a sharper edge: a misspelled `policy`
 * leaves a constraint on its default of `reject`, so a rule meant only to warn starts
 * failing commits.
 */
function assertDeclarationKeys(where: string, constraints: object = {}): void {
  for (const [kind, known] of Object.entries(DECLARATION_KEYS)) {
    const declared = (constraints as Record<string, unknown>)[kind];
    const each = Array.isArray(declared) ? declared : [declared];

    each.forEach((declaration, i) => {
      if (typeof declaration === "object" && declaration !== null) {
        const which = Array.isArray(declared) ? `${kind}[${i}]` : kind;
        assertKnownKeys(`${where} constraints.${which}`, declaration, known);
      }
    });
  }
}

/**
 * Refuse an entity config that says something the runtime would silently not do.
 *
 * Two kinds of thing. A key that does not exist, at any level that takes named options,
 * is usually a misspelling of one that does. And `unknown` has exactly one value: plain
 * JavaScript can pass another, which would otherwise be accepted and behave as `reject`,
 * leaving the caller believing unrecognized triggers were handled some other way.
 */
function assertEntityConfig(
  name: string,
  config: {
    readonly unknown?: unknown;
    readonly policy?: ExecutionPolicy;
    readonly constraints?: object;
    readonly states?: Readonly<Record<string, unknown>>;
  }
): void {
  const where = `entity "${name}"`;

  assertKnownKeys(where, config, ENTITY_KEYS);
  assertKnownKeys(`${where} constraints`, config.constraints, CONSTRAINT_KEYS);
  assertDeclarationKeys(where, config.constraints);
  assertPolicyKeys(config.policy, `${where} policy`);

  for (const [state, declared] of Object.entries(config.states ?? {})) {
    if (typeof declared === "object" && declared !== null) {
      const label = `${where} state "${state}"`;
      assertKnownKeys(label, declared, STATE_KEYS);
      assertPolicyKeys(withoutHandler(declared), label);
    }
  }

  if (config.unknown !== undefined && config.unknown !== "reject") {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${where} declares unknown policy ${JSON.stringify(config.unknown)}. The only ` +
        'policy is "reject": a trigger the entity does not recognize is refused and ' +
        'the refusal is recorded. Omit the field, or set it to "reject".'
    );
  }
}

function withoutHandler(declared: object): ExecutionPolicy {
  const { handler: _handler, ...policy } = declared as { handler?: unknown };
  return policy;
}
