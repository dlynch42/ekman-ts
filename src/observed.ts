import type { EkmanEvent } from "./events";

/**
 * The transitions an entity actually made, folded out of its event stream.
 *
 * This is the other half of the discovery workflow. A team turns the transition constraint
 * on in `warn`, runs real traffic through it, and reads back the graph their domain really
 * has rather than the one they guessed. Declared edges say what you meant; these say what
 * happened, and the difference is the edit.
 *
 * Folded from the stream rather than accumulated as commits happen, for three reasons: it
 * survives a restart, it costs the commit path nothing, and it answers for instances this
 * process has never held. The stream is already the record; this only reads it.
 */
export interface ObservedEdges {
  /**
   * Transitions that committed.
   *
   * Under `warn` this includes the ones enforcement would have refused, because a warning
   * records the violation and lets the commit through. That is what makes this the real
   * graph rather than a subset of the declared one.
   */
  readonly taken: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Transitions a `reject` constraint refused.
   *
   * Never committed, so they are not part of the graph the instance walked. They are the
   * moves the code tried to make and could not, which is the other thing worth seeing
   * before deciding a graph is right.
   */
  readonly refused: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Fold a stream into the edges it walked.
 *
 * `into` accumulates across streams, because history is per key and a graph is per entity,
 * so answering for an entity means folding every key's stream into one result.
 */
export function observeEdges(
  events: Iterable<EkmanEvent>,
  into?: ObservedEdges
): ObservedEdges {
  const taken = copy(into?.taken);
  const refused = copy(into?.refused);

  for (const event of events) {
    // Matched on the event type, never on the presence of a `from`. A restore carries one
    // too, holding "snapshot" or "replay", and a fold that went looking for the field would
    // quietly invent a state by that name.
    if (event.type === "transition") {
      // A null `from` is initialization, which is where an instance started rather than a
      // move it made. Counting it would put an edge into the graph that nothing traversed.
      if (event.from !== null) {
        add(taken, event.from, event.to);
      }
      continue;
    }

    if (
      event.type === "violation" &&
      event.constraint.kind === "transition" &&
      event.policy === "reject" &&
      event.attempted !== undefined
    ) {
      add(refused, event.attempted.from, event.attempted.to);
    }
  }

  return Object.freeze({ taken, refused });
}

/**
 * The observed edges as a transition constraint's `allow` map.
 *
 * The output is meant to be pasted into an entity definition, which is the whole point of
 * the exercise: a team reads their real graph out of production and declares it. Refused
 * edges are deliberately left out. They were refused; a map that re-admits them would
 * declare the thing enforcement already decided against.
 *
 * Every state that appears as a source gets an entry. States that only ever appear as
 * targets do not, so a terminal state is absent rather than present and empty, which is the
 * same shape a hand-written map has.
 */
export function allowFrom(
  observed: ObservedEdges
): Record<string, readonly string[]> {
  const allow: Record<string, readonly string[]> = {};

  for (const [from, targets] of observed.taken) {
    allow[from] = [...targets];
  }

  return allow;
}

function copy(
  source: ReadonlyMap<string, ReadonlySet<string>> | undefined
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [from, targets] of source ?? []) {
    out.set(from, new Set(targets));
  }
  return out;
}

function add(edges: Map<string, Set<string>>, from: string, to: string): void {
  const targets = edges.get(from);
  if (targets === undefined) {
    edges.set(from, new Set([to]));
    return;
  }
  targets.add(to);
}
