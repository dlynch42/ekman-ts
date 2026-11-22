import { constraintsOf } from "./compiled";
import type { RuntimeDeps } from "./config";
import type {
  CompiledBound,
  StaleTrigger,
  TemporalTrigger,
} from "./constraints";
import { limitOf } from "./constraints";
import { EkmanError } from "./errors";
import { MAX_TIMER_MS } from "./policy";
import { isQuiet, scanStore } from "./query";
import type { AnyDefinition, AnyInstance, Residency } from "./residency";
import type { ScanMatch, StorageSweep, Store } from "./store";
import { telemetryNow } from "./telemetry";
import type { EscalationOutcome } from "./temporal";
import { freshCause, refusalOutcome } from "./temporal";
import type { Trigger } from "./types";

/**
 * The two passes the runtime makes on its own: one over time, raising what each bound is
 * owed, and one over storage, reclaiming what each layer can.
 *
 * Neither is on the commit path. Both run when asked and, optionally, on an interval.
 */

/**
 * A pass that runs one at a time, when called and optionally on an interval.
 *
 * Overlapping passes are not useful, so a call made while one is running, or after the
 * runtime began closing, answers with `skipped` at once and does not queue behind it.
 */
export class PeriodicPass<T> {
  readonly #once: () => Promise<T>;
  readonly #skipped: T;
  readonly #closing: AbortSignal;
  /**
   * Declared here and assigned in the constructor rather than initialized inline. An
   * inline `= false` narrows the field to the literal `false`, after which the re-entry
   * guard that reads it looks statically dead. The inbox's `#running` carries the same
   * note for the same reason.
   */
  #running: boolean;
  #settled: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param once one pass
   * @param skipped what a call answers when it did not run a pass
   * @param closing aborted when the runtime begins to close
   */
  constructor(once: () => Promise<T>, skipped: T, closing: AbortSignal) {
    this.#once = once;
    this.#skipped = skipped;
    this.#closing = closing;
    this.#running = false;
  }

  /** The pass under way, settled either way, for a shutdown to wait on. */
  get settled(): Promise<void> | undefined {
    return this.#settled;
  }

  async run(): Promise<T> {
    if (this.#running || this.#closing.aborted) {
      return this.#skipped;
    }

    this.#running = true;
    const running = this.#once();
    this.#settled = running.then(noop, noop);
    try {
      return await running;
    } finally {
      this.#running = false;
      this.#settled = undefined;
    }
  }

  /**
   * Call `tick` on an interval that does not keep the process alive.
   *
   * A pass is background work. A runtime that is otherwise finished should be allowed to
   * exit rather than being held open by its own housekeeping.
   */
  every(ms: number, tick: () => void): void {
    this.#timer = setInterval(tick, ms);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
  }
}

/**
 * Refuse an interval a timer could not hold.
 *
 * @param what which pass, as its config section is named
 * @param otherwise what leaving the setting out means, to finish the message
 */
export function assertSweepInterval(
  sweepMs: number,
  what: "temporal" | "storage",
  otherwise: string
): void {
  if (!(sweepMs > 0 && sweepMs <= MAX_TIMER_MS)) {
    throw new EkmanError(
      "INVALID_CONFIG",
      `${what} sweepMs must be a positive number of milliseconds, at most ${MAX_TIMER_MS}, received ${JSON.stringify(sweepMs)}. ` +
        `Omit it to ${otherwise}.`
    );
  }
}

/** What the time pass needs from the runtime, beyond the dependencies every part shares. */
export interface SweepContext {
  readonly deps: RuntimeDeps;
  readonly definitions: ReadonlyMap<string, AnyDefinition>;
  readonly residency: Residency;
  /** Deletions still in progress, by key. A load of the key waits for its entry. */
  readonly forgetting: ReadonlyMap<string, Promise<void>>;
  /** Deliver an escalation as a trigger, through the same door as any other. */
  readonly send: (key: string, trigger: Trigger) => Promise<unknown>;
  /** Draw the next trigger id from the runtime's counter. */
  readonly nextTriggerId: () => string;
}

/**
 * Evaluates time-in-state and freshness bounds, for what is resident and for what a store
 * holds, and raises what each is owed as a trigger.
 */
export class TemporalSweeper {
  readonly #ctx: SweepContext;
  readonly #deps: RuntimeDeps;
  readonly #residency: Residency;
  /**
   * Stored instances the last sweep loaded and found nothing to raise for, by key.
   *
   * Without it every pass would load each instance that has sat past its bound and
   * already been told so. A pass drops every note it did not see the key for, so this
   * never holds more than the stored instances currently past a bound, and deleting an
   * instance drops its note, so a key created again is not mistaken for the one before.
   */
  readonly #settled = new Map<string, SettledNote>();

  constructor(ctx: SweepContext) {
    this.#ctx = ctx;
    this.#deps = ctx.deps;
    this.#residency = ctx.residency;
  }

  /** Drop what was noted about a key that is being deleted. */
  forget(key: string): void {
    this.#settled.delete(key);
  }

  /**
   * Evaluate every bound once, for resident instances and then for stored ones, and
   * deliver whatever escalations are due.
   *
   * @returns how many bounds fired
   */
  async once(): Promise<number> {
    const at = this.#deps.now();
    const noted = new Set<string>();
    let fired = 0;

    for (const definition of this.#ctx.definitions.values()) {
      const byState = constraintsOf(definition)?.boundsByState;
      // An entity with guards or a transition graph and no bound of either kind has an
      // empty map here, and nothing to sweep. Asking its store anyway would read every
      // instance.
      if (byState === undefined || byState.size === 0) {
        continue;
      }

      for (const [state, constraints] of byState) {
        for (const key of this.#residency.keysIn(definition.name, state)) {
          // biome-ignore lint/performance/noAwaitInLoops: an escalation dispatches like any other trigger, and a pass that fired several should report every one of them as processed
          fired += await this.#sweepInstance(key, state, constraints, at);
        }
      }

      fired += await this.#sweepStore(definition, byState, at, noted);
    }

    for (const key of this.#settled.keys()) {
      if (!noted.has(key)) {
        this.#settled.delete(key);
      }
    }
    return fired;
  }

  /**
   * Evaluate the instances of an entity that a store holds and this runtime does not.
   *
   * The instances most likely to be stuck are the idle ones, which are the first a memory
   * budget releases, and after a restart nothing is resident at all. So the store is asked
   * the same questions a query asks: who has been in a state for longer than this, and
   * who has not committed for longer than that.
   *
   * One scan per entity for each kind of bound it declares, bounded by the shortest bound
   * of that kind on any of its states, and told which keys are resident so it does not
   * load them. A store that cannot be scanned is reported and the pass moves on, because
   * a sweep on an interval has no caller.
   */
  async #sweepStore(
    definition: AnyDefinition,
    byState: ReadonlyMap<string, readonly CompiledBound[]>,
    at: number,
    noted: Set<string>
  ): Promise<number> {
    const { authority } = this.#deps.stack;
    if (authority === undefined) {
      return 0;
    }

    const skip = new Set<string>();
    for (const state of byState.keys()) {
      for (const key of this.#residency.keysIn(definition.name, state)) {
        // Only a record that is current speaks for its key. One another writer has
        // overtaken is passed over by the resident walk, so the store is asked about it.
        if (this.#residency.get(key)?.needsHydration === false) {
          skip.add(key);
        }
      }
    }

    const bounds = [...byState.values()].flat();
    let due: readonly ScanMatch[];
    try {
      due = await this.#scanDue(authority, definition.name, bounds, at, skip);
    } catch (error) {
      this.#deps.onUnhandled(error, { source: "sweep" });
      return 0;
    }

    let fired = 0;
    for (const [state, constraints] of byState) {
      const waiting = due
        .filter(
          (match) =>
            match.state === state &&
            constraints.some((bound) => isPast(bound, match, at))
        )
        .sort(byKey);

      for (const match of waiting) {
        // biome-ignore lint/performance/noAwaitInLoops: stored instances are escalated one at a time, in key order, for the same reason resident ones are
        fired += await this.#sweepStored(
          match,
          definition,
          constraints,
          at,
          noted
        );
      }
    }

    return fired;
  }

  /**
   * Ask a store which instances of an entity could be past one of these bounds.
   *
   * Time in state and time since the last commit are different criteria, and a scan
   * applies every criterion it is given at once, so each kind of bound gets its own scan
   * and the answers are joined by key.
   */
  async #scanDue(
    authority: Store,
    entity: string,
    bounds: readonly CompiledBound[],
    at: number,
    skip: ReadonlySet<string>
  ): Promise<readonly ScanMatch[]> {
    const found = new Map<string, ScanMatch>();

    for (const kind of ["temporal", "stale"] as const) {
      const limits = bounds.filter((bound) => bound.kind === kind).map(limitOf);
      if (limits.length === 0) {
        continue;
      }

      const shortest = Math.min(...limits);
      // biome-ignore lint/performance/noAwaitInLoops: at most two scans, and the second is only worth making once the first has not failed
      const scanned = await scanStore(authority, {
        entity,
        now: at,
        skip,
        ...(kind === "temporal"
          ? { olderThanMs: shortest }
          : { staleForMs: shortest }),
      });
      for (const match of scanned.matches) {
        found.set(match.key, match);
      }

      if (!scanned.complete) {
        // Said out loud, because the instances the store left out are not swept and
        // nothing else would ever mention them.
        this.#deps.onUnhandled(
          new EkmanError(
            "NOT_IMPLEMENTED",
            `store "${authority.name}" answered a scan of ${JSON.stringify(entity)} ` +
              "with part of the answer, and a sweep has no way to ask for the rest. " +
              "Its bounds were evaluated for the instances it returned and " +
              "for no others it holds."
          ),
          { source: "sweep" }
        );
      }
    }

    return [...found.values()];
  }

  /**
   * Load one stored instance that is past a bound, and evaluate it like a resident one.
   *
   * Loading it is the same thing a trigger for an evicted instance does, and the budget
   * sees it the same way: the instance comes back, is told what it is owed, and is
   * released again once idle. The load never creates the key. A scan row can outlive the
   * instance it describes, and a sweep that initialized whatever it could not find would
   * bring a deleted instance back.
   *
   * A load that is refused, by a full budget or by the store, is reported and left for
   * the next pass.
   */
  async #sweepStored(
    match: ScanMatch,
    definition: AnyDefinition,
    constraints: readonly CompiledBound[],
    at: number,
    noted: Set<string>
  ): Promise<number> {
    if (this.#deps.closing.aborted) {
      // Nothing is loaded on behalf of a runtime that is shutting down. Whatever this
      // instance is owed, the next runtime's sweep finds it the same way.
      return 0;
    }

    const { key, state } = match;
    const note = this.#settled.get(key);
    if (
      note !== undefined &&
      note.seq === match.seq &&
      note.enteredAt === match.enteredAt &&
      at < note.dueAt
    ) {
      noted.add(key);
      return 0;
    }

    const forgetting = this.#ctx.forgetting.get(key);
    if (forgetting !== undefined) {
      await forgetting;
    }
    if (this.#deps.closing.aborted) {
      return 0;
    }
    const resident = this.#residency.get(key);
    if (resident !== undefined) {
      if (!(resident.needsHydration && resident.idle)) {
        // Current, in which case the next pass finds it there. Or busy, and the trigger
        // it is handling reconciles it.
        return 0;
      }
      // Behind the store with nothing to prompt a reload, so it would sit out every
      // pass. Released, and read back below like any other instance the store holds.
      this.#residency.evict(resident);
    }

    let instance: AnyInstance;
    try {
      const cause = { type: "sweep", id: this.#ctx.nextTriggerId() };
      instance = this.#residency.materialize(key, definition, cause, true);
    } catch (error) {
      this.#deps.onUnhandled(error, { source: "sweep", key });
      return 0;
    }

    // Held from before the load until every bound has been read. Nothing is queued on
    // the record, so without this it looks idle throughout: it could be evicted or
    // deleted while it loads, and an escalation's own turn ending would release it with
    // its other bounds still to evaluate.
    const unpin = instance.pin();
    try {
      await this.#deps.reconcile(instance);
      if (this.#deps.closing.aborted || !this.#residency.holds(instance)) {
        // Nothing stored after all, or the runtime began to close while it loaded, in
        // which case nothing more is written on its behalf.
        return 0;
      }

      const fired = await this.#sweepInstance(key, state, constraints, at);

      if (instance.state === state && !instance.needsHydration) {
        noted.add(key);
        this.#settled.set(key, {
          seq: instance.seq,
          enteredAt: instance.enteredAt,
          dueAt: nextDue(instance, constraints, at),
        });
      }
      return fired;
    } catch (error) {
      this.#deps.onUnhandled(error, { source: "sweep", key });
      return 0;
    } finally {
      unpin();
      this.#rest(instance);
    }
  }

  /**
   * Offer a record the sweep loaded to eviction, if nothing else has.
   *
   * A record is normally offered when its inbox drains. One the sweep loaded and sent
   * nothing to never ran a turn, so nothing would offer it, and it would stay resident
   * past the budget until some other key went idle.
   */
  #rest(instance: AnyInstance): void {
    // Not while a trigger that arrived in the meantime is still being handled. Its own
    // turn ending is what offers the record then.
    if (instance.idle) {
      this.#residency.offer(instance);
    }
  }

  /**
   * Evaluate one instance against the constraints watching the state it is in.
   *
   * Constraints run in declaration order. One is done once its escalation has been
   * answered or refused for good, so an escalation turned away by a full inbox is raised
   * again by the next sweep. The pass ends as soon as the instance has left the state: the
   * remaining constraints watch somewhere it no longer is.
   *
   * @returns how many escalations were raised, delivered or not
   */
  async #sweepInstance(
    key: string,
    state: string,
    constraints: readonly CompiledBound[],
    at: number
  ): Promise<number> {
    let fired = 0;

    for (const constraint of constraints) {
      const aged = this.#residency.ageOf(key, state, at);
      if (aged === undefined) {
        return fired;
      }

      const { instance } = aged;
      // Time in the state for one kind of bound, time since anything was committed for
      // the other. Read again for each bound, since the one before may have committed.
      const elapsedMs =
        constraint.kind === "temporal"
          ? aged.elapsedMs
          : at - instance.lastCommittedAt;
      if (
        elapsedMs < limitOf(constraint) ||
        instance.hasFired(constraint.name)
      ) {
        continue;
      }

      fired += 1;
      // biome-ignore lint/performance/noAwaitInLoops: two constraints on one state fire in declaration order, and the second runs only if the first left the instance where it was
      await this.#escalate(instance, constraint, elapsedMs, at);
    }

    return fired;
  }

  /**
   * Record a bound's violation and, unless it is only a warning, deliver its escalation.
   *
   * The escalation goes through `send()`, so it queues behind whatever the instance is
   * already doing and dispatches against the state it is in when its turn comes. The
   * runtime never writes state on its own: the state asked for rides on the trigger, as
   * `escalateTo` for a time-in-state bound and `propose` for a freshness bound, and the
   * handler decides.
   *
   * A trigger id is allocated even for a warning, so the recorded violation always has a
   * traceable cause and the counter advances identically under either policy. When an
   * earlier sweep raised this escalation and it was turned away, the violation is already
   * in the stream, so only the trigger is sent again, under the id that violation named.
   *
   * A send that rejects is reported through `onUnhandled` rather than thrown: the usual
   * cause is that the state an instance is stuck in cannot handle the trigger, which is
   * exactly the situation the constraint was watching for.
   */
  async #escalate(
    instance: AnyInstance,
    constraint: CompiledBound,
    elapsedMs: number,
    at: number
  ): Promise<EscalationOutcome> {
    const owed = instance.undelivered(constraint.name);
    const cause =
      owed === undefined
        ? freshCause(instance, constraint.trigger, this.#ctx.nextTriggerId)
        : { type: constraint.trigger, id: owed };
    const { state } = instance;
    const target =
      constraint.kind === "temporal"
        ? constraint.escalateTo
        : constraint.propose;
    const trigger:
      | TemporalTrigger<string, string>
      | StaleTrigger<string, string> = {
      ...cause,
      constraint: constraint.name,
      state,
      sinceMs: elapsedMs,
      ...(target === undefined
        ? {}
        : {
            [constraint.kind === "temporal" ? "escalateTo" : "propose"]: target,
          }),
    };

    if (owed === undefined) {
      this.#recordBoundViolation(instance, constraint, elapsedMs, at, cause);
    }

    if (constraint.policy === "warn") {
      return "warned";
    }

    let outcome: EscalationOutcome = "delivered";
    try {
      await this.#ctx.send(instance.key, trigger);
    } catch (error) {
      outcome = refusalOutcome(error);
      this.#deps.onUnhandled(error, {
        source: "escalation",
        key: instance.key,
      });
    }
    if (outcome === "refused") {
      // The one ending the stream does not show. A commit or a recorded refusal has
      // settled the bound already, and one turned away for a reason that passes stays
      // owed for the next sweep.
      instance.refused(constraint.name, cause.id);
    }

    this.#deps.emit({
      type: "constraint.escalated",
      key: instance.key,
      entity: instance.entity,
      kind: constraint.kind,
      constraint: constraint.name,
      state,
      elapsedMs,
      escalateTo: target,
      trigger: cause,
      delivered: outcome === "delivered",
      at: telemetryNow(),
    });

    return outcome;
  }

  /** Write a bound's violation to the instance's stream and mirror it in telemetry. */
  #recordBoundViolation(
    instance: AnyInstance,
    constraint: CompiledBound,
    elapsedMs: number,
    at: number,
    cause: { type: string; id: string }
  ): void {
    const reason =
      constraint.kind === "temporal"
        ? `has been in "${constraint.in}" for ${elapsedMs}ms, over its bound of ` +
          `${constraint.within}ms`
        : `has committed nothing for ${elapsedMs}ms, over its bound of ` +
          `${constraint.after}ms`;

    instance.violation({
      violation: {
        kind: constraint.kind,
        name: constraint.name,
        policy: constraint.policy,
        reason,
      },
      at,
      cause,
    });

    this.#deps.emit({
      type: "constraint.violated",
      key: instance.key,
      entity: instance.entity,
      state: instance.state,
      kind: constraint.kind,
      constraint: constraint.name,
      policy: constraint.policy,
      reason,
      trigger: cause,
      at: telemetryNow(),
    });
  }
}

/** What a sweep learned about a stored instance it loaded, kept so it need not load it again. */
interface SettledNote {
  /** The sequence the instance was at. Any commit since makes the note out of date. */
  readonly seq: number;
  /** When it entered its state, which a different instance under the same key would not share. */
  readonly enteredAt: number;
  /** The earliest moment one of its bounds could have something new to say. */
  readonly dueAt: number;
}

/**
 * Reclaim stored bytes once, across every layer that can, and report each layer's pass.
 */
export async function sweepStorageOnce(
  deps: Pick<RuntimeDeps, "stack" | "emit">
): Promise<StorageSweep> {
  let logs = 0;
  let reclaimed = 0;
  const overBudget: string[] = [];

  for (const layer of deps.stack.layers) {
    if (!(layer.capabilities.compact && layer.compact)) {
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: layers are swept in stack order so the telemetry reads in that order, and so two layers never rewrite their logs at the same moment
    const swept = await layer.compact();
    logs += swept.logs;
    reclaimed += swept.reclaimed;
    if (!swept.withinBudget) {
      overBudget.push(layer.name);
    }

    // Read after the pass, so this is what the layer holds now rather than what it held
    // when the pass started.
    const usage = layer.usage?.();
    deps.emit({
      type: "storage.swept",
      at: telemetryNow(),
      store: layer.name,
      logs: swept.logs,
      reclaimed: swept.reclaimed,
      bytes: usage?.bytes ?? 0,
      maxBytes: usage?.maxBytes ?? null,
      withinBudget: swept.withinBudget,
    });
  }

  return Object.freeze({
    logs,
    reclaimed,
    overBudget: Object.freeze(overBudget),
  });
}

/** What an overlapping storage sweep returns: a pass that did not run reclaimed nothing. */
export const EMPTY_SWEEP: StorageSweep = Object.freeze({
  logs: 0,
  reclaimed: 0,
  overBudget: Object.freeze([]),
});

/**
 * Order scan rows by key, as plain strings, so a pass walks them the same way every time.
 * A store holds a key once, so there is no equal case.
 */
function byKey(a: ScanMatch, b: ScanMatch): number {
  return a.key < b.key ? -1 : 1;
}

/**
 * When a bound on this instance could next have something to say.
 *
 * A bound that has fired has nothing more to say during this stay. One that is owed an
 * escalation is due now. One that has not fired is due when its time is up.
 */
function nextDue(
  instance: AnyInstance,
  constraints: readonly CompiledBound[],
  at: number
): number {
  let dueAt = Number.POSITIVE_INFINITY;
  for (const constraint of constraints) {
    if (instance.hasFired(constraint.name)) {
      continue;
    }
    const since =
      constraint.kind === "temporal"
        ? instance.enteredAt
        : instance.lastCommittedAt;
    const due =
      instance.undelivered(constraint.name) === undefined
        ? since + limitOf(constraint)
        : at;
    dueAt = Math.min(dueAt, due);
  }
  return dueAt;
}

/** Whether a scan row is past a bound, on the clock that bound reads. */
function isPast(bound: CompiledBound, match: ScanMatch, at: number): boolean {
  return bound.kind === "temporal"
    ? at - match.enteredAt >= bound.within
    : isQuiet(match, bound.after, at);
}

function noop(): void {
  // Deliberately empty: settles a promise whose outcome is somebody else's to report.
}
