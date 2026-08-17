/**
 * Audit sinks cannot gate a commit.
 *
 * Run with `npm run demo:audit`.
 *
 * The tempting design is to await the audit write. It feels safer: nothing is committed
 * until the audit trail says it was. What it actually buys is an audit outage that becomes
 * a write outage, which inverts the entire point of auditing. The system stops serving
 * customers because a warehouse in another region is unhappy.
 *
 * So a sink cannot veto a commit, cannot delay one, and cannot slow one down. Delivery is
 * at-least-once, out of band, retried a bounded number of times, and then reported.
 *
 * Three sinks below, and only one of them works. One throws every time. One accepts the
 * event and never comes back at all, which is the failure mode a timeout-free `await`
 * turns into a hung process. One is merely slow. The commits do not care about any of it.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AuditSink, EkmanEvent } from "ekman";
import { defaultLogDir, defineEntity, Ekman, transitionTo } from "ekman";

const COMMITS = 5;
const ARCHIVE_MS = 250;

const ledger = defineEntity("ledger", {
  initial: "open",
  values: { entries: 0 },
  states: {
    open: (account) =>
      transitionTo("open", { entries: account.values.entries + 1 }),
  },
});

/** Every delivery the working sink actually completed, and when. */
const archived: { seq: number; at: number }[] = [];
/** Every event the broken sink was handed, so a hang is distinguishable from a no-show. */
const handedToKafka: number[] = [];
/** Reported failures, by sink. */
const failures = new Map<string, number>();

/** Fails every time. Three attempts, then the runtime reports it and moves on. */
const warehouse: AuditSink = {
  name: "warehouse",
  deliver: () => {
    throw new Error("warehouse connection refused");
  },
};

/**
 * Accepts the event and never resolves. Not an error, just gone.
 *
 * This is the one an `await` cannot survive: there is no failure to catch and no timeout
 * to fire, so a commit path that waited here would wait forever.
 */
const kafka: AuditSink = {
  name: "kafka",
  deliver: (event: EkmanEvent) => {
    handedToKafka.push(event.seq);
    return new Promise<void>(() => {
      // Deliberately never settled.
    });
  },
};

/** Works, but slowly. The commits must not be paying for this. */
const archive: AuditSink = {
  name: "s3-archive",
  deliver: async (event: EkmanEvent) => {
    await delay(ARCHIVE_MS);
    archived.push({ seq: event.seq, at: Date.now() });
  },
};

// A named directory rather than a temporary one, cleared on the way in rather than out, so
// the log this demo wrote is still there to read when it finishes. Its own subdirectory, so
// clearing it can never reach anything another demo or the example app put there.
const dir = join(defaultLogDir(), "demos", "audit");
rmSync(dir, { recursive: true, force: true });

async function main(): Promise<void> {
  console.log(`store: ${dir}\n`);
  const ekman = new Ekman({
    entities: [ledger],
    store: { kind: "file", dir },
    audit: [warehouse, kafka, archive],
    telemetry: {
      "audit.failed": (event) => {
        failures.set(event.sink, (failures.get(event.sink) ?? 0) + 1);
      },
    },
  });

  banner("Committing with one broken sink, one hung sink, and one slow sink");

  const started = Date.now();
  const latencies: number[] = [];

  for (let i = 0; i < COMMITS; i += 1) {
    const at = Date.now();
    // biome-ignore lint/performance/noAwaitInLoops: the point is what each individual commit costs, which a batch would hide
    const result = await ekman.entities.ledger.send("a1", { type: "entry" });
    const took = Date.now() - at;
    latencies.push(took);
    console.log(
      `  commit ${i + 1}  seq=${result.seq}  entries=${result.values.entries}  ${took}ms`
    );
  }

  const committedBy = Date.now();
  const slowest = Math.max(...latencies);

  console.log(
    `\n  ${COMMITS} commits in ${committedBy - started}ms, slowest ${slowest}ms\n` +
      `  the slow sink takes ${ARCHIVE_MS}ms per event and had delivered ${archived.length} of them by now`
  );

  // Every commit finished before the slow sink completed even one delivery. A commit path
  // that waited on its sinks could not produce this ordering.
  check(
    archived.length === 0,
    `the commits waited for the slow sink: ${archived.length} deliveries already done`
  );
  check(
    slowest < ARCHIVE_MS,
    `a single commit took ${slowest}ms, which is as slow as the sink it should not be waiting for`
  );

  banner("What the sinks did with those events");

  // Commit 1 also emits the initialization event, so there is one more event than commit.
  const events = COMMITS + 1;

  await waitFor(() => (failures.get("warehouse") ?? 0) >= events, 2000);
  console.log(
    `  warehouse   ${failures.get("warehouse") ?? 0} failures reported, after 3 attempts each`
  );
  console.log(
    `  kafka       ${handedToKafka.length} events accepted, 0 completed, 0 failures reported`
  );
  console.log(`  s3-archive  ${archived.length} delivered so far`);

  check(
    failures.get("warehouse") === events,
    `expected ${events} reported failures from the warehouse, got ${failures.get("warehouse")}`
  );
  check(
    handedToKafka.length === events,
    `kafka was handed ${handedToKafka.length} events, expected ${events}`
  );
  // A hang is not a failure, and the runtime does not invent one. It is still waiting,
  // and it will still be waiting when the process exits.
  check(
    failures.get("kafka") === undefined,
    "a hung sink was reported as failed, which it is not"
  );

  console.log(
    "\n  The hung sink reported nothing, because nothing failed. It is still holding its\n" +
      "  promise. That distinction matters: `audit.failed` means delivery was attempted\n" +
      "  and refused, not that a sink is unhealthy, and a sink that never answers needs a\n" +
      "  liveness check rather than an error count."
  );

  banner("And the thing that was actually being audited");

  const {
    events: stream,
    complete,
    sources,
  } = await ekman.entities.ledger.history("a1");
  console.log(
    `  ${stream.length} events on disk, complete=${complete}, from [${sources.join(", ")}]`
  );

  check(
    stream.length === events,
    `the stream lost events: ${stream.length} of ${events}`
  );
  check(complete, "the history is not complete");

  const final = ekman.entities.ledger.inspect("a1");
  check(
    final?.values.entries === COMMITS,
    `the instance did not record every commit: ${final?.values.entries}`
  );

  console.log(
    "\n  Every commit landed and the durable stream is whole, with two of three sinks\n" +
      "  broken throughout. The audit trail is a copy of the truth, not a gate in front\n" +
      "  of it, and this is what that distinction is worth on the day a sink goes down."
  );

  // Waiting for the slow sink here only to show it does eventually arrive, which is what
  // at-least-once means once the pressure is off the commit path.
  await waitFor(() => archived.length === events, ARCHIVE_MS * 4);
  console.log(
    `  (a moment later, s3-archive has caught up: ${archived.length} of ${events} delivered)`
  );

  console.log(
    `\n${"=".repeat(78)}\n` +
      "A sink can fail, hang, or lag, and the only thing that changes is what telemetry\n" +
      "says about the sink. An audit outage must never become a write outage.\n"
  );

  await ekman.close();
}

/** Poll until a condition holds, or give up. Used instead of a fixed sleep. */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by definition
    await delay(5);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function banner(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
