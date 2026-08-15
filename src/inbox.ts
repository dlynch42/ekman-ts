import type { ResolvedInboxConfig, RuntimeDeps } from "./config";
import type { ErrorCode } from "./errors";
import { EkmanError } from "./errors";
import type { EventCause } from "./events";
import type { TelemetryEvent } from "./telemetry";
import { emit, telemetryNow, triggerRef } from "./telemetry";
import type { CommitResult, Trigger } from "./types";

/**
 * Runs one trigger to completion. Supplied per entry by the runtime, which is the only
 * layer that knows about entity definitions and dispatch.
 *
 * `depth` is what is still queued behind this trigger when it starts.
 */
export type Runner = (trigger: Trigger, depth: number) => Promise<CommitResult>;

interface Entry {
  readonly trigger: Trigger;
  readonly run: Runner;
  readonly resolve: (result: CommitResult) => void;
  readonly reject: (error: unknown) => void;
}

/** Called when an overflow should also be written to the key's event stream. */
export type OverflowRecorder = (args: {
  code: ErrorCode;
  reason: string;
  at: number;
  cause: EventCause;
}) => void;

/**
 * One instance's bounded FIFO inbox.
 *
 * Phase 1 serialized with a promise chain, which was enough to keep one handler per key
 * but offered no handle on a queued trigger. `drop-oldest` needs exactly that handle, so
 * the chain is now an explicit queue with a drain loop over it.
 *
 * The queue holds triggers that are *waiting*. The one being handled has already been
 * shifted off, so capacity bounds the backlog and not the backlog plus the work.
 *
 * Capacity is counted in triggers. Nothing here weighs anything; the memory budget is a
 * separate concern with separate units.
 */
export class Inbox {
  readonly #queue: Entry[] = [];
  readonly #key: string;
  readonly #entity: string;
  readonly #deps: RuntimeDeps;
  readonly #record: OverflowRecorder;
  /**
   * Declared here and assigned in the constructor, rather than initialized inline. An
   * inline `= false` narrows the field to the literal `false`, after which every guard
   * that reads it looks statically dead.
   */
  #running: boolean;

  readonly #onIdle: () => void;

  constructor(args: {
    key: string;
    entity: string;
    deps: RuntimeDeps;
    record: OverflowRecorder;
    /** Called when the queue empties, which is the first moment eviction may act. */
    onIdle: () => void;
  }) {
    this.#key = args.key;
    this.#entity = args.entity;
    this.#deps = args.deps;
    this.#record = args.record;
    this.#onIdle = args.onIdle;
    this.#running = false;
  }

  get #config(): ResolvedInboxConfig {
    return this.#deps.inbox;
  }

  /** Triggers waiting, not counting one being handled. */
  get depth(): number {
    return this.#queue.length;
  }

  /** Whether a handler is running for this key right now. */
  get busy(): boolean {
    return this.#running;
  }

  /** Nothing running and nothing waiting. What eviction is allowed to touch. */
  get idle(): boolean {
    return !(this.#running || this.#queue.length > 0);
  }

  /**
   * Accept a trigger, or apply the overflow policy.
   *
   * Runs synchronously from `send()`, which is what makes FIFO order the same as call
   * order. Nothing may be awaited between a caller's `send()` and the push here.
   */
  enqueue(trigger: Trigger, run: Runner): Promise<CommitResult> {
    // A trigger that can start immediately never waits, so it is not measured against a
    // limit on waiting. This is what makes `capacity: 0` mean "one at a time, no
    // backlog" rather than "refuse everything".
    if (this.idle || this.#queue.length < this.#config.capacity) {
      return this.#accept(trigger, run);
    }
    return this.#overflow(trigger, run);
  }

  #accept(trigger: Trigger, run: Runner): Promise<CommitResult> {
    // The executor runs synchronously, so the push lands before this returns.
    const settled = new Promise<CommitResult>((resolve, reject) => {
      this.#queue.push({ trigger, run, resolve, reject });
    });

    this.#emit({
      type: "inbox.enqueued",
      key: this.#key,
      entity: this.#entity,
      depth: this.#queue.length,
      capacity: this.#config.capacity,
      trigger: triggerRef(trigger),
      at: telemetryNow(),
    });

    // Starting the drain here, synchronously, is what lets a trigger arriving at an idle
    // inbox go straight to its handler without ever counting as waiting.
    if (!this.#running) {
      this.#running = true;
      // The drain settles each entry's own promise, so nothing awaits it here. If the
      // loop itself ever breaks there is no caller to receive that, and it goes where
      // every other uncaught runtime failure does rather than becoming a bare rejection.
      this.#drain().catch(this.#deps.onUnhandled);
    }

    return settled;
  }

  /**
   * The inbox is full. Every policy refuses exactly one trigger and tells its sender;
   * none of them silently discards.
   */
  #overflow(trigger: Trigger, run: Runner): Promise<CommitResult> {
    const { overflow, capacity } = this.#config;

    if (overflow === "reject") {
      return Promise.reject(
        this.#refuse(trigger, "INBOX_OVERFLOW", {
          type: "inbox.rejected",
          key: this.#key,
          entity: this.#entity,
          depth: this.#queue.length,
          capacity,
          overflow,
          trigger: triggerRef(trigger),
          at: telemetryNow(),
        })
      );
    }

    // `drop-oldest` with a capacity of 0 has no older trigger to drop: the backlog is
    // empty and the one in flight is not a queue member. The arriving trigger is the
    // only thing that can go.
    const oldest = overflow === "drop-oldest" ? this.#queue.shift() : undefined;

    if (oldest === undefined) {
      return Promise.reject(
        this.#refuse(trigger, "TRIGGER_DROPPED", {
          type: "inbox.dropped",
          key: this.#key,
          entity: this.#entity,
          dropped: "newest",
          depth: this.#queue.length,
          capacity,
          overflow,
          trigger: triggerRef(trigger),
          at: telemetryNow(),
        })
      );
    }

    oldest.reject(
      this.#refuse(oldest.trigger, "TRIGGER_DROPPED", {
        type: "inbox.dropped",
        key: this.#key,
        entity: this.#entity,
        dropped: "oldest",
        // Reported before the newcomer takes the freed slot, so it reads as the depth
        // that was full rather than the depth after the swap.
        depth: this.#queue.length + 1,
        capacity,
        overflow,
        trigger: triggerRef(oldest.trigger),
        at: telemetryNow(),
      })
    );

    return this.#accept(trigger, run);
  }

  /** Emit the telemetry, optionally record the refusal, and build the sender's error. */
  #refuse(
    trigger: Trigger,
    code: "INBOX_OVERFLOW" | "TRIGGER_DROPPED",
    event: TelemetryEvent
  ): EkmanError {
    this.#emit(event);

    const { capacity, overflow } = this.#config;
    const full = `the inbox for ${this.#key} is full at its capacity of ${capacity} waiting triggers`;
    const reason =
      code === "INBOX_OVERFLOW"
        ? `${full}, and the overflow policy is "${overflow}"`
        : `trigger "${trigger.type}" was dropped because ${full}, under the "${overflow}" overflow policy`;

    if (this.#config.recordOverflow) {
      this.#record({
        code,
        reason,
        at: this.#deps.now(),
        cause: { type: trigger.type, id: trigger.id as string },
      });
    }

    return new EkmanError(code, reason, { key: this.#key });
  }

  #emit(event: TelemetryEvent): void {
    emit(this.#deps.telemetry, event, this.#deps.onUnhandled);
  }

  /**
   * Run queued triggers one at a time until the queue empties.
   *
   * A loop rather than recursion, so a deep backlog cannot grow the stack. `#running`
   * is cleared with no await between the final shift and the assignment, so nothing can
   * observe an empty-but-still-running inbox and decline to start its own drain.
   *
   * Only ever started from `#accept`, immediately after a push, so the first shift
   * always finds something.
   */
  async #drain(): Promise<void> {
    let entry: Entry | undefined = this.#queue.shift();

    while (entry !== undefined) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one handler at a time per key is the guarantee this loop exists to provide
        entry.resolve(await entry.run(entry.trigger, this.#queue.length));
      } catch (error) {
        entry.reject(error);
      }
      entry = this.#queue.shift();
    }

    this.#running = false;
    // The key is idle only now. Eviction is allowed to touch it from here and not before,
    // which is why the budget acts here rather than at the commit that blew it.
    this.#onIdle();
  }
}
