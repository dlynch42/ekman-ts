import type { ProposedCommit } from "./constraints";
import { checkConstraints, rejection, violationError } from "./constraints";
import { resolveErrorHandler } from "./entity";
import { EkmanError, isConstraintViolation } from "./errors";
import type { EventCause } from "./events";
import type { CommitToken } from "./fence";
import { fenceReason } from "./fence";
import type { InstanceRecord } from "./instance";
import { sealValues } from "./instance";
import type { ExecutionPolicy, ResolvedPolicy } from "./policy";
import { backoffDelay, resolvePolicy } from "./policy";
import type { HandlerResult, StayResult, TransitionToResult } from "./results";
import { isHandlerResult, toError } from "./results";
import type { TelemetryEvent } from "./telemetry";
import { telemetryNow, triggerRef } from "./telemetry";
import type {
  CommitResult,
  EntityDefinition,
  Handler,
  HandlerContext,
  Trigger,
  Values,
} from "./types";

/** Everything a dispatch needs that is owned by the runtime rather than the instance. */
export interface DispatchDeps {
  now: () => number;
  /** The runtime-wide execution policy, under every entity and state override. */
  policy: ExecutionPolicy | undefined;
  emit: (event: TelemetryEvent) => void;
}

/**
 * Run one trigger against one instance, to completion.
 *
 * Assumes the caller has already taken this key's turn in the inbox, so no other handler
 * is running for this key. The whole attempt loop runs inside that turn: retries keep the
 * key occupied, and a queued trigger can never slip between two attempts.
 */
export async function dispatch<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  trigger: Trigger,
  deps: DispatchDeps,
  depth: number
): Promise<CommitResult<S, V>> {
  const cause: EventCause = { type: trigger.type, id: trigger.id as string };
  // Wall clock. Duration is telemetry, and the injected clock belongs to the domain
  // event stream.
  const startedAt = telemetryNow();
  const { state } = instance;

  const settle = (
    outcome: "committed" | "failed" | "refused",
    attempt: number
  ): void => {
    const at = telemetryNow();
    deps.emit({
      type: "handler.settled",
      key: instance.key,
      entity: instance.entity,
      state,
      attempt,
      durationMs: at - startedAt,
      outcome,
      trigger: triggerRef(trigger),
      at,
    });
  };

  // The entity may declare which trigger types it recognizes. An unrecognized one never
  // reaches a handler, and is refused loudly rather than dropped.
  const recognized = definition.triggers;
  if (recognized !== null && !recognized.has(trigger.type)) {
    settle("refused", 1);
    return refuse(
      instance,
      deps,
      cause,
      "UNKNOWN_TRIGGER",
      () =>
        `entity "${definition.name}" does not recognize trigger type "${trigger.type}". ` +
        `Recognized: ${[...recognized].join(", ")}`
    );
  }

  // Resolved against the current committed state at the moment this trigger is
  // dequeued, never the state it was enqueued under.
  const entry = definition.handlers.get(instance.state);

  if (entry === undefined) {
    settle("refused", 1);
    return refuse(
      instance,
      deps,
      cause,
      "UNKNOWN_STATE",
      () =>
        `entity "${definition.name}" has no handler for state "${instance.state}", ` +
        `so trigger "${trigger.type}" cannot be dispatched`
    );
  }

  const policy = resolvePolicy(
    deps.policy,
    entry.policy,
    `entity "${definition.name}" state "${instance.state}"`
  );

  return await attemptLoop(instance, definition, trigger, deps, {
    cause,
    policy,
    handler: entry.handler,
    depth,
    settle,
  });
}

interface AttemptContext<S extends string, V extends Values> {
  cause: EventCause;
  policy: ResolvedPolicy;
  handler: Handler<S, V, Trigger>;
  /** Triggers still queued behind this one, for the per-attempt started event. */
  depth: number;
  /** Reports the trigger as finished. Called exactly once per dispatch. */
  settle: (
    outcome: "committed" | "failed" | "refused",
    attempt: number
  ) => void;
}

/**
 * Make attempts until one commits, the failure is not worth retrying, or the attempts run
 * out.
 *
 * The last failure is what reaches the caller. An earlier attempt's error is reported
 * through telemetry as it happens and then superseded.
 */
async function attemptLoop<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  trigger: Trigger,
  deps: DispatchDeps,
  ctx: AttemptContext<S, V>
): Promise<CommitResult<S, V>> {
  const { policy } = ctx;
  let previous: CommitToken | undefined;

  // Endless on purpose: every path out of the body returns or throws, and the final
  // attempt always throws. Saying that to the compiler is what keeps an unreachable
  // fallback from sitting after the loop pretending to be one.
  for (let attempt = 1; ; attempt += 1) {
    // The attempt that came before this one is now superseded. Invalidating its token is
    // what makes its eventual result harmless if it is still running.
    previous?.invalidate("superseded");
    const token = instance.issueToken(attempt);
    previous = token;

    deps.emit({
      type: "handler.started",
      key: instance.key,
      entity: instance.entity,
      state: instance.state,
      attempt,
      depth: ctx.depth,
      trigger: triggerRef(trigger),
      at: telemetryNow(),
    });

    try {
      // biome-ignore lint/performance/noAwaitInLoops: attempts are sequential by definition, and the key stays occupied for all of them
      const committed = await runAttempt(
        instance,
        definition,
        trigger,
        deps,
        ctx,
        token
      );
      ctx.settle("committed", attempt);
      return committed;
    } catch (error) {
      const failure = toError(error);

      if (attempt >= policy.maxAttempts || !policy.retryable(failure)) {
        ctx.settle("failed", attempt);
        throw failure;
      }

      const delayMs = backoffDelay(policy.backoff, attempt + 1);
      deps.emit({
        type: "handler.retried",
        key: instance.key,
        entity: instance.entity,
        state: instance.state,
        attempt,
        maxAttempts: policy.maxAttempts,
        delayMs,
        error: failure.message,
        trigger: triggerRef(trigger),
        at: telemetryNow(),
      });

      await wait(delayMs);
    }
  }
}

/**
 * One attempt: run the handler under a timeout, then commit its result through the fence.
 *
 * The result always goes through `commit`, which checks the token. That is what makes a
 * zombie harmless: a handler abandoned at its timeout still finishes, still tries to
 * commit, and is refused there rather than anywhere else.
 */
async function runAttempt<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  trigger: Trigger,
  deps: DispatchDeps,
  ctx: AttemptContext<S, V>,
  token: CommitToken
): Promise<CommitResult<S, V>> {
  const { policy, cause } = ctx;
  // A fresh controller per attempt, so a retry gets a signal that has not already fired.
  const controller = new AbortController();
  const handlerCtx: HandlerContext = Object.freeze({
    key: instance.key,
    entity: instance.entity,
    attempt: token.attempt,
    signal: controller.signal,
  });

  const settled = runHandler(instance, ctx, trigger, handlerCtx).then(
    async (result) => {
      if (result.kind === "fail") {
        return handleFailure(
          instance,
          definition,
          result.error,
          handlerCtx,
          deps,
          cause,
          token,
          trigger
        );
      }

      try {
        // `return await`, not a bare `return`. Committing is asynchronous now that it
        // persists first, so a constraint refusal arrives as a rejection: returning the
        // promise unawaited would walk straight past the catch below and skip the error
        // handler that the refusal is classified for.
        return await commit(
          instance,
          definition,
          result,
          trigger,
          deps,
          cause,
          token
        );
      } catch (error) {
        // A constraint refusal is a failure with its own classification, so it gets the
        // same chance at an error handler that a failing handler gets. A recovery commit
        // is checked too, and a recovery that violates something has nowhere further to
        // go, which is what stops this from recurring.
        if (isConstraintViolation(error)) {
          return handleFailure(
            instance,
            definition,
            error,
            handlerCtx,
            deps,
            cause,
            token,
            trigger
          );
        }
        throw error;
      }
    }
  );

  if (policy.timeoutMs === undefined) {
    return await settled;
  }

  return await underTimeout(
    settled,
    instance,
    trigger,
    deps,
    policy.timeoutMs,
    token,
    controller
  );
}

/**
 * Race an attempt against its timeout.
 *
 * On timeout the token is invalidated first, so the abandoned attempt cannot commit even
 * if it finishes microseconds later. The signal is aborted second, as a courtesy to a
 * handler that watches it. Neither can stop the function; only the fence is guaranteed.
 */
function underTimeout<S extends string, V extends Values>(
  settled: Promise<CommitResult<S, V>>,
  instance: InstanceRecord<S, V>,
  trigger: Trigger,
  deps: DispatchDeps,
  timeoutMs: number,
  token: CommitToken,
  controller: AbortController
): Promise<CommitResult<S, V>> {
  let timer: ReturnType<typeof setTimeout>;

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      token.invalidate("timeout");
      controller.abort(
        new EkmanError(
          "HANDLER_TIMEOUT",
          `handler for ${instance.key} exceeded its timeout of ${timeoutMs}ms`,
          { key: instance.key }
        )
      );

      deps.emit({
        type: "handler.timedOut",
        key: instance.key,
        entity: instance.entity,
        state: instance.state,
        attempt: token.attempt,
        timeoutMs,
        trigger: triggerRef(trigger),
        at: telemetryNow(),
      });

      reject(
        new EkmanError(
          "HANDLER_TIMEOUT",
          `handler for ${instance.key} exceeded its timeout of ${timeoutMs}ms on attempt ${token.attempt}. ` +
            "The attempt is fenced, so a late result from it cannot commit.",
          { key: instance.key }
        )
      );
    }, timeoutMs);
  });

  // The abandoned attempt is still running and will still try to commit, where the fence
  // refuses it and reports `commit.fenced`. Attaching a handler here is what keeps that
  // expected rejection from surfacing as an unhandled one; its value is of no use.
  settled.catch(ignoreFencedResult);

  return Promise.race([settled, expiry]).finally(() => clearTimeout(timer));
}

/** Invoke the handler, turning anything that is not a handler result into a failure. */
async function runHandler<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  ctx: AttemptContext<S, V>,
  trigger: Trigger,
  handlerCtx: HandlerContext
): Promise<HandlerResult<S, V>> {
  const snapshot = instance.snapshot();

  let result: HandlerResult<S, V>;
  try {
    result = await ctx.handler(snapshot, trigger, handlerCtx);
  } catch (thrown) {
    return { kind: "fail", error: toError(thrown) };
  }

  if (!isHandlerResult(result)) {
    return {
      kind: "fail",
      error: new Error(
        `handler for state "${snapshot.state}" returned ${describe(result)} ` +
          "instead of transitionTo(), stay() or fail()"
      ),
    };
  }

  return result;
}

/**
 * A failed attempt leaves the instance exactly where it was, then gives a matching error
 * handler the chance to produce a committed transition.
 */
async function handleFailure<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  error: Error,
  ctx: HandlerContext,
  deps: DispatchDeps,
  cause: EventCause,
  token: CommitToken,
  trigger: Trigger
): Promise<CommitResult<S, V>> {
  const errorHandler = resolveErrorHandler(definition, error);

  if (errorHandler !== undefined) {
    let recovery: HandlerResult<S, V>;
    try {
      recovery = await errorHandler(instance.snapshot(), error, ctx);
    } catch (thrown) {
      // An error handler that itself fails does not get another error handler. That
      // would be an unbounded chain, and the original failure is the one worth reporting.
      throw failed(instance.key, error, toError(thrown));
    }

    if (isHandlerResult(recovery)) {
      if (recovery.kind !== "fail") {
        // A recovery is a commit, so it faces the same constraints. If it violates one it
        // throws from here, and there is no second error handler to catch it.
        return commit(
          instance,
          definition,
          recovery,
          trigger,
          deps,
          cause,
          token
        );
      }
      throw failed(instance.key, error, recovery.error);
    }
  }

  throw failed(instance.key, error);
}

function failed(key: string, error: Error, from?: Error): EkmanError {
  // A constraint refusal that nothing recovered keeps its own code all the way to the
  // sender. Rewrapping it as a generic handler failure would throw away the classification
  // at exactly the boundary where a caller wants to branch on it.
  if (from === undefined && isConstraintViolation(error)) {
    return error;
  }

  const suffix =
    from === undefined ? "" : ` (error handler also failed: ${from.message})`;
  return new EkmanError("HANDLER_FAILED", `${error.message}${suffix}`, {
    key,
    cause: error,
  });
}

/**
 * Check every constraint that applies to a proposed commit, record what did not hold, and
 * refuse the result if any of it was set to `reject`.
 *
 * Violations are written to the key's stream before the commit they precede, under `warn`
 * as well as under `reject`. They are mirrored into telemetry because an operator wants to
 * alert on them; the stream is the record, telemetry is the alarm.
 */
function applyConstraints<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  deps: DispatchDeps,
  args: {
    next: ProposedCommit<S, V>;
    trigger: Trigger;
    cause: EventCause;
    transitioning: boolean;
    mutatingValues: boolean;
  }
): void {
  const compiled = definition.constraints;

  // Entity with no constraints must not pay for a snapshot of an instance nobody inspects
  if (compiled === undefined || !compiled.checksAtCommit) {
    return;
  }

  const violations = checkConstraints(compiled, {
    instance: instance.snapshot(),
    next: args.next,
    trigger: args.trigger,
    fromStateId: instance.stateId,
    transitioning: args.transitioning,
    mutatingValues: args.mutatingValues,
  });

  if (violations.length === 0) {
    return;
  }

  const attempted = { from: instance.state, to: args.next.state };

  for (const violation of violations) {
    instance.violation({
      violation,
      at: deps.now(),
      cause: args.cause,
      attempted,
    });

    deps.emit({
      type: "constraint.violated",
      key: instance.key,
      entity: instance.entity,
      state: instance.state,
      kind: violation.kind,
      constraint: violation.name,
      policy: violation.policy,
      reason: violation.reason,
      trigger: triggerRef(args.trigger),
      at: telemetryNow(),
    });
  }

  const refused = rejection(violations);
  if (refused !== undefined) {
    throw violationError(refused, instance.key);
  }
}

/**
 * Apply a transitionTo or stay result, through the fence.
 *
 * Every committed result in the runtime passes through here, which is what makes the
 * fence a single gate rather than a check somebody can forget.
 */
async function commit<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  definition: EntityDefinition<string, S, V, Trigger>,
  result: TransitionToResult<S, V> | StayResult<V>,
  trigger: Trigger,
  deps: DispatchDeps,
  cause: EventCause,
  token: CommitToken
): Promise<CommitResult<S, V>> {
  const committable = instance.committable(token);

  if (!committable) {
    deps.emit({
      type: "commit.fenced",
      key: instance.key,
      entity: instance.entity,
      attempt: token.attempt,
      reason: fenceReason(token),
      tokenSeq: token.seq,
      currentSeq: instance.seq,
      trigger: { type: cause.type, id: cause.id },
      at: telemetryNow(),
    });
  }

  const state = result.kind === "transitionTo" ? result.state : instance.state;
  // Omitted values carry the current ones forward rather than clearing them.
  const values =
    result.values === undefined
      ? instance.values
      : sealValues(result.values, instance.key);

  // Constraints are skipped for an attempt that cannot commit anyway. Recording a
  // violation for a result that was never going to land would put noise in the stream
  // about work the runtime had already abandoned.
  if (committable) {
    applyConstraints(instance, definition, deps, {
      next: { state, values },
      trigger,
      cause,
      transitioning: result.kind === "transitionTo",
      mutatingValues: result.values !== undefined,
    });
  }

  const event = await instance.commit(
    { state, values, at: deps.now(), cause },
    token
  );

  // The commit reached the authority, and then a timeout arrived. The event is durable, so
  // it stays: the sender was already told the attempt failed, and the honest thing is to
  // say the two crossed rather than to leave the store and memory disagreeing.
  if (token.racedBy !== undefined) {
    deps.emit({
      type: "commit.raced",
      key: instance.key,
      entity: instance.entity,
      attempt: token.attempt,
      reason: token.racedBy,
      seq: event.seq,
      trigger: triggerRef(trigger),
      at: telemetryNow(),
    });
  }

  return Object.freeze({
    key: instance.key,
    state: event.to,
    values: event.values,
    seq: event.seq,
    event,
  });
}

/** Record a refusal in the key's stream and reject the sender. */
function refuse<S extends string, V extends Values>(
  instance: InstanceRecord<S, V>,
  deps: DispatchDeps,
  cause: EventCause,
  code: "UNKNOWN_STATE" | "UNKNOWN_TRIGGER",
  reason: () => string
): never {
  const message = reason();
  instance.reject({ code, reason: message, at: deps.now(), cause });
  throw new EkmanError(code, message, { key: instance.key });
}

function ignoreFencedResult(): void {
  // Deliberately empty. See the call site: this exists to mark a promise as handled.
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
