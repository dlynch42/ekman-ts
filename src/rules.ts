import { constraintsOf } from "./compiled";
import type { CommittedRecord, RuntimeDeps } from "./config";
import type { CompiledRule, RuleTrigger } from "./constraints";
import { thrownMessage } from "./constraints";
import type { AnyDefinition, AnyInstance, Residency } from "./residency";
import { telemetryNow } from "./telemetry";
import type { EscalationOutcome } from "./temporal";
import { freshCause, refusalOutcome } from "./temporal";
import type { InstanceSnapshot, Trigger } from "./types";

/** What the rules need from the runtime, beyond the dependencies every part shares. */
export interface RuleContext {
  readonly deps: RuntimeDeps;
  /** Deliver a proposal as a trigger, through the same door as any other. */
  readonly send: (key: string, trigger: Trigger) => Promise<unknown>;
  /** Draw the next trigger id from the runtime's counter. */
  readonly nextTriggerId: () => string;
}

/**
 * Condition rules: asked after every commit of an instance they watch, and proposing a
 * transition, as a trigger, when their condition comes to hold.
 *
 * A rule never writes state. What it proposes rides on a trigger the instance's handler
 * receives like any other, and the handler decides.
 */
export class Rules {
  readonly #ctx: RuleContext;
  readonly #deps: RuntimeDeps;
  /**
   * The rules of each entity that declares any, by watched state. Kept apart from the
   * definitions so a commit of an entity with no rules pays one lookup to learn that.
   */
  readonly #byEntity = new Map<
    string,
    ReadonlyMap<string, readonly CompiledRule[]>
  >();

  constructor(ctx: RuleContext) {
    this.#ctx = ctx;
    this.#deps = ctx.deps;
  }

  /** Take in the rules an entity declares, if it declares any. */
  register(definition: AnyDefinition): void {
    const rules = constraintsOf(definition)?.rulesByState;
    if (rules !== undefined && rules.size > 0) {
      this.#byEntity.set(definition.name, rules);
    }
  }

  /**
   * Ask the rules watching the state a record has just committed in.
   *
   * @param residency where the record that committed is held
   */
  committed(record: CommittedRecord, residency: Residency): void {
    const rules = this.#byEntity.get(record.entity)?.get(record.state);
    if (rules !== undefined) {
      this.#evaluate(residency.get(record.key) as AnyInstance, rules);
    }
  }

  /**
   * Arm again every rule whose condition does not hold on an instance just loaded.
   *
   * A stream records a rule matching and never records it ceasing to, so the latch a
   * load rebuilds can name a rule as done whose condition stopped holding long ago.
   * Left alone, the commit that next made it hold would be passed over.
   */
  rearm(instance: AnyInstance): void {
    const rules = this.#byEntity.get(instance.entity)?.get(instance.state);
    if (rules === undefined) {
      return;
    }

    const snapshot = instance.snapshot();
    for (const rule of rules) {
      if (heldBy(rule, snapshot) === undefined) {
        instance.rearm(rule.name);
      }
    }
  }

  /**
   * Ask each rule watching an instance's state whether its condition holds on what was
   * just committed, and propose for the ones that have come to hold.
   *
   * A rule that holds and has already said so is passed over, which is what makes a
   * value that stays over a threshold one proposal. One that does not hold is armed
   * again. Run from the commit hook, inside the committing turn, so nothing here waits.
   */
  #evaluate(instance: AnyInstance, rules: readonly CompiledRule[]): void {
    const snapshot = instance.snapshot();

    for (const rule of rules) {
      const reason = heldBy(rule, snapshot);
      if (reason === undefined) {
        instance.rearm(rule.name);
      } else if (
        !(instance.hasFired(rule.name) || instance.isProposing(rule.name))
      ) {
        this.#propose(instance, rule, reason);
      }
    }
  }

  /**
   * Record that a rule's condition came to hold and, unless it only warns, send its
   * proposal.
   *
   * The proposal goes through `send()` and is not awaited: this runs inside the turn of
   * the commit that made the condition hold, and the proposal queues behind it. The
   * runtime never writes state on its own. `propose` rides on the trigger, and the
   * handler decides.
   *
   * A proposal that was turned away for a reason that passes stays owed. The match is
   * already in the stream, so the next commit sends the trigger again under the id that
   * match named and records nothing twice.
   */
  #propose(instance: AnyInstance, rule: CompiledRule, reason: string): void {
    const owed = instance.undelivered(rule.name);
    const cause =
      owed === undefined
        ? freshCause(instance, rule.trigger, this.#ctx.nextTriggerId)
        : { type: rule.trigger, id: owed };
    const { key, entity, state } = instance;

    if (owed === undefined) {
      instance.violation({
        violation: {
          kind: "rule",
          name: rule.name,
          policy: rule.policy,
          reason,
        },
        at: this.#deps.now(),
        cause,
      });
      this.#deps.emit({
        type: "constraint.violated",
        key,
        entity,
        state,
        kind: "rule",
        constraint: rule.name,
        policy: rule.policy,
        reason,
        trigger: cause,
        at: telemetryNow(),
      });
    }

    if (rule.policy === "warn") {
      return;
    }

    const trigger: RuleTrigger<string, string> = {
      ...cause,
      rule: rule.name,
      state,
      ...(rule.propose === undefined ? {} : { propose: rule.propose }),
      reason,
    };
    instance.proposing(rule.name, cause.id);

    this.#ctx
      .send(key, trigger)
      .then(
        (): EscalationOutcome => "delivered",
        (error: unknown): EscalationOutcome => {
          this.#deps.onUnhandled(error, { source: "escalation", key });
          return refusalOutcome(error);
        }
      )
      .then((outcome) => {
        instance.proposed(rule.name, cause.id);
        if (outcome === "refused") {
          instance.refused(rule.name, cause.id);
        }
        this.#deps.emit({
          type: "constraint.escalated",
          key,
          entity,
          kind: "rule",
          constraint: rule.name,
          state,
          escalateTo: rule.propose,
          trigger: cause,
          delivered: outcome === "delivered",
          at: telemetryNow(),
        });
      });
  }
}

/**
 * What a rule's condition says about an instance: why it holds, or undefined when it
 * does not. A condition that throws holds, with what it threw as the reason, because a
 * broken condition read as "does not hold" would be a rule that silently never fires.
 */
function heldBy(
  rule: CompiledRule,
  snapshot: InstanceSnapshot
): string | undefined {
  let outcome: boolean | string;
  try {
    outcome = rule.when(snapshot);
  } catch (thrown) {
    return `the condition threw: ${thrownMessage(thrown)}`;
  }
  if (outcome === false) {
    return;
  }
  return typeof outcome === "string" ? outcome : "the condition held";
}
