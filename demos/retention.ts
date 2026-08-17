/**
 * Retention: a log that does not grow forever, and a delete you have to ask for.
 *
 * Run with `npm run demo:retention`.
 *
 * `demo:memory-bound` is about RAM. This is the other axis: bytes on disk, which nothing
 * about a memory budget bounds. A thousand instances inside a 64 KB budget still write a
 * thousand logs, and those logs outlive every eviction.
 *
 * Three separate limits, and conflating them is how a service fills a disk while every
 * dashboard says it is healthy:
 *
 *   bytes in one instance's log   compaction, on by default at 5MB
 *   bytes across the whole store  a budget, measured always and enforced only if you ask
 *   instances accumulating        retention, which is `query` plus `forget`
 *
 * The first is automatic because it costs history and never state. The third is never
 * automatic, because it destroys committed state and that is not a default anything should
 * pick for you.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  defaultLogDir,
  defineEntity,
  Ekman,
  isEkmanError,
  stay,
  transitionTo,
} from "ekman";
import { banner, check, gauge, row } from "./lib";

const DAY = 24 * 60 * 60 * 1000;

const tickets = defineEntity("tickets", {
  initial: "open",
  values: { note: "" },
  states: {
    open: (ticket, trigger) =>
      trigger.type === "close"
        ? transitionTo("closed", ticket.values)
        : // Each update carries a payload, so the log grows at a readable rate.
          stay({ note: "x".repeat(200) }),
    closed: (ticket) => stay(ticket.values),
  },
});

// A named directory rather than a temporary one, cleared on the way in rather than out, so
// the log this demo wrote is still there to read when it finishes. Its own subdirectory, so
// clearing it can never reach anything another demo or the example app put there.
const dir = join(defaultLogDir(), "demos", "retention");
rmSync(dir, { recursive: true, force: true });

/** A clock the demo drives, so "older than 30 days" is a thing that can actually happen. */
let clock = Date.UTC(2026, 0, 1);
const now = () => clock;

async function main(): Promise<void> {
  console.log(`store: ${dir}\n`);
  await aLogThatCompacts();
  await theBudget();
  await aBudgetThatReclaims();
  await retention();
  await forgettingIsRefusedWhileBusy();

  console.log(
    `\n${"=".repeat(78)}\n` +
      "Compaction is on by default because it only ever costs history, and history says\n" +
      "so when it is incomplete. The budget defaults to measuring rather than enforcing,\n" +
      "because nobody can pick a byte ceiling for somebody else's workload. Deleting is\n" +
      "not a default at all: it is the one operation here that destroys what a caller was\n" +
      "already told had committed.\n"
  );
}

const COMMITS = 400;
/** Sampled often enough to see the sawtooth, rarely enough to fit on a screen. */
const EVERY = 25;
const BAR = 40;

/** One instance, many commits, watched on disk with the cap on and off. */
async function aLogThatCompacts(): Promise<void> {
  banner(`1. One key, ${COMMITS} commits, bytes on disk as they land`);

  console.log(
    "  Each run's bars are scaled to its own peak, so the shape is readable in both.\n" +
      "  The magnitudes are the numbers beside them, and they are not close.\n"
  );

  const uncapped = await growing("uncapped", 0);
  console.log("");
  const capped = await growing("capped", 2048);

  console.log(
    `\n  uncapped        ${uncapped.bytes.toLocaleString()} bytes, ${uncapped.events} events, history complete: ${uncapped.complete}`
  );
  console.log(
    `  capped at 2 KB  ${capped.bytes.toLocaleString()} bytes, ${capped.events} events, history complete: ${capped.complete}`
  );
  console.log(
    `  both            seq=${capped.seq}, same values, ${Math.round(uncapped.bytes / capped.bytes)}x apart on disk`
  );

  check(
    uncapped.seq === capped.seq,
    "the two runs did not commit the same number of times"
  );
  check(capped.bytes < uncapped.bytes / 2, "the cap did not bound anything");
  check(
    uncapped.complete === true,
    "an uncompacted history reported itself partial"
  );
  check(
    capped.complete === false,
    "a compacted history claimed to be complete"
  );

  console.log(
    "\n  Same sequence, same values, and one of them stops growing. The sawtooth is the\n" +
      "  log being folded into a snapshot and starting again: what it spends is history,\n" +
      "  which is why the capped run says `complete: false` rather than quietly passing a\n" +
      "  shorter answer off as a whole one."
  );

  // A second runtime over the same directory, to show compaction is not a resident trick.
  const reopened = new Ekman({
    entities: [tickets],
    store: { kind: "file", dir: join(dir, "capped") },
    now,
  });
  const restored = await reopened.entities.tickets.send("t1", {
    type: "update",
  });
  console.log(
    `\n  reopened from disk: seq=${restored.seq}, continuing rather than restarting`
  );
  check(
    restored.seq === COMMITS + 1,
    `the sequence restarted after a reopen: ${restored.seq}`
  );
  await reopened.close();
}

interface Growth {
  bytes: number;
  events: number;
  complete: boolean;
  seq: number;
}

/** Commit repeatedly against one key, printing what the store holds as it goes. */
async function growing(name: string, perLogBytes: number): Promise<Growth> {
  const ekman = new Ekman({
    entities: [tickets],
    // 2 KB rather than the 5 MB default, so this finishes in a demo rather than an hour.
    store: { kind: "file", dir: join(dir, name), retention: { perLogBytes } },
    now,
  });

  console.log(
    `  ${name}${perLogBytes === 0 ? ", no per-log cap" : `, folded once a log passes ${perLogBytes} bytes`}\n`
  );

  const samples: number[] = [];
  for (let i = 1; i <= COMMITS; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each commit has to land before the next
    await ekman.entities.tickets.send("t1", { type: "update" });
    if (i % EVERY === 0) {
      samples.push(ekman.storageUsage.bytes);
    }
  }

  // Scaled against the largest reading of this run, so the shape is visible whether the
  // line climbs forever or keeps being cut back down.
  const widest = Math.max(...samples);
  samples.forEach((sampled, i) => {
    const filled = Math.max(1, Math.round((sampled / widest) * BAR));
    console.log(
      `    ${String((i + 1) * EVERY).padStart(4)} commits  ${"█".repeat(filled).padEnd(BAR, " ")}  ${sampled.toLocaleString().padStart(7)} bytes`
    );
  });

  const current = ekman.entities.tickets.inspect("t1");
  const { events, complete } = await ekman.entities.tickets.history("t1");
  const { bytes } = ekman.storageUsage;
  await ekman.close();

  return { bytes, events: events.length, complete, seq: current?.seq ?? -1 };
}

/** What the store is holding, and what happens when it is told to hold no more. */
async function theBudget(): Promise<void> {
  banner("2. A budget that measures before it enforces");

  const measured = new Ekman({
    entities: [tickets],
    store: { kind: "file", dir: join(dir, "measured") },
    now,
  });
  for (const id of ["a", "b", "c"]) {
    // biome-ignore lint/performance/noAwaitInLoops: keeps the printed byte count stable
    await measured.entities.tickets.send(id, { type: "update" });
  }

  const usage = measured.storageUsage;
  row("bytes", usage.bytes);
  row("logs", usage.logs);
  row("ceiling", usage.maxBytes === null ? "none configured" : usage.maxBytes);
  console.log(
    "\n  No ceiling configured, and the number is still there. That is the point: you\n" +
      "  cannot choose a limit for a workload you have never measured, and a runtime that\n" +
      "  only counts once you enforce leaves you choosing blind."
  );
  await measured.close();

  const bounded = new Ekman({
    entities: [tickets],
    store: {
      kind: "file",
      dir: join(dir, "bounded"),
      retention: { totalBytes: 900, policy: "reject", perLogBytes: 0 },
    },
    now,
  });

  await bounded.entities.tickets.send("first", { type: "update" });
  await bounded.entities.tickets.send("first", { type: "update" });

  // The instance that already exists is not affected by the store being full.
  const stillCommitting = await bounded.entities.tickets.send("first", {
    type: "update",
  });
  const refused = await caught(
    bounded.entities.tickets.send("second", { type: "update" })
  );

  console.log("");
  row("budget", `${bounded.storageUsage.maxBytes?.toLocaleString()} bytes`);
  row(
    "holding",
    `${bounded.storageUsage.bytes.toLocaleString()} bytes`,
    "past it, and still committing"
  );
  row(
    "an existing instance",
    `seq ${stillCommitting.seq}`,
    "kept committing, unaffected"
  );
  row(
    "a new instance",
    isEkmanError(refused) ? refused.code : "was accepted",
    "refused before anything was written"
  );

  check(
    isEkmanError(refused) && refused.code === "STORE_FULL",
    `a new instance was not refused with STORE_FULL: ${String(refused)}`
  );

  console.log(
    "\n  Note that it is holding more than its ceiling, on purpose. Shedding new work is\n" +
      "  recoverable and stopping work already in flight is not, so `reject` refuses the\n" +
      "  instance that does not exist yet and lets the ones that do carry on past the line.\n" +
      "  The alternative default, deleting something to make room, would answer a\n" +
      "  disk-space question by destroying data nobody agreed to lose."
  );
  await bounded.close();
}

/** The other thing a full store can do: give bytes back instead of turning work away. */
async function aBudgetThatReclaims(): Promise<void> {
  banner("3. A budget that reclaims instead of refusing");

  const BUDGET = 20_000;
  const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);

  const ekman = new Ekman({
    entities: [tickets],
    store: {
      kind: "file",
      dir: join(dir, "reclaiming"),
      // Per-log compaction off, so nothing happens on the commit path and the budget is
      // the only thing that can act.
      retention: { perLogBytes: 0, totalBytes: BUDGET, policy: "compact" },
    },
    now,
  });

  // Written until well past the ceiling, sampled on the way, so the budget being blown
  // through is as visible as it being reclaimed.
  console.log(`  budget ${BUDGET.toLocaleString()} bytes, filling past it\n`);
  for (let round = 1; round <= 6; round += 1) {
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: each commit has to land before the next
      await ekman.entities.tickets.send(id, { type: "update" });
    }
    const { bytes } = ekman.storageUsage;
    console.log(
      `    round ${round}  ${gauge(bytes, BUDGET)}  ${bytes.toLocaleString().padStart(7)} bytes${bytes > BUDGET ? "  over" : ""}`
    );
  }

  const before = ekman.storageUsage;

  // Nothing above did this. A sweep has to walk every key to choose what to fold, and
  // that is not something to do while a caller waits on an append.
  const swept = await ekman.sweepStorage();
  const after = ekman.storageUsage;
  console.log(
    `    swept    ${gauge(after.bytes, BUDGET)}  ${after.bytes.toLocaleString().padStart(7)} bytes`
  );

  console.log("");
  console.log(
    `  reclaimed         ${swept.reclaimed.toLocaleString()} bytes from ${swept.logs} of ${before.logs} logs`
  );
  console.log(
    `  over budget still ${swept.overBudget.length === 0 ? "nothing" : swept.overBudget.join(", ")}`
  );

  let folded = 0;
  let intact = 0;
  for (const id of ids) {
    const current = ekman.entities.tickets.inspect(id);
    // biome-ignore lint/performance/noAwaitInLoops: one at a time keeps failures attributable
    const { complete } = await ekman.entities.tickets.history(id);
    if (complete) {
      intact += 1;
    } else {
      folded += 1;
    }
    check(
      current?.seq === 6,
      `${id} lost its sequence to the sweep: ${current?.seq}`
    );
  }

  console.log(
    `  history                 ${folded} folded, ${intact} untouched, every one still at seq 6`
  );

  check(after.bytes < before.bytes, "the sweep gave nothing back");
  check(
    after.bytes <= BUDGET,
    `the sweep left ${after.bytes} bytes over a ${BUDGET} budget`
  );
  check(swept.overBudget.length === 0, "the sweep could not reach the budget");
  check(
    folded === swept.logs,
    `${swept.logs} logs folded but ${folded} say so`
  );
  check(
    intact > 0,
    "the sweep folded every log rather than only as many as it needed"
  );

  console.log(
    "\n  The same trade compaction always makes, moved from one log to the whole store:\n" +
      "  history is spent, state is not. Every ticket is still at seq 6 with its values,\n" +
      "  including the ones whose stream is now empty, because everything folded away was\n" +
      "  already in the snapshot.\n" +
      "\n" +
      `  Only ${folded} of ${ids.length} logs were touched. The sweep takes the largest first and stops\n` +
      "  the moment it is back under, because spending history it did not need to spend\n" +
      "  would be the same mistake as deleting an instance to answer a disk-space\n" +
      "  question, in miniature.\n" +
      "\n" +
      "  It also has a floor. Folding a log writes a snapshot beside it, and a store whose\n" +
      "  logs are already bare snapshots has nothing left to give. A sweep that reaches\n" +
      "  that point names the layers it could not bring under, rather than sweeping again\n" +
      "  and reporting a success it did not have.\n" +
      "\n" +
      "  `sweepStorage()` above is the whole mechanism. A service that would rather not call\n" +
      "  it adds `storage: { sweepMs }` and gets the same pass on an interval, which reports\n" +
      "  itself through the `storage.swept` telemetry event because nobody is holding its\n" +
      "  return value. An interval on layers that cannot compact is refused at startup."
  );
  await ekman.close();
}

/** The sweep: a query you already have, plus the one verb that deletes. */
async function retention(): Promise<void> {
  banner("4. Retention: a query you already have, plus one verb");

  const ekman = new Ekman({
    entities: [tickets],
    store: { kind: "file", dir: join(dir, "retention") },
    now,
  });

  // A fleet with a mix: most closed long ago, some closed recently, some still open.
  const settled = Array.from({ length: 40 }, (_, i) => `done-${i}`);
  const lively = Array.from({ length: 10 }, (_, i) => `open-${i}`);

  for (const id of [...settled, ...lively]) {
    // biome-ignore lint/performance/noAwaitInLoops: each has to land before the clock moves
    await ekman.entities.tickets.send(id, { type: "update" });
  }
  for (const id of settled) {
    // biome-ignore lint/performance/noAwaitInLoops: same
    await ekman.entities.tickets.send(id, { type: "close" });
  }

  // Forty days pass. The closed ones are now genuinely old; the open ones are not old
  // at all, they have simply been open the whole time.
  clock += 40 * DAY;

  // Five more get closed today, so "closed" alone is not a safe thing to delete on.
  const recent = lively.slice(0, 5);
  for (const id of recent) {
    // biome-ignore lint/performance/noAwaitInLoops: same
    await ekman.entities.tickets.send(id, { type: "close" });
  }

  const before = ekman.storageUsage;
  const { instances, complete } = await ekman.entities.tickets.query({
    state: "closed",
    olderThan: "30d",
  });

  row("logs held", before.logs);
  row("closed", settled.length + recent.length);
  row("closed over 30d ago", instances.length, "what the query answers");
  row("answer complete", String(complete));

  // Nothing here is automatic. The query is the policy, and it is application code.
  const started = Date.now();
  for (const match of instances) {
    // biome-ignore lint/performance/noAwaitInLoops: a sweep is not a race worth winning
    await ekman.forget(match.key);
  }
  const elapsed = Date.now() - started;

  const after = ekman.storageUsage;
  console.log("");
  row(
    "before",
    `${before.bytes.toLocaleString()} bytes`,
    `${before.logs} logs`
  );
  row("after", `${after.bytes.toLocaleString()} bytes`, `${after.logs} logs`);
  row(
    "reclaimed",
    `${(before.bytes - after.bytes).toLocaleString()} bytes`,
    `${instances.length} instances in ${elapsed}ms`
  );

  check(
    instances.length === settled.length,
    `expected the ${settled.length} old tickets, found ${instances.length}`
  );
  check(
    after.logs === before.logs - settled.length,
    "forgetting did not give the budget its bytes back"
  );
  for (const id of [...recent, ...lively.slice(5)]) {
    check(
      ekman.entities.tickets.inspect(id) !== undefined,
      `${id} was deleted despite not matching the query`
    );
  }

  const revived = await ekman.entities.tickets.send("old-1", {
    type: "update",
  });
  console.log(
    `\n  sending to a forgotten key again: state=${revived.state} seq=${revived.seq}`
  );
  check(
    revived.state === "open",
    `a forgotten instance came back in state ${revived.state}`
  );

  console.log(
    "\n  A budget that only ever rises would report itself full while holding almost\n" +
      "  nothing, so forgetting gives the bytes back. And the key is genuinely gone: the\n" +
      "  same id addresses a new instance at the initial state, not a resurrected one."
  );
  await ekman.close();
}

/** The refusal that keeps a delete from racing a commit. */
async function forgettingIsRefusedWhileBusy(): Promise<void> {
  banner("5. Forgetting is refused while a handler is in flight");

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const slow = defineEntity("slow", {
    initial: "working",
    states: {
      working: async (instance) => {
        await held;
        return stay(instance.values);
      },
    },
  });

  const ekman = new Ekman({
    entities: [slow],
    store: { kind: "file", dir: join(dir, "busy") },
    now,
  });

  const inFlight = ekman.entities.slow.send("s1", { type: "go" });
  const refused = await caught(ekman.entities.slow.forget("s1"));

  console.log(
    `  while a handler runs: ${isEkmanError(refused) ? refused.code : "it was allowed"}`
  );
  check(
    isEkmanError(refused) && refused.code === "KEY_BUSY",
    `forget was not refused with KEY_BUSY: ${String(refused)}`
  );

  release();
  await inFlight;
  await ekman.entities.slow.forget("s1");
  console.log("  once idle:            forgotten");

  check(
    ekman.entities.slow.inspect("s1") === undefined,
    "the instance survived a forget on an idle key"
  );

  console.log(
    "\n  A commit landing into a key that had just been deleted would resurrect it at a\n" +
      "  sequence nothing accounts for, and the fence cannot help: an attempt already\n" +
      "  writing has sealed its token. Refusing is the honest answer, and a sweep that\n" +
      "  meets a busy key can simply come back to it."
  );
  await ekman.close();
}

/** Whatever a promise rejected with, or its value if it did not. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
