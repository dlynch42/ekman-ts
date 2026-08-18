/**
 * The state graph an entity owns.
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
 * States are interned to integers once, here, in declaration order. The interning is what
 * lets a lookup read an array slot instead of hashing a string, and what lets a resident
 * instance carry its own id rather than deriving one on every check.
 */
export class StateGraph {
  /** By id. Declaration order, which is the order every message built from it uses. */
  readonly #names: readonly string[];
  readonly #ids: ReadonlyMap<string, number>;

  /**
   * Adjacency, by from-id.
   *
   * Undefined means no overlay was declared, which means every transition is legal. That is
   * not the same as an overlay that happens to declare no edges out of a state.
   */
  #rows: readonly (ReadonlySet<number> | undefined)[] | undefined;

  /**
   * The target *names* of each from-node, deduped, in the order they were declared.
   *
   * Kept beside the adjacency rather than derived from it, because this is what a refusal
   * message and a diagram print, and neither should be reworded by a change to how edges
   * are stored. A few hundred bytes per entity that declares transitions, read only off the
   * hot path.
   */
  #declared: readonly (readonly string[] | undefined)[] | undefined;

  constructor(states: Iterable<string>) {
    // Deduped through a Set rather than by a guard in the loop. Every caller that can reach
    // here has already refused duplicate states, so a branch for it would be untestable,
    // while a name array longer than the id map would be silently unaddressable.
    const names = Object.freeze([...new Set(states)]);
    const ids = new Map<string, number>();
    for (const [id, name] of names.entries()) {
      ids.set(name, id);
    }

    this.#names = names;
    this.#ids = ids;
  }

  /** How many states. At least one: an entity with no states never gets this far. */
  get size(): number {
    return this.#names.length;
  }

  /** Every declared state, in declaration order. */
  get states(): readonly string[] {
    return this.#names;
  }

  /** Whether an edge overlay was declared. False means every transition is legal. */
  get hasEdges(): boolean {
    return this.#rows !== undefined;
  }

  has(state: string): boolean {
    return this.#ids.has(state);
  }

  /** The interned id, or `UNKNOWN_STATE` for a name this graph does not declare. */
  idOf(state: string): number {
    return this.#ids.get(state) ?? UNKNOWN_STATE;
  }

  nameOf(id: number): string | undefined {
    return this.#names[id];
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
   */
  declareEdges(edges: Iterable<readonly [string, readonly string[]]>): void {
    if (this.#rows !== undefined) {
      // Not an EkmanError: no configuration a user can write reaches this. It is a second
      // caller inside this package installing an overlay over one already in place, and
      // telling them their config is invalid would be a lie.
      throw new Error("this state graph already has an edge overlay");
    }

    const rows: (ReadonlySet<number> | undefined)[] = Array.from({
      length: this.size,
    });
    const declared: (readonly string[] | undefined)[] = Array.from({
      length: this.size,
    });

    for (const [from, targets] of edges) {
      const fromId = this.#nodeId(from);
      const ids = new Set<number>();
      const names: string[] = [];

      for (const target of targets) {
        const toId = this.#nodeId(target);
        if (!ids.has(toId)) {
          names.push(target);
        }
        ids.add(toId);
      }

      rows[fromId] = ids;
      declared[fromId] = Object.freeze(names);
    }

    this.#rows = Object.freeze(rows);
    this.#declared = Object.freeze(declared);
  }

  /**
   * Whether an edge exists. With no overlay, yes, for every pair of declared states.
   *
   * The name form. `allowsId` is the one a hot path calls; this is the one analysis, export
   * and tests call, and it is defined in terms of the other so there is one rule.
   */
  allows(from: string, to: string): boolean {
    return this.allowsId(this.idOf(from), this.idOf(to));
  }

  /** The same question with the interning already done. Ids in, nothing allocated. */
  allowsId(fromId: number, toId: number): boolean {
    const rows = this.#rows;
    if (rows === undefined) {
      return true;
    }
    return rows[fromId]?.has(toId) === true;
  }

  /**
   * Declared targets of a state, deduped and in declaration order.
   *
   * With no overlay this is every state, because that is what "every transition is legal"
   * means. With an overlay and no row it is empty. A state this graph does not declare has
   * no targets either way.
   */
  targetsOf(from: string): readonly string[] {
    if (!this.has(from)) {
      return NO_TARGETS;
    }

    const declared = this.#declared;
    if (declared === undefined) {
      return this.#names;
    }

    return declared[this.idOf(from)] ?? NO_TARGETS;
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
    return this.#names.filter((state) => this.outDegree(state) === 0);
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
    return this.#names.filter(
      (state) => state !== from && !reachable.has(state)
    );
  }

  #nodeId(state: string): number {
    const id = this.#ids.get(state);
    if (id === undefined) {
      throw new Error(`this state graph has no state "${state}"`);
    }
    return id;
  }
}

/**
 * What a state this graph does not declare interns to.
 *
 * Negative on purpose: it can never index a row, so an unknown state falls out of every
 * lookup as "no edges" without a branch that exists only to ask about it. A store holding a
 * state name an entity no longer declares is the case that produces one.
 */
export const UNKNOWN_STATE = -1;

const NO_TARGETS: readonly string[] = Object.freeze([]);
