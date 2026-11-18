import type { ErrorCode } from "./errors";
import { isEkmanError } from "./errors";
import type { EkmanEvent, EventCause } from "./events";

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

  /**
   * How many keys are indexed. Resident instances only, by construction: an instance a
   * store holds and this runtime does not is found by scanning the store.
   */
  get size(): number {
    return this.#placement.size;
  }
}

/**
 * How one attempt to escalate a temporal constraint ended.
 *
 * `delivered` and `warned` are the two ways of having said what there was to say. The two
 * refusals differ in what the next sweep should do: a `refused` escalation would be refused
 * again, so the constraint is done for this entry into its state, while one
 * `refused-transiently` was turned away by a condition that passes and is owed another try.
 */
export type EscalationOutcome =
  | "delivered"
  | "warned"
  | "refused"
  | "refused-transiently";

/**
 * Refusals that say nothing about the trigger itself: the inbox or the memory budget was
 * full, the attempt ran out of time, the store could not take the write just then, or the
 * runtime was closing. The last is owed to whichever runtime loads the instance next.
 */
const TRANSIENT_REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "INBOX_OVERFLOW",
  "TRIGGER_DROPPED",
  "MEMORY_EXHAUSTED",
  "HANDLER_TIMEOUT",
  "STORE_CONFLICT",
  "STORE_UNAVAILABLE",
  "STORE_FULL",
  "RUNTIME_CLOSED",
]);

/** Classify the error an escalation's `send()` rejected with. */
export function refusalOutcome(
  error: unknown
): Extract<EscalationOutcome, "refused" | "refused-transiently"> {
  return isEkmanError(error) && TRANSIENT_REFUSALS.has(error.code)
    ? "refused-transiently"
    : "refused";
}

/**
 * What an instance's time-in-state bounds and rules have already said about its current
 * stay in a state, in a form a store can hold.
 *
 * `fired` names the bounds and rules that are done for now. `owed` names the ones whose
 * violation is recorded and whose trigger was turned away for a reason that passes, with
 * the cause that violation named, so whoever loads the instance next can deliver it under
 * the same id and record nothing twice.
 *
 * One record serves both kinds, which is why their names are distinct within an entity.
 */
export interface TemporalLatch {
  readonly fired: readonly string[];
  readonly owed: Readonly<Record<string, EventCause>>;
}

/**
 * Rebuilds a latch from a stream, one event at a time, in stream order.
 *
 * It reaches the same answer the runtime reached while the instance was resident, from
 * what the stream recorded: a violation under `warn` is all there was to say; one under
 * `reject` is owed an escalation until the stream shows that trigger committing or being
 * refused for good; a refusal that passes leaves it owed.
 */
export class LatchFold {
  readonly #fired = new Set<string>();
  readonly #owed = new Map<string, EventCause>();

  constructor(seed?: TemporalLatch) {
    this.merge(seed);
  }

  /** The instance moved to another state, so nothing said about the last one carries over. */
  moved(): void {
    this.#fired.clear();
    this.#owed.clear();
  }

  /** Take one event recorded during the current stay in a state. */
  apply(event: EkmanEvent): void {
    if (event.type === "violation") {
      const { kind, name } = event.constraint;
      if (kind === "rule") {
        // A rule that matches again was armed again in between, which no event records.
        this.#fired.delete(name);
      } else if (kind !== "temporal" || this.#fired.has(name)) {
        return;
      }
      if (event.policy === "warn") {
        this.#fired.add(event.constraint.name);
      } else {
        this.#owed.set(event.constraint.name, event.cause);
      }
      return;
    }

    const answered =
      event.type === "transition" ||
      (event.type === "rejected" && !TRANSIENT_REFUSALS.has(event.code));
    if (answered) {
      this.#settle(event.cause);
    }
  }

  /** Whether a bound is done for this stay. */
  hasFired(name: string): boolean {
    return this.#fired.has(name);
  }

  /** The cause of the escalation a bound is still owed, if it is owed one. */
  owed(name: string): EventCause | undefined {
    return this.#owed.get(name);
  }

  /** Whether an escalation with this cause is still owed to any bound. */
  owes(cause: EventCause): boolean {
    for (const owed of this.#owed.values()) {
      if (owed.id === cause.id && owed.type === cause.type) {
        return true;
      }
    }
    return false;
  }

  /** Record a bound as done for this stay, whatever it was owed. */
  fire(name: string): void {
    this.#owed.delete(name);
    this.#fired.add(name);
  }

  /**
   * Arm a rule again, because its condition stopped holding. Whatever it had said, and
   * any proposal it was still owed, belonged to a match that is over.
   */
  rearm(name: string): void {
    this.#fired.delete(name);
    this.#owed.delete(name);
  }

  /** Record an escalation as owed to a bound that has not fired. */
  owe(name: string, cause: EventCause): void {
    if (!this.#fired.has(name)) {
      this.#owed.set(name, cause);
    }
  }

  /**
   * Take in what another account of the same stay says.
   *
   * Nothing is forgotten: a bound either side has fired stays fired, and an escalation
   * the other side still owes is owed here too unless this side knows it was answered.
   */
  merge(other: TemporalLatch | undefined): void {
    for (const name of other?.fired ?? []) {
      this.fire(name);
    }
    for (const [name, cause] of Object.entries(other?.owed ?? {})) {
      this.owe(name, cause);
    }
  }

  /** The latch as it stands, or undefined when there is nothing in it. */
  result(): TemporalLatch | undefined {
    if (this.#fired.size === 0 && this.#owed.size === 0) {
      return;
    }
    return { fired: [...this.#fired], owed: Object.fromEntries(this.#owed) };
  }

  #settle(cause: EventCause): void {
    for (const [name, owed] of this.#owed) {
      if (owed.id === cause.id && owed.type === cause.type) {
        this.fire(name);
      }
    }
  }
}
