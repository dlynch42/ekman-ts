import type { AnyEntityDefinition } from "./types";

/**
 * Draw an entity's states.
 *
 * The picture is the declared structure, not a trace of anything that ran. An entity that
 * declared no transitions has no edges to draw, and drawing every pair instead would say
 * "anything can happen" in the least readable way available, so it gets its states and a
 * line of prose.
 *
 * Both renderers take the same shape and differ only in syntax, because the thing worth
 * getting right is which edges appear, and that should not be decided twice.
 */
export interface DiagramOptions {
  /**
   * Transitions observed in production, drawn as observed where they were never declared.
   *
   * This is the picture that makes `warn` mode a workflow: plain is what you declared,
   * marked is what your traffic did, and the difference is the edit you are being asked to
   * make.
   */
  readonly observed?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Mermaid `stateDiagram-v2`, which renders in GitHub and most editors. */
export function toMermaid(
  definition: AnyEntityDefinition,
  options: DiagramOptions = {}
): string {
  const { states } = definition;
  const id = mermaidIds(states.names);
  const lines = ["stateDiagram-v2"];

  // Aliases first, because a state name may be anything and a mermaid id may not. Emitted
  // only where they differ, so the common diagram stays readable as text.
  for (const state of states.names) {
    const alias = id(state);
    if (alias !== state) {
      lines.push(`  state "${state}" as ${alias}`);
    }
  }

  lines.push(`  [*] --> ${id(definition.initial)}`);

  for (const [from, to, declared] of edgesOf(definition, options)) {
    const arrow = `  ${id(from)} --> ${id(to)}`;
    lines.push(declared ? arrow : `${arrow} : observed`);
  }

  if (!states.hasEdges) {
    // Mermaid only draws a state something refers to, so with no edges they are listed.
    for (const state of states.names) {
      if (state !== definition.initial) {
        lines.push(`  ${id(state)}`);
      }
    }
    lines.push("  %% no transitions declared, so every transition is legal");
  }

  return lines.join("\n");
}

/** Graphviz DOT, for anything that renders `.dot` rather than mermaid. */
export function toDot(
  definition: AnyEntityDefinition,
  options: DiagramOptions = {}
): string {
  const { states } = definition;
  const lines = [
    `digraph ${quoted(definition.name)} {`,
    "  rankdir=LR;",
    '  __start [shape=point, label=""];',
    `  __start -> ${quoted(definition.initial)};`,
  ];

  for (const state of states.names) {
    lines.push(`  ${quoted(state)};`);
  }

  for (const [from, to, declared] of edgesOf(definition, options)) {
    lines.push(
      `  ${quoted(from)} -> ${quoted(to)}${
        declared ? "" : ' [style=dashed, label="observed"]'
      };`
    );
  }

  if (!states.hasEdges) {
    lines.push("  // no transitions declared, so every transition is legal");
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Every edge to draw: declared ones first, then observed ones that were never declared.
 *
 * Declared order rather than sorted, because a transition map is written in the order a
 * domain moves through it, and a diagram that reorders it is harder to check against the
 * code sitting beside it.
 */
function edgesOf(
  definition: AnyEntityDefinition,
  options: DiagramOptions
): readonly (readonly [string, string, boolean])[] {
  const { states } = definition;
  const edges: (readonly [string, string, boolean])[] = [];

  if (states.hasEdges) {
    for (const from of states.names) {
      for (const to of states.targetsOf(from)) {
        edges.push([from, to, true]);
      }
    }
  }

  for (const [from, targets] of options.observed ?? []) {
    for (const to of targets) {
      if (!(states.hasEdges && states.allows(from, to))) {
        edges.push([from, to, false]);
      }
    }
  }

  return edges;
}

/**
 * A mermaid id per state, aliased where the state's own name is not a legal one.
 *
 * State names allow far more than mermaid ids do, and emitting a silently broken diagram
 * is worse than emitting an ugly one. Collisions after replacement get a numeric suffix,
 * so `rolled-back` and `rolled back` cannot become the same node.
 *
 * Returned as a lookup rather than a map so that every caller resolves a name the same way,
 * including the one that can be handed a name this entity has never heard of.
 */
function mermaidIds(names: readonly string[]): (name: string) => string {
  const ids = new Map<string, string>();
  const taken = new Set<string>();

  for (const name of names) {
    let id = safeId(name);
    let suffix = 2;
    while (taken.has(id)) {
      id = `${id}_${suffix}`;
      suffix += 1;
    }
    taken.add(id);
    ids.set(name, id);
  }

  // A name with no id is one the entity does not declare, which an observed edge can carry
  // because a stream outlives a rename. It is drawn under the name the stream recorded,
  // since that is the only name it has.
  return (name) => ids.get(name) ?? safeId(name);
}

/** One name, made legal. Not injective on its own, which is what the collision loop is for. */
function safeId(name: string): string {
  return SAFE_ID.test(name) ? name : `s_${name.replace(UNSAFE_CHARS, "_")}`;
}

function quoted(value: string): string {
  return `"${value.replace(QUOTES, '\\"')}"`;
}

const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_CHARS = /[^A-Za-z0-9_]/g;
const QUOTES = /"/g;
