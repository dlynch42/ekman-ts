import { ConstraintViolationError, EkmanError } from "./errors";
import type { ConstraintKind } from "./events";
import type { NodeId, States } from "./states";
import type { InstanceSnapshot, Trigger, TriggerLike, Values } from "./types";

/**
 * Constraints: the strictness dial.
 *
 * Four kinds, each checked at a defined moment, each carrying its own violation policy.
 * All of them are opt-in per entity, and an entity that declares none behaves exactly as
 * it did before this file existed.
 *
 * `warn` is the reason the dial exists. A team that does not yet know its real transition
 * graph turns constraints on in `warn`, reads the violations out of production, and only
 * then switches to `reject`. Strictness is earned rather than imposed, so nothing here
 * may make `warn` a second-class path.
 */

/**
 * What a violation does.
 *
 * - `reject`: the result fails, the instance does not move, and the failure is classified
 *   so an error handler can catch it.
 * - `warn`: the violation is recorded and the commit proceeds.
 * - `off`: not evaluated at all.
 */
export type ViolationPolicy = "reject" | "warn" | "off";

/** The default trigger type an escalating temporal constraint delivers. */
export const DEFAULT_TEMPORAL_TRIGGER = "constraint.temporal";

const POLICIES: readonly ViolationPolicy[] = ["reject", "warn", "off"];

/** The state and values a result is asking to commit. */
export interface ProposedCommit<
  S extends string = string,
  V extends Values = Values,
> {
  readonly state: S;
  readonly values: Readonly<V>;
}

/**
 * A guard or invariant condition.
 *
 * Return `true` when it holds. Return `false`, or a string explaining why, when it does
 * not. The string becomes the violation's `reason`, so it is worth writing one.
 *
 * A check that throws counts as a violation carrying the thrown message. Treating a broken
 * check as satisfied would be exactly the silent fall-through constraints exist to prevent.
 */
export type ConstraintCheck<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> = (
  next: ProposedCommit<S, V>,
  instance: InstanceSnapshot<S, V>,
  trigger: T
) => boolean | string;

/**
 * Which transitions are legal.
 *
 * Every `transitionTo` is checked, including one that targets the state the instance is
 * already in: asking to transition is a request to transition. Use `stay()` to update
 * values without one.
 */
export interface TransitionConstraint<S extends string = string> {
  /** Defaults to `reject`. */
  readonly policy?: ViolationPolicy;
  readonly allow: { readonly [K in S]?: readonly S[] };
}

/** An entry condition on a target state, checked before committing a move into it. */
export interface GuardConstraint<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  /** Defaults to `guard:<on>`, or `guard:<from>-><on>` when the guard is scoped. */
  readonly name?: string;
  /** The state being entered. */
  readonly on: S;
  /**
   * The states the transition may come from. Omitted means any of them.
   *
   * This is what lets "entering `shipped` from `paid` requires payment cleared, but
   * entering it from `manual_override` does not" be declared rather than hidden inside a
   * check that reads the instance and returns true early. An exemption written that way is
   * invisible to anything reading the constraint set, including the diagram.
   *
   * A scope naming an edge the declared transitions do not have is refused at definition:
   * it is a condition on something that cannot happen.
   */
  readonly from?: S | readonly S[];
  /** Defaults to `reject`. */
  readonly policy?: ViolationPolicy;
  readonly check: ConstraintCheck<S, V, T>;
}

/** A condition that must hold in a state, checked before any result that changes values. */
export interface InvariantConstraint<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  /** Defaults to `invariant:<states>`. */
  readonly name?: string;
  /** States this applies to. Omitted means every state. */
  readonly in?: readonly S[];
  /** Defaults to `reject`. */
  readonly policy?: ViolationPolicy;
  readonly check: ConstraintCheck<S, V, T>;
}

/**
 * A bound on how long an instance may sit in one state.
 *
 * Evaluated by the sweeper rather than at commit, and firing delivers a *trigger*. The
 * runtime never writes state on its own, so an escalation is an opportunity for the
 * handler to move, exactly like any other input.
 *
 * `reject` fires the escalation trigger and records the violation. `warn` records the
 * violation only, which is how you discover what your real timings are before acting on
 * them. `off` is not evaluated.
 *
 * A constraint fires at most once per entry into its state. Leaving and re-entering arms
 * it again.
 */
export interface TemporalConstraint<S extends string = string> {
  /** Defaults to `temporal:<in>`. */
  readonly name?: string;
  /** The state being watched. */
  readonly in: S;
  /** How long an instance may remain in it, in milliseconds. */
  readonly within: number;
  /**
   * The state the escalation is asking for. Carried on the trigger for the handler to
   * act on; the runtime does not apply it.
   */
  readonly escalateTo?: S;
  /** Type of the delivered trigger. Defaults to `constraint.temporal`. */
  readonly trigger?: string;
  /** Defaults to `reject`, meaning the escalation is delivered. */
  readonly policy?: ViolationPolicy;
}

export interface ConstraintsConfig<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  readonly transitions?: TransitionConstraint<S>;
  readonly guards?: readonly GuardConstraint<S, V, T>[];
  readonly invariants?: readonly InvariantConstraint<S, V, T>[];
  readonly temporal?: readonly TemporalConstraint<S>[];
}

/** A constraint that did not hold, before it becomes an event or an error. */
export interface Violation {
  readonly kind: ConstraintKind;
  readonly name: string;
  readonly policy: "reject" | "warn";
  readonly reason: string;
}

interface CompiledCheck<
  S extends string,
  V extends Values,
  T extends TriggerLike,
> {
  readonly name: string;
  readonly policy: "reject" | "warn";
  readonly check: ConstraintCheck<S, V, T>;
}

export interface CompiledGuard<
  S extends string,
  V extends Values,
  T extends TriggerLike,
> extends CompiledCheck<S, V, T> {
  readonly on: string;
  /** Null means any source state, which is the default a guard gets. */
  readonly from: ReadonlySet<string> | null;
}

export interface CompiledInvariant<
  S extends string,
  V extends Values,
  T extends TriggerLike,
> extends CompiledCheck<S, V, T> {
  /** Null means every state. */
  readonly in: ReadonlySet<string> | null;
}

export interface CompiledTemporal {
  readonly name: string;
  readonly in: string;
  readonly within: number;
  readonly escalateTo: string | undefined;
  readonly trigger: string;
  readonly policy: "reject" | "warn";
}

export interface CompiledTransitions {
  readonly policy: "reject" | "warn";
  /** The entity's own states, with this constraint's edge overlay installed on them. */
  readonly states: States;
}

/**
 * Constraints with policies resolved, names derived, and everything set to `off` removed.
 *
 * Dropping `off` at compile time rather than skipping it at check time means the hot path
 * has nothing to skip, and an entity whose constraints are all off costs exactly what an
 * entity with no constraints costs.
 */
export interface CompiledConstraints<
  S extends string = string,
  V extends Values = Values,
  T extends TriggerLike = Trigger,
> {
  readonly transitions: CompiledTransitions | undefined;
  readonly guards: readonly CompiledGuard<S, V, T>[];
  readonly invariants: readonly CompiledInvariant<S, V, T>[];
  readonly temporal: readonly CompiledTemporal[];
  /** Grouped by watched state, so the sweeper walks only states that are watched. */
  readonly temporalByState: ReadonlyMap<string, readonly CompiledTemporal[]>;
  /**
   * Whether anything here is checked at commit. False for an entity whose only constraints
   * are temporal, which the sweeper evaluates rather than the commit path.
   *
   * Read at the call site rather than inside the check, because what it saves is the
   * instance snapshot the caller would have to build in order to ask the question.
   */
  readonly checksAtCommit: boolean;
}

/**
 * Validate and compile an entity's constraints.
 *
 * Returns undefined when nothing survives, which is what lets every caller treat
 * "no constraints" and "all constraints off" as the same fast path.
 */
export function compileConstraints<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  entity: string,
  config: ConstraintsConfig<S, V, T>,
  states: States
): CompiledConstraints<S, V, T> | undefined {
  const transitions = compileTransitions(entity, config.transitions, states);
  const guards = compileGuards(entity, config.guards ?? [], states);
  const invariants = compileInvariants(entity, config.invariants ?? [], states);
  const temporal = compileTemporal(entity, config.temporal ?? [], states);

  if (
    transitions === undefined &&
    guards.length === 0 &&
    invariants.length === 0 &&
    temporal.length === 0
  ) {
    return;
  }

  const temporalByState = new Map<string, CompiledTemporal[]>();
  for (const constraint of temporal) {
    const existing = temporalByState.get(constraint.in);
    if (existing === undefined) {
      temporalByState.set(constraint.in, [constraint]);
    } else {
      existing.push(constraint);
    }
  }

  return Object.freeze({
    transitions,
    guards,
    invariants,
    temporal,
    temporalByState,
    checksAtCommit:
      transitions !== undefined || guards.length > 0 || invariants.length > 0,
  });
}

function compileTransitions<S extends string>(
  entity: string,
  declared: TransitionConstraint<S> | undefined,
  states: States
): CompiledTransitions | undefined {
  if (declared === undefined) {
    return;
  }

  const policy = resolvePolicy(entity, "transitions", declared.policy);
  if (policy === "off") {
    return;
  }

  const entries = Object.entries(declared.allow ?? {}) as [string, unknown][];
  if (entries.length === 0) {
    throw invalid(
      entity,
      "the transition constraint declares no allowed transitions, so every " +
        'transitionTo would violate it. Remove it, or set policy to "off".'
    );
  }

  const edges: [string, readonly string[]][] = [];
  for (const [from, targets] of entries) {
    assertState(entity, "transitions", from, states);
    if (!Array.isArray(targets)) {
      throw invalid(
        entity,
        `the transition constraint maps "${from}" to ${JSON.stringify(targets)}, ` +
          "which must be an array of target state names"
      );
    }
    for (const target of targets as string[]) {
      assertState(entity, "transitions", target, states);
    }
    edges.push([from, targets as string[]]);
  }

  // Installed on the entity's own states rather than kept here, so the constraint and
  // `definition.states` are the same edges rather than two copies that can disagree.
  states.declareEdges(edges);
  return Object.freeze({ policy, states });
}

function compileGuards<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  entity: string,
  declared: readonly GuardConstraint<S, V, T>[],
  states: States
): readonly CompiledGuard<S, V, T>[] {
  const compiled: CompiledGuard<S, V, T>[] = [];

  for (const guard of declared) {
    const policy = resolvePolicy(entity, "guard", guard.policy);
    assertState(entity, "guard", guard.on, states);
    assertCheck(entity, "guard", guard.check);

    const sources = guard.from === undefined ? undefined : [guard.from].flat();
    for (const source of sources ?? []) {
      assertState(entity, "guard", source, states);
      assertGuardedEdge(entity, source, guard.on, states);
    }

    if (policy !== "off") {
      compiled.push(
        Object.freeze({
          name: guard.name ?? defaultGuardName(guard.on, sources),
          on: guard.on,
          from: sources === undefined ? null : new Set<string>(sources),
          policy,
          check: guard.check,
        })
      );
    }
  }

  return compiled;
}

function compileInvariants<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  entity: string,
  declared: readonly InvariantConstraint<S, V, T>[],
  states: States
): readonly CompiledInvariant<S, V, T>[] {
  const compiled: CompiledInvariant<S, V, T>[] = [];

  for (const invariant of declared) {
    const policy = resolvePolicy(entity, "invariant", invariant.policy);
    assertCheck(entity, "invariant", invariant.check);

    for (const state of invariant.in ?? []) {
      assertState(entity, "invariant", state, states);
    }

    if (policy !== "off") {
      const scope = invariant.in;
      compiled.push(
        Object.freeze({
          name: invariant.name ?? `invariant:${scope?.join("|") ?? "*"}`,
          in: scope === undefined ? null : new Set<string>(scope),
          policy,
          check: invariant.check,
        })
      );
    }
  }

  return compiled;
}

function compileTemporal<S extends string>(
  entity: string,
  declared: readonly TemporalConstraint<S>[],
  states: States
): readonly CompiledTemporal[] {
  const compiled: CompiledTemporal[] = [];

  for (const constraint of declared) {
    const policy = resolvePolicy(entity, "temporal", constraint.policy);
    assertState(entity, "temporal", constraint.in, states);

    if (constraint.escalateTo !== undefined) {
      assertState(entity, "temporal", constraint.escalateTo, states);
      assertEscalatable(entity, constraint.in, constraint.escalateTo, states);
    }

    if (!(Number.isFinite(constraint.within) && constraint.within > 0)) {
      throw invalid(
        entity,
        `temporal constraint on "${constraint.in}" declares within=${JSON.stringify(constraint.within)}, ` +
          "which must be a positive number of milliseconds"
      );
    }

    if (policy !== "off") {
      compiled.push(
        Object.freeze({
          name: constraint.name ?? `temporal:${constraint.in}`,
          in: constraint.in,
          within: constraint.within,
          escalateTo: constraint.escalateTo,
          trigger: constraint.trigger ?? DEFAULT_TEMPORAL_TRIGGER,
          policy,
        })
      );
    }
  }

  return compiled;
}

/**
 * Check every constraint that applies to a proposed commit.
 *
 * Returns violations in check order, stopping at the first one whose policy is `reject`.
 * Warnings found before it are still returned, because they happened and the stream should
 * say so.
 *
 * Nothing is allocated for a commit that violates nothing, which is nearly all of them.
 * There is no per-call closure, the result list is not created until there is something to
 * put in it, and an empty constraint list is answered by its length rather than by an
 * iterator over it. That is not tidiness: this runs before the commit of every result of
 * every entity, and the cost of the function's own shape used to be fourteen times the cost
 * of the lookup it exists to perform.
 */
export function checkConstraints<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  compiled: CompiledConstraints<S, V, T> | undefined,
  args: {
    instance: InstanceSnapshot<S, V>;
    next: ProposedCommit<S, V>;
    trigger: T;
    /**
     * The interned id of the state the instance is in, carried on the resident record so
     * the edge check does not derive it. Required rather than optional: a default would be
     * a branch on the hottest path in the runtime, in service of a caller that does not
     * exist.
     */
    fromStateId: NodeId;
    /** A `transitionTo` result. What the graph and the guards gate. */
    transitioning: boolean;
    /** The result supplied values. Together with `transitioning`, what invariants gate. */
    mutatingValues: boolean;
  }
): readonly Violation[] {
  if (compiled === undefined) {
    return EMPTY;
  }

  const { instance, next, trigger, transitioning } = args;
  const { transitions, guards, invariants } = compiled;

  // Created by the first violation and not before, and threaded through the walkers by
  // return value rather than captured. The previous version closed over it instead, and that
  // closure, allocated on every call whether or not it was ever used, was 84% of what this
  // function cost. Anything that reintroduces a per-call closure here undoes the phase.
  let violations: Violation[] | undefined;

  if (transitioning && transitions !== undefined) {
    const found = checkGraph(
      transitions,
      args.fromStateId,
      instance.state,
      next.state
    );
    if (found !== undefined) {
      violations = [found];
      if (found.policy === "reject") {
        return violations;
      }
    }
  }

  if (transitioning && guards.length > 0) {
    violations = walkGuards(guards, next, instance, trigger, violations);
    if (halted(violations)) {
      return violations;
    }
  }

  if ((transitioning || args.mutatingValues) && invariants.length > 0) {
    violations = walkInvariants(
      invariants,
      next,
      instance,
      trigger,
      violations
    );
    if (halted(violations)) {
      return violations;
    }
  }

  // The shared frozen empty, not a fresh one. Callers read `length` and iterate; nobody owns
  // this array, which was already true of the no-constraints path above.
  return violations ?? EMPTY;
}

/**
 * Guards that gate the state being entered, in declaration order.
 *
 * Takes the accumulator and hands it back rather than closing over it, and returns it
 * unchanged when nothing was found, so a commit that violates nothing allocates nothing.
 */
function walkGuards<S extends string, V extends Values, T extends TriggerLike>(
  guards: readonly CompiledGuard<S, V, T>[],
  next: ProposedCommit<S, V>,
  instance: InstanceSnapshot<S, V>,
  trigger: T,
  found: Violation[] | undefined
): Violation[] | undefined {
  let violations = found;

  for (const guard of guards) {
    if (guard.on !== next.state || !appliesFrom(guard, instance.state)) {
      continue;
    }

    const violation = run(guard, next, instance, trigger);
    if (violation !== undefined) {
      violations ??= [];
      violations.push(violation);
      if (violation.policy === "reject") {
        return violations;
      }
    }
  }

  return violations;
}

/** The same walk for invariants, which filter on the state being entered rather than on it
 * being entered at all. Written out rather than shared with the guards through a predicate
 * parameter, which would make one call site serve two shapes. */
function walkInvariants<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  invariants: readonly CompiledInvariant<S, V, T>[],
  next: ProposedCommit<S, V>,
  instance: InstanceSnapshot<S, V>,
  trigger: T,
  found: Violation[] | undefined
): Violation[] | undefined {
  let violations = found;

  for (const invariant of invariants) {
    if (!applies(invariant, next.state)) {
      continue;
    }

    const violation = run(invariant, next, instance, trigger);
    if (violation !== undefined) {
      violations ??= [];
      violations.push(violation);
      if (violation.policy === "reject") {
        return violations;
      }
    }
  }

  return violations;
}

/**
 * Whether the walk ended in a refusal.
 *
 * Read off the last entry rather than searched for, because a walk stops at the first
 * refusal it finds, so a refusal can only ever be the last thing in the list. Only reached
 * when a walk found something, which is not the common path.
 */
function halted(
  violations: Violation[] | undefined
): violations is Violation[] {
  return violations !== undefined && violations.at(-1)?.policy === "reject";
}

function checkGraph(
  transitions: CompiledTransitions,
  fromId: NodeId,
  from: string,
  to: string
): Violation | undefined {
  // By id, which the caller is holding anyway. The name is still needed, because a refusal
  // names the state it was refused from and an id is not something to show anybody.
  const known = transitions.states.checkEdgeFrom(fromId, to);
  if (known === undefined) {
    return;
  }

  return {
    kind: "transition",
    name: "transitions",
    policy: transitions.policy,
    reason:
      `"${from}" to "${to}" is not a declared transition. ` +
      `From "${from}" the declared targets are: ${known.join(", ") || "(none)"}`,
  };
}

/** Null scope means any source state, which is the default a guard gets. */
function appliesFrom<S extends string, V extends Values, T extends TriggerLike>(
  guard: CompiledGuard<S, V, T>,
  from: string
): boolean {
  return guard.from === null || guard.from.has(from);
}

/** Null scope means every state, which is the default an invariant gets. */
function applies<S extends string, V extends Values, T extends TriggerLike>(
  invariant: CompiledInvariant<S, V, T>,
  state: string
): boolean {
  return invariant.in === null || invariant.in.has(state);
}

/** The first `reject` violation in a set, or undefined if they are all warnings. */
export function rejection(
  violations: readonly Violation[]
): Violation | undefined {
  return violations.find((violation) => violation.policy === "reject");
}

export function violationError(
  violation: Violation,
  key: string
): ConstraintViolationError {
  return new ConstraintViolationError({
    kind: violation.kind,
    constraint: violation.name,
    key,
    reason: `${violation.name}: ${violation.reason}`,
  });
}

const EMPTY: readonly Violation[] = Object.freeze([]);

function run<S extends string, V extends Values, T extends TriggerLike>(
  constraint: CompiledGuard<S, V, T> | CompiledInvariant<S, V, T>,
  next: ProposedCommit<S, V>,
  instance: InstanceSnapshot<S, V>,
  trigger: T
): Violation | undefined {
  const kind: ConstraintKind = "on" in constraint ? "guard" : "invariant";

  let outcome: boolean | string;
  try {
    outcome = constraint.check(next, instance, trigger);
  } catch (thrown) {
    // A check that throws is a violation, not a pass. The alternative is deciding a
    // condition holds because the code asking about it is broken.
    return {
      kind,
      name: constraint.name,
      policy: constraint.policy,
      reason: `the check threw: ${(thrown as Error).message}`,
    };
  }

  if (outcome === true) {
    return;
  }

  return {
    kind,
    name: constraint.name,
    policy: constraint.policy,
    reason: typeof outcome === "string" ? outcome : "the check did not hold",
  };
}

function resolvePolicy(
  entity: string,
  where: string,
  declared: ViolationPolicy | undefined
): ViolationPolicy {
  const policy = declared ?? "reject";
  if (!POLICIES.includes(policy)) {
    throw invalid(
      entity,
      `${where} declares violation policy ${JSON.stringify(policy)}, which is not recognized. ` +
        `Expected one of: ${POLICIES.join(", ")}`
    );
  }
  return policy;
}

function assertState(
  entity: string,
  where: string,
  state: string,
  states: States
): void {
  if (!states.has(state)) {
    throw invalid(
      entity,
      `${where} names state "${state}", which has no handler. ` +
        `Declared states: ${states.names.join(", ")}`
    );
  }
}

/**
 * An escalation the transition graph would refuse is refused at definition instead.
 *
 * The escalation is delivered as a trigger while the instance is still in the watched
 * state, so the handler that receives it can only move in one step. A target that is
 * reachable eventually, through some other state, does not help the handler holding the
 * trigger: its `transitionTo` is refused and the instance stays exactly where the constraint
 * was watching it. So the edge has to be declared, not merely reachable.
 *
 * Only checked when an edge overlay exists. Without one every transition is legal, so there
 * is nothing here that could be refused.
 */
function assertEscalatable(
  entity: string,
  from: string,
  escalateTo: string,
  states: States
): void {
  if (!states.hasEdges) {
    return;
  }

  const known = states.checkEdge(from, escalateTo);
  if (known === undefined) {
    return;
  }

  throw invalid(
    entity,
    `temporal constraint on "${from}" escalates to "${escalateTo}", which is not a ` +
      `declared transition from "${from}". The escalation is delivered as a trigger while ` +
      `the instance is still in "${from}", so the handler could not act on it. ` +
      `From "${from}" the declared targets are: ${known.join(", ") || "(none)"}`
  );
}

/**
 * A guard scoped to an edge the declared transitions do not have is refused.
 *
 * The check could never run: the transition it conditions is already refused by the graph.
 * Left alone it reads like protection that is in force, which is the worst kind of dead
 * configuration. Only meaningful when an overlay exists, since without one every edge does.
 */
function assertGuardedEdge(
  entity: string,
  from: string,
  on: string,
  states: States
): void {
  if (!states.hasEdges) {
    return;
  }

  const known = states.checkEdge(from, on);
  if (known === undefined) {
    return;
  }

  throw invalid(
    entity,
    `guard on "${on}" is scoped to transitions from "${from}", which is not a declared ` +
      `transition, so the guard could never run. From "${from}" the declared targets ` +
      `are: ${known.join(", ") || "(none)"}`
  );
}

/** `guard:<on>` unscoped, `guard:<from>-><on>` scoped, so a name says what it covers. */
function defaultGuardName(
  on: string,
  sources: readonly string[] | undefined
): string {
  return sources === undefined
    ? `guard:${on}`
    : `guard:${sources.join("|")}->${on}`;
}

function assertCheck(entity: string, where: string, check: unknown): void {
  if (typeof check !== "function") {
    throw invalid(entity, `${where} must declare a check function`);
  }
}

function invalid(entity: string, detail: string): EkmanError {
  return new EkmanError("INVALID_CONFIG", `entity "${entity}": ${detail}`);
}
