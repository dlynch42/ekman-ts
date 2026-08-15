import { describe, expect, it, vi } from "vitest";
import type { RuntimeDeps } from "../src/config";
import { resolveInboxConfig } from "../src/config";
import type { EkmanError } from "../src/errors";
import { Inbox } from "../src/inbox";
import type { TelemetryEvent } from "../src/telemetry";
import type { CommitResult, InboxConfig, Trigger } from "../src/types";

/** Enough of a commit result to settle a caller. Dispatch is not under test here. */
const committed = (seq: number) =>
  ({ key: "orders:1", state: "a", values: {}, seq }) as unknown as CommitResult;

const trigger = (id: string): Trigger => ({ type: "go", id });

function make(config?: InboxConfig) {
  const telemetry: TelemetryEvent[] = [];
  const recorded: { code: string; reason: string }[] = [];
  const onUnhandled = vi.fn();

  const deps: RuntimeDeps = {
    now: () => 1000,
    telemetry: { "*": (event) => telemetry.push(event) },
    onUnhandled,
    inbox: resolveInboxConfig(config),
  };

  const inbox = new Inbox({
    key: "orders:1",
    entity: "orders",
    deps,
    record: (refusal) =>
      recorded.push({ code: refusal.code, reason: refusal.reason }),
  });

  return { inbox, telemetry, recorded, onUnhandled };
}

/** A runner that does not finish until it is released. */
function gate() {
  let release: (seq: number) => void = () => undefined;
  const started: string[] = [];

  const run = (t: Trigger) => {
    started.push(t.id as string);
    return new Promise<CommitResult>((resolve) => {
      release = (seq) => resolve(committed(seq));
    });
  };

  return { run, started, release: (seq = 1) => release(seq) };
}

const code = async (settled: Promise<unknown>) => {
  try {
    await settled;
    return "committed";
  } catch (error) {
    return (error as EkmanError).code;
  }
};

describe("Inbox", () => {
  it("runs the first trigger immediately and reports itself busy", async () => {
    const { inbox } = make();
    const held = gate();

    expect(inbox.idle).toBe(true);
    const settled = inbox.enqueue(trigger("t1"), held.run);

    expect(inbox.busy).toBe(true);
    expect(inbox.depth).toBe(0);
    expect(inbox.idle).toBe(false);

    held.release();
    await settled;
    expect(inbox.idle).toBe(true);
  });

  it("queues behind an active handler instead of running concurrently", async () => {
    const { inbox } = make({ capacity: 4 });
    const held = gate();

    const first = inbox.enqueue(trigger("t1"), held.run);
    inbox.enqueue(trigger("t2"), held.run);

    expect(held.started).toEqual(["t1"]);
    expect(inbox.depth).toBe(1);

    held.release();
    await first;
  });

  it("admits a trigger that can start immediately even at capacity zero", async () => {
    // The one in flight has left the queue, so it is not measured against a limit on
    // waiting. Otherwise `capacity: 0` would refuse everything, including the first.
    const { inbox } = make({ capacity: 0 });
    const held = gate();

    const settled = inbox.enqueue(trigger("t1"), held.run);
    expect(held.started).toEqual(["t1"]);

    held.release();
    await expect(settled).resolves.toMatchObject({ seq: 1 });
  });

  it("rejects an arriving trigger when full, leaving the queue intact", async () => {
    const { inbox, telemetry } = make({ capacity: 1, overflow: "reject" });
    const held = gate();

    const first = inbox.enqueue(trigger("t1"), held.run);
    const queued = inbox.enqueue(trigger("t2"), held.run);
    const refused = inbox.enqueue(trigger("t3"), held.run);

    expect(await code(refused)).toBe("INBOX_OVERFLOW");
    expect(inbox.depth).toBe(1);
    expect(telemetry.filter((e) => e.type === "inbox.rejected")).toHaveLength(
      1
    );

    held.release();
    await first;
    held.release(2);
    await queued;
  });

  it("drop-newest refuses the arriving trigger", async () => {
    const { inbox, telemetry } = make({
      capacity: 1,
      overflow: "drop-newest",
    });
    const held = gate();

    inbox.enqueue(trigger("t1"), held.run);
    inbox.enqueue(trigger("t2"), held.run);
    const refused = inbox.enqueue(trigger("t3"), held.run);

    expect(await code(refused)).toBe("TRIGGER_DROPPED");
    expect(telemetry.find((e) => e.type === "inbox.dropped")).toMatchObject({
      dropped: "newest",
      trigger: { id: "t3" },
    });
  });

  it("drop-oldest refuses the longest-waiting trigger and admits the newcomer", async () => {
    const { inbox, telemetry } = make({
      capacity: 1,
      overflow: "drop-oldest",
    });
    const held = gate();

    const first = inbox.enqueue(trigger("t1"), held.run);
    const evicted = inbox.enqueue(trigger("t2"), held.run);
    inbox.enqueue(trigger("t3"), held.run);

    expect(await code(evicted)).toBe("TRIGGER_DROPPED");
    expect(inbox.depth).toBe(1);
    expect(telemetry.find((e) => e.type === "inbox.dropped")).toMatchObject({
      dropped: "oldest",
      depth: 1,
      trigger: { id: "t2" },
    });

    held.release();
    await first;
    expect(held.started).toEqual(["t1", "t3"]);
  });

  it("drop-oldest with nothing waiting has only the newcomer to drop", async () => {
    const { inbox, telemetry } = make({
      capacity: 0,
      overflow: "drop-oldest",
    });
    const held = gate();

    inbox.enqueue(trigger("t1"), held.run);
    const refused = inbox.enqueue(trigger("t2"), held.run);

    expect(await code(refused)).toBe("TRIGGER_DROPPED");
    expect(telemetry.find((e) => e.type === "inbox.dropped")).toMatchObject({
      dropped: "newest",
      trigger: { id: "t2" },
    });
  });

  it("records an overflow in the key's stream only when asked to", async () => {
    const overflowOnce = async (config: InboxConfig) => {
      const harness = make(config);
      const held = gate();
      harness.inbox.enqueue(trigger("t1"), held.run);
      await code(harness.inbox.enqueue(trigger("t2"), held.run));
      return harness.recorded;
    };

    const [off, on] = await Promise.all([
      overflowOnce({ capacity: 0 }),
      overflowOnce({ capacity: 0, recordOverflow: true }),
    ]);

    // Off by default: an overload storm must not grow the per-key stream.
    expect(off).toEqual([]);
    expect(on).toHaveLength(1);
    expect(on[0]?.code).toBe("INBOX_OVERFLOW");
  });

  it("keeps draining after a trigger fails, so one failure cannot poison the queue", async () => {
    const { inbox } = make({ capacity: 4 });
    const boom = new Error("handler blew up");

    const failing = inbox.enqueue(trigger("t1"), () => Promise.reject(boom));
    const following = inbox.enqueue(trigger("t2"), () =>
      Promise.resolve(committed(1))
    );

    await expect(failing).rejects.toThrow(boom);
    await expect(following).resolves.toMatchObject({ seq: 1 });
    expect(inbox.idle).toBe(true);
  });

  it("reports the depth still waiting behind the trigger it starts", async () => {
    const { inbox } = make({ capacity: 4 });
    const depths: number[] = [];
    const run = (_t: Trigger, depth: number) => {
      depths.push(depth);
      return Promise.resolve(committed(1));
    };

    inbox.enqueue(trigger("t1"), run);
    inbox.enqueue(trigger("t2"), run);
    const last = inbox.enqueue(trigger("t3"), run);
    await last;

    // The first is dispatched synchronously, before the other two are even enqueued, so
    // it sees an empty queue. The second then sees the third waiting behind it.
    expect(depths).toEqual([0, 1, 0]);
  });

  it("goes idle after the queue drains, so a later trigger starts a fresh drain", async () => {
    const { inbox } = make();

    await inbox.enqueue(trigger("t1"), () => Promise.resolve(committed(1)));
    expect(inbox.idle).toBe(true);

    await expect(
      inbox.enqueue(trigger("t2"), () => Promise.resolve(committed(2)))
    ).resolves.toMatchObject({ seq: 2 });
  });
});
