import type { CompiledConstraints } from "./constraints";
import { EkmanError } from "./errors";
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

/**
 * Refuse a definition that `defineEntity` did not build.
 *
 * The public types describe a definition by shape, so an object with the right fields
 * passes the compiler: a copy with `states` swapped for a hand-written graph, say. The
 * runtime needs more of `states` than the read-only view shows, and would only find it
 * missing on the first trigger, as a `TypeError` from somewhere inside a dispatch. Checked
 * by what the object can do and not by its class, so a definition built by another copy
 * of this package, as happens when one program loads both module formats, still passes.
 */
export function assertBuilt(definition: AnyEntityDefinition): void {
  const states = definition.states as Partial<States> | null | undefined;
  if (
    typeof states?.idOf === "function" &&
    typeof states.checkEdgeFrom === "function"
  ) {
    return;
  }
  throw new EkmanError(
    "INVALID_CONFIG",
    `entity "${definition.name}" was not built by defineEntity, or its states were ` +
      "replaced afterwards. Pass the value defineEntity returned, unchanged."
  );
}

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
