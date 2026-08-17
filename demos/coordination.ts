/**
 * Coordination: what a store declares, and the configuration that declaration protects.
 *
 * Run with `npm run demo:coordination`.
 *
 * `demo:durability` prints the capability table and says `multiWriter: false` is the honest
 * declaration. This is the other half of that sentence: what goes wrong when two runtimes
 * share a store that cannot arbitrate between them, why the runtime refuses to be
 * configured for it, and what a store that *can* arbitrate buys you.
 *
 * The failure in section 3 is not hypothetical and not simulated. It is two ordinary file
 * stores pointed at one directory, which is exactly what deploying two replicas of a
 * service with the same data directory looks like.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "ekman";
import {
  createStore,
  defaultLogDir,
  defineEntity,
  Ekman,
  isEkmanError,
  replay,
  stay,
} from "ekman";

/** Enough keys and rounds that the collisions are a rate rather than an anecdote. */
const KEYS = 25;
const ROUNDS = 8;
const keys = Array.from({ length: KEYS }, (_, i) => `c${i}`);

/** Each commit records who made it, so a lost write is visible rather than inferred. */
const counters = defineEntity("counters", {
  initial: "open",
  values: { n: 0, by: "nobody" },
  states: {
    open: (counter, trigger) =>
      stay({ n: counter.values.n + 1, by: trigger.by as string }),
  },
});

// Cleared on the way in, kept afterwards, in its own subdirectory. Same as every other
// demo: the log this wrote is worth reading with `cat` once it finishes.
const dir = join(defaultLogDir(), "demos", "coordination");
rmSync(dir, { recursive: true, force: true });

async function main(): Promise<void> {
  console.log(`store: ${dir}\n`);
  whatTheStoresDeclare();
  theRefusal();
  await whatTheRefusalIsProtecting();
  await whenTheStoreCanTell();

  console.log(
    `\n${"=".repeat(78)}\n` +
      "A capability is a promise the adapter is held to, so the only honest thing a store\n" +
      "can do about a guarantee it cannot keep is say so. What that buys is a refusal at\n" +
      "startup instead of a duplicated sequence found weeks later in a log nobody was\n" +
      "reading. Coordinated is unclaimed for the same reason: not because the runtime half\n" +
      "is missing, but because no adapter here can carry the store half yet.\n"
  );
}

/** The two shipped adapters, and the field this demo is about. */
function whatTheStoresDeclare(): void {
  banner("1. What the stores declare");

  for (const store of [
    createStore("memory"),
    createStore({ kind: "file", dir }),
  ]) {
    const caps = store.capabilities;
    console.log(
      `  ${store.name.padEnd(8)} durability=${caps.durability.padEnd(9)} ` +
        `conditionalAppend=${String(caps.conditionalAppend).padEnd(5)} ` +
        `multiWriter=${caps.multiWriter}`
    );
  }

  console.log(
    "\n  Both say their conditional append is real, and both say it does not hold across\n" +
      "  processes. Those are not in tension. The file store's append is genuinely atomic\n" +
      "  against anything else in this process, because `appendFileSync` cannot be\n" +
      "  interleaved. Another process is not in this process."
  );
}

/** The configuration that the declaration exists to refuse. */
function theRefusal(): void {
  banner("2. Asking for more than the store has");

  const refused = caught(
    () =>
      new Ekman({
        entities: [counters],
        store: { kind: "file", dir: join(dir, "refused") },
        coordination: "multi",
      })
  );

  console.log(`  code     ${isEkmanError(refused) ? refused.code : "none"}`);
  console.log(
    `  message  ${isEkmanError(refused) ? refused.message : "it started"}`
  );

  check(
    isEkmanError(refused) && refused.code === "INVALID_CONFIG",
    `multi-runtime coordination was not refused: ${String(refused)}`
  );

  console.log(
    "\n  Refused at startup, before a single trigger. `coordination` defaults to `single`,\n" +
      "  which is one runtime owning its own storage and is what most services are. Saying\n" +
      "  `multi` is saying other processes write these keys, and that is a promise only the\n" +
      "  store can keep."
  );
}

/** Two ordinary file stores, one directory, and appends that were never conditional. */
async function whatTheRefusalIsProtecting(): Promise<void> {
  banner("3. What that refusal is protecting you from");

  const shared = join(dir, "two-writers");
  // Two runtimes, each with its own file store, both pointed at one directory. This is
  // what two replicas of a service sharing a data directory actually is.
  const a = new Ekman({
    entities: [counters],
    store: { kind: "file", dir: shared },
  });
  const b = new Ekman({
    entities: [counters],
    store: { kind: "file", dir: shared },
  });

  const run = await bothWriters(a.entities.counters, b.entities.counters);
  await a.close();
  await b.close();

  // Read the way any later reader would: load and replay, no runtime in the way.
  const reader = createStore({ kind: "file", dir: shared });
  const survived = await surviving(reader);

  report(run, survived);

  check(
    run.refused === 0,
    `${run.refused} appends were refused, so the store did detect`
  );
  check(
    survived.total < run.acknowledged,
    "nothing was lost, so this store detected the collisions after all"
  );
  check(
    survived.duplicated > 0,
    "no duplicate sequences, so the writers never collided"
  );

  const rate = Math.round(
    ((run.acknowledged - survived.total) / run.acknowledged) * 100
  );
  console.log(
    `\n  Nothing errored anywhere, and ${rate}% of what was acknowledged is not in the record.\n` +
      "  Every one of those was returned to a caller as durable. Two events sharing a\n" +
      "  sequence means replay keeps one and drops the other, and the caller who was told\n" +
      "  about the dropped one has no way to find out.\n" +
      "\n" +
      "  No care inside the runtime can prevent this. Each append asked the store to write\n" +
      "  only if the key was at a given sequence, and the store said yes, because as far as\n" +
      "  that store could see it was. That is what `multiWriter: false` means, and why\n" +
      "  section 2 is a refusal rather than a warning."
  );
}

/** The same load against a store that can actually see both writers. */
async function whenTheStoreCanTell(): Promise<void> {
  banner("4. The same load, against a store that can tell");

  // One store object, two runtimes. Not two processes: this stands in for a store whose
  // conditional append is atomic across them, which is what a Redis or Postgres adapter
  // would provide and what `multiWriter: true` will mean when one declares it.
  let reloads = 0;
  const store = createStore("memory");
  const a = new Ekman({
    entities: [counters],
    store,
    telemetry: {
      "instance.restored": () => {
        reloads += 1;
      },
    },
  });
  const b = new Ekman({ entities: [counters], store });

  const run = await bothWriters(a.entities.counters, b.entities.counters);
  const survived = await surviving(store);

  report(run, survived);
  row("reloads", reloads, "each one a key re-read after a collision");

  check(
    run.refused > 0,
    "no collision was detected, so the store did not arbitrate"
  );
  check(
    survived.total === run.acknowledged,
    `${run.acknowledged - survived.total} acknowledged commits did not survive replay`
  );
  check(
    survived.duplicated === 0,
    "a sequence was written twice despite detection"
  );

  console.log(
    "\n  Same collisions, opposite outcome. Every one was refused rather than written, so\n" +
      "  the record holds exactly what was acknowledged and nothing was quietly dropped.\n" +
      "  The senders that were refused were told, and can retry or give up on their own\n" +
      "  terms.\n" +
      "\n" +
      "  The reloads are the other half. Without them a stale sequence would sit in the\n" +
      "  runtime forever and every later trigger for that key would collide too, so one\n" +
      "  collision would cost the key rather than the trigger."
  );

  await a.close();
  await b.close();
}

interface Load {
  issued: number;
  acknowledged: number;
  refused: number;
}

/** Just enough of an entity handle to drive it. Both runtimes expose the same one. */
interface Writer {
  send: (id: string, trigger: { type: string; by: string }) => Promise<unknown>;
}

/**
 * The two runtimes taking turns over the same keys, which is what two replicas behind a
 * load balancer look like.
 *
 * Turns rather than simultaneously, and the difference matters. Two writers arriving at an
 * untouched key at the same instant both try to create it, and even a store that cannot see
 * across processes will refuse the second, because neither has cached anything to be wrong
 * about yet. The damaging case is the ordinary one: a writer acts, some other writer moves
 * the key, and the first writer comes back believing it still knows where the key is.
 */
async function bothWriters(a: Writer, b: Writer): Promise<Load> {
  let acknowledged = 0;
  let refused = 0;

  const tick = async (writer: Writer, key: string, by: string) => {
    try {
      await writer.send(key, { type: "tick", by });
      acknowledged += 1;
    } catch {
      refused += 1;
    }
  };

  for (let round = 0; round < ROUNDS; round += 1) {
    for (const [writer, by] of [
      [a, "a"],
      [b, "b"],
    ] as const) {
      // One writer's whole batch settles before the other starts, so by the time each
      // comes back around, the other has moved every key it is about to touch.
      // biome-ignore lint/performance/noAwaitInLoops: the turn-taking is the point, so these cannot overlap
      await Promise.all(keys.map((key) => tick(writer, key, by)));
    }
  }

  return { issued: KEYS * ROUNDS * 2, acknowledged, refused };
}

/** What the store actually holds afterwards, read back through replay. */
async function surviving(
  store: Store
): Promise<{ total: number; duplicated: number }> {
  let total = 0;
  let duplicated = 0;

  for (const key of keys) {
    const full = key.startsWith("counters:") ? key : `counters:${key}`;
    // biome-ignore lint/performance/noAwaitInLoops: one key at a time keeps this readable and it is not a hot path
    const loaded = await store.load(full);
    if (loaded === undefined) {
      continue;
    }

    const current = replay(loaded);
    total += typeof current?.values.n === "number" ? current.values.n : 0;

    const events = await store.read(full);
    const seqs = events
      .filter((event) => event.type === "transition")
      .map((event) => event.seq);
    duplicated += seqs.length - new Set(seqs).size;
  }

  return { total, duplicated };
}

function report(
  run: Load,
  survived: { total: number; duplicated: number }
): void {
  row("triggers issued", run.issued);
  row("acknowledged", run.acknowledged, "returned to a caller as committed");
  row("refused", run.refused);
  row("survive replay", survived.total);
  row(
    "lost",
    run.acknowledged - survived.total,
    "acknowledged, then not there"
  );
  row(
    "duplicate sequences",
    survived.duplicated,
    "two events claiming one seq"
  );
}

/** Whatever a call threw, or its value if it did not. */
function caught(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

function row(label: string, value: string | number, note?: string): void {
  const shown = typeof value === "number" ? value.toLocaleString() : value;
  console.log(
    `  ${label.padEnd(22)}${shown.padStart(8)}${note === undefined ? "" : `   ${note}`}`
  );
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
