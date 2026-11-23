import { sealConstraints } from "./compiled";
import { assertKnownKeys } from "./config";
import { compileConstraints } from "./constraints";
import { EkmanError } from "./errors";
import { buildKey, KEY_SEPARATOR, segmentFault } from "./key";
import type { ExecutionPolicy } from "./policy";
import { assertPolicyKeys, POLICY_KEYS } from "./policy";
import { States } from "./states";
import type {
  EntityConfig,
  EntityDefinition,
  ErrorHandler,
  Handler,
  StateConfig,
  StateEntry,
  Trigger,
  TriggerLike,
  Values,
} from "./types";
import { ERROR_FALLBACK } from "./types";
import { sealInitialValues } from "./values";

/**
 * Define an entity: its states, handlers, and policies for one domain.
 *
 * The result is runtime-free. It holds no reference to an `Ekman`, so it can be unit
 * tested on its own and registered with more than one runtime.
 *
 * Types are inferred: the state union comes from the keys of `states`, and the values
 * type from `values`. Trigger payloads are `unknown` unless the entity is given a trigger
 * union, which is what `defineEntity.withTriggers` is for.
 *
 * To pin every type parameter explicitly, annotate the binding instead of passing type
 * arguments, which also keeps the name literal:
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
    config.triggers === undefined
      ? handledEverywhere(handlers)
      : new Set<string>(config.triggers);

  if (triggers !== null && triggers.size === 0) {
    throw new EkmanError(
      "UNKNOWN_TRIGGER",
      `entity "${name}" declares an empty trigger list, so every trigger would be ` +
        "refused. Omit the field to accept any trigger type."
    );
  }

  assertHandledAreRecognized(name, triggers, handlers);

  const errorHandlers = new Map<string, ErrorHandler<S, V>>(
    Object.entries(config.onError ?? {}) as [string, ErrorHandler<S, V>][]
  );

  const initialValues = sealInitialValues((config.values ?? {}) as V, name);
  const classify = config.classify ?? defaultClassify;

  const states = new States(handlers.keys());

  // Compiled last, because every constraint names states and the check is worth making
  // against the states that survived validation rather than against the raw config.
  const compiled =
    config.constraints === undefined
      ? undefined
      : compileConstraints<S, V, T>(name, config.constraints, states);

  assertEscalationsRecognized(
    name,
    triggers,
    "temporal constraint",
    compiled?.temporal ?? []
  );
  assertEscalationsRecognized(name, triggers, "rule", compiled?.rules ?? []);
  assertEscalationsRecognized(
    name,
    triggers,
    "stale constraint",
    compiled?.stale ?? []
  );

  assertEscalationsHandled(name, handlers, "temporal constraint", [
    ...(compiled?.temporal ?? []).map((bound) => ({
      ...bound,
      in: [bound.in],
      proposes: undefined,
    })),
  ]);
  assertEscalationsHandled(
    name,
    handlers,
    "rule",
    (compiled?.rules ?? []).map(scoped)
  );
  assertEscalationsHandled(
    name,
    handlers,
    "stale constraint",
    (compiled?.stale ?? []).map(scoped)
  );

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
    constraints: sealConstraints(compiled),
    key: (id: string) => buildKey(name, id),
  });
}

/**
 * Define an entity whose trigger union is given explicitly, with the name, states and
 * values still inferred from the config.
 *
 * The union cannot be inferred from a handler's parameters, because inferring from the
 * `states` values is what would widen the state union. So it is supplied first, on its own,
 * and everything else follows from the config as usual:
 *
 * ```ts
 * type OrderTrigger =
 *   | { type: "pay"; amount: number }
 *   | { type: "refund"; reason: string };
 *
 * const orders = defineEntity.withTriggers<OrderTrigger>()("orders", {
 *   initial: "pending",
 *   states: {
 *     pending: (order, trigger) =>
 *       trigger.type === "pay" ? transitionTo("paid", { total: trigger.amount }) : stay(),
 *     paid: () => stay(),
 *   },
 * });
 * ```
 *
 * `entities.orders.send` then refuses a payload outside the union at compile time, and a
 * `triggers` list is checked against the union's types.
 */
defineEntity.withTriggers =
  <T extends TriggerLike>() =>
  <const N extends string, S extends string, V extends Values = Values>(
    name: N,
    config: EntityConfig<S, V, T>
  ): EntityDefinition<N, S, V, T> =>
    defineEntity<N, S, V, T>(name, config);

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

  const { handler, on, ...override } = declared as ExecutionPolicy & {
    readonly handler?: Handler<S, V, T>;
    readonly on?: Readonly<Record<string, Handler<S, V, T>>>;
  };
  const policy = { ...entityPolicy, ...override };

  // Exactly one of the two is set: `assertStateConfig` refused every other shape.
  return on === undefined
    ? { handler: handler as Handler<S, V, T>, policy }
    : {
        on: new Map(Object.entries(on)),
        policy,
      };
}

/** As much of the states as the trigger checks read: which types each one names, if any. */
type StatesByName = ReadonlyMap<
  string,
  { readonly on?: ReadonlyMap<string, unknown> }
>;

/**
 * The trigger types an entity recognizes when it declares no `triggers` list.
 *
 * Null, meaning every type, as soon as one state takes any trigger. When every state names
 * the types it handles, those names are the whole of what the entity can do anything with,
 * so a type none of them names is unrecognized rather than merely unhandled where it landed.
 */
function handledEverywhere(handlers: StatesByName): Set<string> | null {
  const handled = new Set<string>();
  for (const entry of handlers.values()) {
    if (entry.on === undefined) {
      return null;
    }
    for (const type of entry.on.keys()) {
      handled.add(type);
    }
  }
  return handled;
}

/** Refuse a state that names a trigger type the entity's own `triggers` list leaves out. */
function assertHandledAreRecognized(
  entity: string,
  triggers: ReadonlySet<string> | null,
  handlers: StatesByName
): void {
  if (triggers === null) {
    return;
  }

  for (const [state, entry] of handlers) {
    for (const type of entry.on?.keys() ?? []) {
      if (!triggers.has(type)) {
        throw new EkmanError(
          "INVALID_CONFIG",
          `entity "${entity}" state "${state}" handles trigger type "${type}", which is ` +
            "not in the declared triggers list, so it would be refused before it reached " +
            "the state. Add it to `triggers`, or remove the entry."
        );
      }
    }
  }
}

interface ScopedEscalation {
  readonly name: string;
  readonly trigger: string;
  readonly policy: "reject" | "warn";
  /** The states it is asked in. Null means every state. */
  readonly in: Iterable<string> | null;
  /** The state it proposes, where it is never asked. */
  readonly proposes: string | undefined;
}

function scoped(bound: {
  readonly name: string;
  readonly trigger: string;
  readonly policy: "reject" | "warn";
  readonly in: ReadonlySet<string> | null;
  readonly propose: string | undefined;
}): ScopedEscalation {
  return { ...bound, proposes: bound.propose };
}

/**
 * Refuse a time bound or a rule that delivers its trigger to a state with no handler for it.
 *
 * The per-state half of `assertEscalationsRecognized`. A state that names its trigger
 * types refuses every other one, the runtime's included, and a refused escalation is
 * final for that stay in the state: the instance being watched would sit where it was.
 *
 * Only states the declaration names are held to this. One that applies in every state
 * says nothing about any state in particular, and is left to the refusal at delivery.
 */
function assertEscalationsHandled(
  entity: string,
  handlers: StatesByName,
  what: string,
  bounds: readonly ScopedEscalation[]
): void {
  for (const bound of bounds) {
    if (bound.policy === "warn" || bound.in === null) {
      continue;
    }

    for (const state of bound.in) {
      const on = handlers.get(state)?.on;
      if (
        on === undefined ||
        on.has(bound.trigger) ||
        state === bound.proposes
      ) {
        continue;
      }
      throw new EkmanError(
        "INVALID_CONFIG",
        `entity "${entity}": ${what} "${bound.name}" delivers trigger type ` +
          `"${bound.trigger}" in state "${state}", whose \`on\` map has no entry for it. ` +
          `Add "${bound.trigger}" to that map, or set \`trigger\` on the ${what} to a ` +
          "type the state handles."
      );
    }
  }
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
  if (typeof name !== "string") {
    throw new EkmanError("INVALID_KEY", "entity name must be a string");
  }
  const fault = name.includes(KEY_SEPARATOR)
    ? `contains "${KEY_SEPARATOR}"`
    : segmentFault(name);
  if (fault !== undefined) {
    throw new EkmanError(
      "INVALID_KEY",
      `entity name ${JSON.stringify(name)} ${fault}, and it has to be a valid key segment ` +
        "because it is the first segment of every key it addresses"
    );
  }
}

/**
 * Refuse a time bound or a rule whose trigger the entity would refuse on arrival.
 *
 * Both deliver a trigger. An entity that declares which trigger types it recognizes and
 * leaves this one out would refuse it as unknown, and the instance being watched would
 * stay exactly where it was. One that only warns delivers nothing, so it is not held to
 * this.
 */
function assertEscalationsRecognized(
  entity: string,
  triggers: ReadonlySet<string> | null,
  what: string,
  bounds: readonly {
    readonly name: string;
    readonly trigger: string;
    readonly policy: "reject" | "warn";
  }[]
): void {
  if (triggers === null) {
    return;
  }

  for (const bound of bounds) {
    if (bound.policy !== "warn" && !triggers.has(bound.trigger)) {
      throw new EkmanError(
        "INVALID_CONFIG",
        `entity "${entity}": ${what} "${bound.name}" delivers trigger type ` +
          `"${bound.trigger}", which is not in the declared triggers list. Add it to ` +
          `\`triggers\`, or set \`trigger\` on the ${what} to one that is declared.`
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
  "rules",
  "stale",
] as const;

const STATE_KEYS = ["handler", "on", ...POLICY_KEYS] as const;

/** The options each kind of constraint declaration takes, by the key it is declared under. */
const DECLARATION_KEYS = {
  transitions: ["allow", "policy"],
  guards: ["name", "on", "from", "policy", "check"],
  invariants: ["name", "in", "policy", "check"],
  temporal: ["name", "in", "within", "escalateTo", "trigger", "policy"],
  rules: ["name", "in", "when", "propose", "trigger", "policy"],
  stale: ["name", "in", "after", "propose", "trigger", "policy"],
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
    assertStateConfig(`${where} state "${state}"`, declared);
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

/**
 * Refuse a state declared as anything but a handler, `{ handler }` or `{ on }`.
 *
 * A state with neither would be accepted and then fail every trigger at dispatch, as a
 * handler failure, which says nothing about the definition being the thing at fault. One
 * with both has two answers to which handler runs. And an empty `on` refuses everything,
 * which is a state with no handler written the long way.
 */
function assertStateConfig(label: string, declared: unknown): void {
  if (typeof declared === "function") {
    return;
  }
  if (typeof declared !== "object" || declared === null) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label} must be a handler function, or an object with \`handler\` or \`on\``
    );
  }

  assertKnownKeys(label, declared, STATE_KEYS);
  const { handler, on, ...policy } = declared as {
    handler?: unknown;
    on?: unknown;
  };
  assertPolicyKeys(policy, label);

  if (handler !== undefined && on !== undefined) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label} declares both \`handler\` and \`on\`. A state takes every trigger with ` +
        "one handler, or names the types it handles under `on`, never both."
    );
  }

  if (on === undefined) {
    if (typeof handler !== "function") {
      throw new EkmanError(
        "INVALID_CONFIG",
        `${label} declares no handler. Give it a \`handler\` function, or an \`on\` map ` +
          "of trigger type to handler."
      );
    }
    return;
  }

  if (typeof on !== "object" || on === null || Array.isArray(on)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label} \`on\` must be an object mapping trigger types to handlers`
    );
  }

  const entries = Object.entries(on);
  if (entries.length === 0) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${label} declares an empty \`on\` map, so every trigger would be refused there`
    );
  }
  for (const [type, entry] of entries) {
    if (typeof entry !== "function") {
      throw new EkmanError(
        "INVALID_CONFIG",
        `${label} \`on\` entry "${type}" must be a handler function`
      );
    }
  }
}
