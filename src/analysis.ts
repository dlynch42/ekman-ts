import type { AnyEntityDefinition } from "./types";

/**
 * What an entity's states look like, asked at definition time.
 *
 * Reports, never refuses. A terminal state is a legitimate shape, and a state nothing yet
 * reaches is usually a state a team is on its way to wiring up. Turning either into an error
 * would make the structure an opinion about how a domain should be modelled, which is the
 * opposite of what a constraint set in `warn` mode is for.
 *
 * The one thing that is refused, at `defineEntity` rather than here, is a temporal
 * constraint escalating to a state the declared transitions would not let the handler reach.
 * That one is not a matter of taste: the escalation could never do anything.
 */
export interface Analysis {
  /**
   * Whether any edges were declared.
   *
   * Everything below is read against this. With no edges declared every transition is
   * legal, so nothing is terminal and nothing is unreachable, and both lists are empty for
   * a reason that has nothing to do with the shape of the domain.
   */
  readonly constrained: boolean;
  /** States nothing leaves. Out-degree zero, which is a shape and not a kind of state. */
  readonly terminals: readonly string[];
  /** States no sequence of declared transitions reaches from the initial one. */
  readonly unreachable: readonly string[];
}

/**
 * Describe an entity's states.
 *
 * Pure, and cheap enough to call at startup on every entity a runtime holds. Nothing here
 * reads runtime state: this answers what an instance *can* do, not where any instance is.
 *
 * The lists are frozen and not only the object holding them, since freezing the wrapper
 * alone leaves the contents editable. Affordable because nothing reads this on a commit
 * path: a frozen array is slower to join, which is why the declared-target lists in
 * `states.ts` are left unfrozen and rely on their type instead.
 */
export function analyze(definition: AnyEntityDefinition): Analysis {
  const { states, initial } = definition;

  return Object.freeze({
    constrained: states.hasEdges,
    terminals: Object.freeze(states.terminals()),
    unreachable: Object.freeze(states.unreachableFrom(initial)),
  });
}
