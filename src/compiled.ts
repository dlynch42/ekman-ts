import type { CompiledConstraints } from "./constraints";
import type { States } from "./states";
import type {
  AnyEntityDefinition,
  EntityConstraints,
  EntityDefinition,
  Trigger,
  TriggerLike,
  Values,
} from "./types";

/**
 * The one place the runtime reads what a definition keeps to itself.
 *
 * A definition shows its states as a read-only graph and its constraints as an opaque
 * value, so nothing outside the library can reach the compiled form or change an edge
 * after the fact. The runtime needs both in full: the interned state ids a resident
 * instance carries, and the compiled checks a commit runs. Every such read goes through
 * here, so the public types and the internal ones can only disagree in this file.
 */

/** The concrete states behind a definition's read-only graph. */
export function statesOf(definition: AnyEntityDefinition): States {
  return definition.states as States;
}

/** A definition's compiled constraints, or undefined when it has none in force. */
export function constraintsOf<
  S extends string,
  V extends Values,
  T extends TriggerLike = Trigger,
>(
  definition: EntityDefinition<string, S, V, T>
): CompiledConstraints<S, V, T> | undefined {
  return definition.constraints as unknown as
    | CompiledConstraints<S, V, T>
    | undefined;
}

/** Hand compiled constraints to a definition as the opaque value it carries. */
export function sealConstraints<
  S extends string,
  V extends Values,
  T extends TriggerLike,
>(
  compiled: CompiledConstraints<S, V, T> | undefined
): EntityConstraints | undefined {
  return compiled as unknown as EntityConstraints | undefined;
}
