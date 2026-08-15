/**
 * The index of who is sitting where, and since when.
 *
 * One structure with two consumers. Temporal constraints ask "what has been in this state
 * too long"; a time-in-state query asks the same question with a different bound. Building
 * two mechanisms for one question is how the two answers start disagreeing.
 *
 * The index holds keys only. `enteredAt` lives on the instance record, which is the single
 * source of truth for it, so an index entry can never drift from the instance it names.
 */
export class TemporalIndex {
  /** entity -> state -> keys. */
  readonly #byEntity = new Map<string, Map<string, Set<string>>>();
  /** key -> where it is currently indexed, so a move does not have to search. */
  readonly #placement = new Map<string, { entity: string; state: string }>();

  /** Record that a key now sits in a state, removing it from wherever it was. */
  enter(key: string, entity: string, state: string): void {
    this.remove(key);

    let states = this.#byEntity.get(entity);
    if (states === undefined) {
      states = new Map();
      this.#byEntity.set(entity, states);
    }

    let keys = states.get(state);
    if (keys === undefined) {
      keys = new Set();
      states.set(state, keys);
    }

    keys.add(key);
    this.#placement.set(key, { entity, state });
  }

  /** Drop a key entirely. Used when an instance is evicted or discarded. */
  remove(key: string): void {
    const placed = this.#placement.get(key);
    if (placed === undefined) {
      return;
    }

    this.#placement.delete(key);
    const keys = this.#byEntity.get(placed.entity)?.get(placed.state);
    keys?.delete(key);

    if (keys?.size === 0) {
      this.#byEntity.get(placed.entity)?.delete(placed.state);
    }
  }

  /**
   * Keys currently in a state, in the order they entered it.
   *
   * A `Set` preserves insertion order, and entries are re-inserted on every move, so this
   * is oldest-first for any non-decreasing clock. Callers walk the whole bucket rather
   * than stopping early, because a clock that steps backwards would otherwise hide an
   * entry behind a newer one permanently.
   */
  keys(entity: string, state: string): readonly string[] {
    const keys = this.#byEntity.get(entity)?.get(state);
    return keys === undefined ? [] : [...keys];
  }

  /** Every state of an entity that currently holds at least one key. */
  states(entity: string): readonly string[] {
    const states = this.#byEntity.get(entity);
    return states === undefined ? [] : [...states.keys()];
  }

  /** How many keys are indexed. Resident instances only, by construction. */
  get size(): number {
    return this.#placement.size;
  }
}
