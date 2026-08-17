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

/** One instance, many commits, and a log that stops growing. */
async function aLogThatCompacts(): Promise<void> {
  banner("1. A single log, compacted so it does not grow forever");

  const ekman = new Ekman({
    entities: [tickets],
    // 2 KB rather than the 5 MB default, so this finishes in a demo rather than an hour.
    store: {
      kind: "file",
      dir: join(dir, "compaction"),
      retention: { perLogBytes: 2048 },
    },
    now,
  });

  const COMMITS = 100;
  for (let i = 0; i < COMMITS; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each commit has to land before the next
    await ekman.entities.tickets.send("t1", { type: "update" });
  }

  const current = ekman.entities.tickets.inspect("t1");
  const { events, complete } = await ekman.entities.tickets.history("t1");

  console.log(`  commits sent      ${COMMITS}`);
  console.log(`  events retained   ${events.length}`);
  console.log(`  bytes on disk     ${ekman.storageUsage.bytes}`);
  console.log(`  state             ${current?.state} seq=${current?.seq}`);
  console.log(`  history complete  ${complete}`);

  check(
    current?.seq === COMMITS,
    `the sequence did not survive compaction: ${current?.seq}`
  );
  check(
    events.length < COMMITS,
    `nothing was compacted: ${events.length} events for ${COMMITS} commits`
  );
  check(complete === false, "a compacted history claimed to be complete");

  console.log(
    "\n  The sequence is still at 100 and the values are intact, because everything the\n" +
      "  snapshot folded away was already reflected in it. What was lost is the middle of\n" +
      "  the stream, and `complete: false` is history saying so rather than a shorter\n" +
      "  answer quietly passing as a whole one."
  );

  // A second runtime over the same directory, to show compaction is not a resident trick.
  await ekman.close();
  const reopened = new Ekman({
    entities: [tickets],
    store: { kind: "file", dir: join(dir, "compaction") },
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
  console.log(`  bytes  ${usage.bytes}`);
  console.log(`  logs   ${usage.logs}`);
  console.log(`  ceiling ${usage.maxBytes === null ? "none" : usage.maxBytes}`);
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

  console.log(`\n  budget            ${bounded.storageUsage.maxBytes} bytes`);
  console.log(`  holding           ${bounded.storageUsage.bytes} bytes`);
  console.log(
    `  existing instance committed at seq ${stillCommitting.seq}, unaffected`
  );
  console.log(
    `  a new instance    ${isEkmanError(refused) ? refused.code : "was accepted"}`
  );

  check(
    isEkmanError(refused) && refused.code === "STORE_FULL",
    `a new instance was not refused with STORE_FULL: ${String(refused)}`
  );

  console.log(
    "\n  Shedding new work is recoverable and stopping work already in flight is not, so\n" +
      "  `reject` refuses the instance that does not exist yet and leaves the ones that do\n" +
      "  alone. The alternative default, deleting something to make room, would answer a\n" +
      "  disk-space question by destroying data nobody agreed to lose."
  );
  await bounded.close();
}

/** The sweep: a query you already have, plus the one verb that deletes. */
async function retention(): Promise<void> {
  banner("3. Retention: a query you already have, plus one verb");

  const ekman = new Ekman({
    entities: [tickets],
    store: { kind: "file", dir: join(dir, "retention") },
    now,
  });

  for (const id of ["old-1", "old-2", "recent"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each has to land before the clock moves
    await ekman.entities.tickets.send(id, { type: "update" });
  }
  await ekman.entities.tickets.send("old-1", { type: "close" });
  await ekman.entities.tickets.send("old-2", { type: "close" });

  // Forty days pass. The two closed tickets are now genuinely old; the open one is not.
  clock += 40 * DAY;
  await ekman.entities.tickets.send("recent", { type: "close" });

  const before = ekman.storageUsage;
  const { instances, complete } = await ekman.entities.tickets.query({
    state: "closed",
    olderThan: "30d",
  });

  console.log(`  closed for over 30 days: ${instances.length}`);
  for (const match of instances) {
    console.log(`    ${match.key}`);
  }
  console.log(`  answer complete: ${complete}`);

  // Nothing here is automatic. The query is the policy, and it is application code.
  for (const match of instances) {
    // biome-ignore lint/performance/noAwaitInLoops: a sweep is not a race worth winning
    await ekman.forget(match.key);
  }

  const after = ekman.storageUsage;
  console.log(`\n  bytes before  ${before.bytes} across ${before.logs} logs`);
  console.log(`  bytes after   ${after.bytes} across ${after.logs} logs`);

  check(
    instances.length === 2,
    `expected the two old tickets, found ${instances.length}`
  );
  check(
    after.bytes < before.bytes && after.logs === before.logs - 2,
    "forgetting did not give the budget its bytes back"
  );
  check(
    ekman.entities.tickets.inspect("recent") !== undefined,
    "the ticket that was not old enough was deleted anyway"
  );

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
  banner("4. Forgetting is refused while a handler is in flight");

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

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function banner(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
