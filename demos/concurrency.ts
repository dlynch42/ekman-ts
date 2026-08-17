/**
 * Concurrency: the same racy handler, measured with and without a runtime under it.
 *
 * Run with `npm run demo:concurrency`.
 *
 * `demo:ordering` makes this argument with five triggers and explains it. This one runs it
 * at load and watches it happen: thousands of triggers in flight at once, sampled while
 * they run, so what comes out is a picture of the runtime working rather than a paragraph
 * about it.
 *
 * The `await` in the handler is the point. It stands for the database call or the HTTP
 * request: the moment a handler yields, which is when a second trigger for the same key
 * would otherwise walk into the middle of it.
 */

import { defineEntity, Ekman, stay } from "ekman";
import { banner, check, delay, row } from "./lib";

const KEYS = 200;
const TRIGGERS_PER_KEY = 25;
const TOTAL = KEYS * TRIGGERS_PER_KEY;
/** Long enough to guarantee a yield, short enough to finish a demo. */
const WORK_MS = 1;
/** How often the run below takes a reading of itself. */
const SAMPLE_MS = 5;
const BAR = 46;

const keys = Array.from({ length: KEYS }, (_, i) => `k${i}`);

const counters = defineEntity("counters", {
  initial: "counting",
  values: { n: 0 },
  states: {
    // Read, yield, write. Against anything without per-key serialization this is the
    // oldest race there is.
    counting: async (counter) => {
      const seen = counter.values.n;
      await delay(WORK_MS);
      return stay({ n: seen + 1 });
    },
  },
});

async function main(): Promise<void> {
  const byHand = await withoutARuntime();
  const run = await managed();
  summary(run, byHand);
}

interface ByHand {
  lost: number;
  racyMs: number;
  chainedMs: number;
}

/** The same handler twice: once with no coordination, once with the obvious fix. */
async function withoutARuntime(): Promise<ByHand> {
  banner(
    `1. By hand: ${TOTAL.toLocaleString()} increments across ${KEYS} keys`
  );

  const counts = new Map(keys.map((key) => [key, 0]));
  const bump = async (key: string) => {
    const seen = counts.get(key) ?? 0;
    await delay(WORK_MS);
    counts.set(key, seen + 1);
  };
  const all = (run: (key: string) => Promise<void>) =>
    Promise.all(
      keys.flatMap((key) =>
        Array.from({ length: TRIGGERS_PER_KEY }, () => run(key))
      )
    );

  let started = Date.now();
  await all(bump);
  const racyMs = Date.now() - started;

  const landed = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const lost = TOTAL - landed;

  console.log("  no coordination");
  row("landed", `${landed.toLocaleString()} of ${TOTAL.toLocaleString()}`);
  row("lost", lost, "and not one of them errored");
  row("elapsed", `${racyMs}ms`);

  check(lost > 0, "the unmanaged version did not race, so this proves nothing");

  // The obvious fix, and the fair baseline: one promise chain per key, which is exactly
  // the mechanism the runtime uses underneath. This is what "just write it carefully"
  // costs, so the comparison at the end is against correct code rather than fast wrong
  // code.
  for (const key of keys) {
    counts.set(key, 0);
  }
  const chains = new Map<string, Promise<void>>();
  const chained = (key: string) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(() => bump(key));
    chains.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  };

  started = Date.now();
  await all(chained);
  const chainedMs = Date.now() - started;
  const chainedTotal = [...counts.values()].reduce((sum, n) => sum + n, 0);

  console.log("\n  one promise chain per key, written by hand");
  row(
    "landed",
    `${chainedTotal.toLocaleString()} of ${TOTAL.toLocaleString()}`
  );
  row("lost", TOTAL - chainedTotal);
  row("elapsed", `${chainedMs}ms`);

  check(
    chainedTotal === TOTAL,
    "the hand-chained baseline lost updates, so it is not a baseline"
  );

  return { lost, racyMs, chainedMs };
}

interface Run {
  perKey: number;
  overall: number;
  elapsed: number;
  starts: string[];
}

/** The same load, through the runtime, sampled while it runs. */
async function managed(): Promise<Run> {
  banner("2. The same handler, the same load, through the runtime");

  const active = new Map<string, number>();
  const starts: string[] = [];
  let running = 0;
  let committed = 0;
  let peakPerKey = 0;
  let peakOverall = 0;

  const ekman = new Ekman({
    entities: [counters],
    telemetry: {
      "handler.started": (event) => {
        const now = (active.get(event.key) ?? 0) + 1;
        active.set(event.key, now);
        running += 1;
        peakPerKey = Math.max(peakPerKey, now);
        peakOverall = Math.max(peakOverall, running);
        if (starts.length < KEYS + 4) {
          starts.push(event.key);
        }
      },
      "handler.settled": (event) => {
        active.set(event.key, (active.get(event.key) ?? 1) - 1);
        running -= 1;
        if (event.outcome === "committed") {
          committed += 1;
        }
      },
    },
  });

  console.log(
    `  ${TOTAL.toLocaleString()} triggers, all in flight at once, sampled every ${SAMPLE_MS}ms\n`
  );

  const started = Date.now();
  // The reading is taken from outside the work, on a timer, so the numbers are what a
  // dashboard would have seen rather than something the demo arranged.
  const sampler = setInterval(() => {
    print(Date.now() - started, running, committed);
  }, SAMPLE_MS);

  await Promise.all(
    keys.flatMap((key) =>
      Array.from({ length: TRIGGERS_PER_KEY }, (_, i) =>
        ekman.entities.counters.send(key, { type: "bump", id: `${key}-${i}` })
      )
    )
  );

  clearInterval(sampler);
  const elapsed = Date.now() - started;
  print(elapsed, running, committed);

  let landed = 0;
  for (const key of keys) {
    const value = ekman.entities.counters.inspect(key)?.values.n;
    landed += typeof value === "number" ? value : 0;
  }

  console.log("");
  row("issued", TOTAL);
  row("landed", landed);
  row("lost", TOTAL - landed);
  row("elapsed", `${elapsed}ms`);
  row(
    "throughput",
    `${Math.round(TOTAL / (elapsed / 1000)).toLocaleString()} commits/sec`
  );

  check(
    landed === TOTAL,
    `${TOTAL - landed} updates were lost through the runtime`
  );
  for (const key of keys) {
    check(
      ekman.entities.counters.inspect(key)?.seq === TRIGGERS_PER_KEY,
      `${key} did not commit ${TRIGGERS_PER_KEY} times in order`
    );
  }

  await ekman.close();
  return { perKey: peakPerKey, overall: peakOverall, elapsed, starts };
}

/** One sampled reading: how many handlers were running, and how far along it was. */
function print(at: number, inFlight: number, committed: number): void {
  const filled = Math.round((inFlight / KEYS) * BAR);
  const done = Math.round((committed / TOTAL) * 100);
  console.log(
    `    t+${String(at).padStart(4)}ms  ${"█".repeat(filled).padEnd(BAR, "·")}  ` +
      `${String(inFlight).padStart(3)} in flight  ` +
      `${String(committed).padStart(5)} committed  ${String(done).padStart(3)}%`
  );
}

function summary(run: Run, byHand: ByHand): void {
  banner("3. What those numbers are");

  row("peak in flight, one key", run.perKey, "the guarantee");
  row(
    "peak in flight, all keys",
    run.overall,
    "what the guarantee did not cost"
  );
  row("per key", `${TRIGGERS_PER_KEY} commits, sequence dense`);

  const short = (key: string) => key.slice(key.indexOf(":") + 1);
  console.log("\n  handlers started, in order:");
  console.log(`    ${run.starts.slice(0, 16).map(short).join(" ")} ...`);
  console.log(
    `    ${run.starts
      .slice(KEYS, KEYS + 6)
      .map(short)
      .join(" ")} ... each only once its own previous one had settled`
  );

  check(
    run.perKey === 1,
    `two handlers ran for one key at once (${run.perKey})`
  );
  check(run.overall > 1, `only ${run.overall} handler ran at a time overall`);

  console.log("");
  row("no coordination", `${byHand.racyMs}ms`, `${byHand.lost} lost updates`);
  row("chained by hand", `${byHand.chainedMs}ms`, "correct, and nothing else");
  row("the runtime", `${run.elapsed}ms`, "correct, and everything else");

  const overhead = run.elapsed - byHand.chainedMs;
  const per = Math.round((overhead / TOTAL) * 1000);
  row("the difference", `${overhead}ms`, `${per}µs per commit`);

  console.log(
    "\n  The first row is the one to ignore: it is faster because it does not stop to be\n" +
      "  correct, and its answer is wrong. The comparison that means something is the\n" +
      `  second against the third, both correct, ${per}µs per commit apart.\n` +
      "\n" +
      "  The middle row is a promise chain per key and nothing else, which is the same\n" +
      "  mechanism the runtime uses. What the third row buys for that difference is every\n" +
      "  commit sequenced and recorded, the queue bounded and observable, and a handler\n" +
      "  that stays the naive one. Node runs one thread throughout: none of this is\n" +
      "  parallelism, it is the removal of coordination the handler would otherwise have\n" +
      "  to contain."
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
