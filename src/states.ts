/**
 * The states an entity has, and the moves between them it allows.
 *
 * Nodes are the entity's declared states, so the node set exists whether or not the entity
 * declared a single constraint. Edges are an optional overlay: with none declared, every
 * transition is legal and the graph is a statement about which states exist rather than
 * about which moves between them are allowed. That split is the point of the structure.
 * Everything that wants to reason about the shape of an entity, which is escalation-target
 * verification, reachability, diagram export and per-edge guards, needs the nodes of an
 * entity that opted into no constraint at all.
 *
 * Cyclic by construction. Retry loops, pause/resume and review cycles are cycles, and
 * `warn` mode exists so a team can discover its real graph from production before enforcing
 * it: a structure that could not hold a cycle could not hold what `warn` mode observed.
 * Terminal states are out-degree zero, which this answers as a query rather than as a kind
 * of node. A single-state entity is legal, because an accumulator that only ever calls
 * `stay` is a real entity.
 *
 * States are interned to integers once, here, in declaration order. Nothing on the commit
 * path reads an id yet: an edge check has two state *names* in hand and hashing both of them
 * once is cheaper than interning both and hashing the result. The ids are what analysis
 * addresses states by, and what a resident instance will eventually carry so that the source
 * of a transition costs no lookup at all.
 */
export class States {
  /** Nodes by id. Declaration order, which is the order every message built from it uses. */
  readonly #nodes: readonly string[];
  readonly #ids: ReadonlyMap<string, NodeId>;

  /**
   * Adjacency, keyed by the name of the source state.
   *
   * Undefined means no overlay was declared, which means every transition is legal. That is
   * not the same as an overlay that happens to declare no edges out of a state.
   *
   * Keyed by node name rather than by interned id, because an edge check arrives holding
   * two names. Interning both of them to index this costs a hash lookup more than hashing
   * them against it directly, which is measurable on a check this small.
   */
  #edges: ReadonlyMap<string, Adjacency> | undefined;

  /**
   * Deduped through a Set rather than by a guard in the loop. Every caller that can reach
   * here has already refused duplicate states, so a branch for it would be untestable,
   * while a name array longer than the id map would be silently unaddressable.
   */
  constructor(nodes: Iterable<string>) {
    const declared = Object.freeze([...new Set(nodes)]);
    const ids = new Map<string, NodeId>();
    for (const [id, node] of declared.entries()) {
      ids.set(node, id);
    }

    this.#nodes = declared;
    this.#ids = ids;
  }

  /** How many states. At least one: an entity with no states never gets this far. */
  get size(): number {
    return this.#nodes.length;
  }

  /** Every declared state, in declaration order. */
  get names(): readonly string[] {
    return this.#nodes;
  }

  /** Whether an edge overlay was declared. False means every transition is legal. */
  get hasEdges(): boolean {
    return this.#edges !== undefined;
  }

  has(state: string): boolean {
    return this.#ids.has(state);
  }

  /** The interned id, or `UNKNOWN_NODE` for a name that is not declared here. */
  idOf(state: string): NodeId {
    return this.#ids.get(state) ?? UNKNOWN_NODE;
  }

  nameOf(id: NodeId): string | undefined {
    return this.#nodes[id];
  }

  /**
   * Install the edge overlay, once, from edges that have already been validated.
   *
   * Separate from construction because the overlay is not the entity's to declare: it comes
   * from a transition constraint, which carries a policy that may be `off`, and a constraint
   * that is off is not validated at all. Building the overlay at construction would start
   * refusing configurations that compile silently today.
   *
   * Validated by the caller and re-checked here anyway. The caller today has already refused
   * every name the entity does not declare; a caller folding states observed in production
   * has refused nothing. A structure that quietly accepts a node it does not have is how
   * that second caller corrupts it.
   * 
   * A Set both dedupes and keeps insertion order, so the membership test and the
   * printable list are one decision rather than two that could disagree.
   * The list is deliberately not frozen, against the habit everywhere else in this
   * file. A refusal message joins it, and `Array.prototype.join` gives up its fast path
   * on a frozen array: freezing it measured 16% slower on the refusal path than not,
   * which is more than the whole edge lookup costs. `readonly string[]` is the
   * protection instead, and it is the protection every other list in the runtime has.
   */
  declareEdges(edges: Iterable<readonly [string, readonly string[]]>): void {
    if (this.#edges !== undefined) {
      throw new Error("these states already have an edge overlay");
    }

    const adjacency = new Map<string, Adjacency>();

    for (const [from, targets] of edges) {
      this.#assertNode(from);
      for (const target of targets) {
        this.#assertNode(target);
      }

      const out = new Set(targets);
      adjacency.set(from, Object.freeze({ out, declared: [...out] }));
    }

    this.#edges = adjacency;
  }

  /** Whether an edge exists. With no overlay, yes, for every pair of declared states. */
  allows(from: string, to: string): boolean {
    return this.checkEdge(from, to) === undefined;
  }

  /**
   * Undefined when the transition is allowed. Otherwise the declared targets of `from`,
   * which is what a refusal has to name.
   *
   * One question rather than two, because the only caller on the commit path asks both
   * halves of it and asking separately would hash the source state twice on the path that
   * is already doing the most work. Two hash lookups on the legal path, no allocation on
   * either, and this runs before the commit of every transition in the runtime.
   */
  checkEdge(from: string, to: string): readonly string[] | undefined {
    const edges = this.#edges;
    if (edges === undefined) {
      return;
    }

    const adjacent = edges.get(from);
    if (adjacent?.out.has(to) === true) {
      return;
    }

    return adjacent === undefined ? NO_TARGETS : adjacent.declared;
  }

  /**
   * Declared targets of a state, deduped and in declaration order.
   *
   * With no overlay this is every state, because that is what "every transition is legal"
   * means. With an overlay and no row it is empty. A state this graph does not declare has
   * no targets either way.
   */
  targetsOf(from: string): readonly string[] {
    const edges = this.#edges;
    if (edges === undefined) {
      return this.has(from) ? this.#nodes : NO_TARGETS;
    }

    return edges.get(from)?.declared ?? NO_TARGETS;
  }

  outDegree(from: string): number {
    return this.targetsOf(from).length;
  }

  /**
   * States nothing leaves.
   *
   * Empty when no overlay was declared, since everything leaves everything. A terminal is a
   * shape the graph reports, never a kind of node it stores.
   */
  terminals(): readonly string[] {
    return this.#nodes.filter((node) => this.outDegree(node) === 0);
  }

  /**
   * Every state reachable from one, including it when a cycle returns to it.
   *
   * Breadth-first over a graph that is explicitly allowed to contain cycles, so what
   * terminates the walk is membership in `seen` rather than the shape of the data.
   */
  reachableFrom(from: string): ReadonlySet<string> {
    const seen = new Set<string>();
    if (!this.has(from)) {
      return seen;
    }

    let frontier: readonly string[] = [from];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const state of frontier) {
        for (const target of this.targetsOf(state)) {
          if (!seen.has(target)) {
            seen.add(target);
            next.push(target);
          }
        }
      }
      frontier = next;
    }

    return seen;
  }

  /** States no path from `from` ever enters. What define-time analysis reports. */
  unreachableFrom(from: string): readonly string[] {
    const reachable = this.reachableFrom(from);
    return this.#nodes.filter((node) => node !== from && !reachable.has(node));
  }

  /** An internal invariant, not a user's configuration. Everything a user can write is refused with an EkmanError before it reaches here. */
  #assertNode(node: string): void {
    if (!this.#ids.has(node)) {
      throw new Error(`these states have no node "${node}"`);
    }
  }
}

/**
 * A node's interned id.
 *
 * An index into one entity's node list, and meaningless anywhere else. Named rather than
 * left as a bare number because "which entity is this an index into" is the question that
 * makes it wrong, and a number does not ask it.
 */
export type NodeId = number;

/**
 * What a name that is not declared here interns to.
 *
 * Negative on purpose: it can never index the node list, so an unknown name falls out of
 * every lookup without a branch that exists only to ask about it. A store holding a state
 * name an entity no longer declares is the case that produces one.
 */
export const UNKNOWN_NODE: NodeId = -1;

const NO_TARGETS: readonly string[] = Object.freeze([]);

/**
 * One node's outgoing edges, held as both a membership test and a printable list.
 *
 * Two views of one Set, built together at declaration time so that neither the check nor
 * the message it produces has to derive the other.
 */
interface Adjacency {
  readonly out: ReadonlySet<string>;
  readonly declared: readonly string[];
}
