/**
 * Stuck detection: "show me everything wedged in `deploying` for more than five minutes".
 *
 * Run with `npm run demo:stuck`.
 *
 * This is the question homegrown state handling never answers. The state is in a row
 * somewhere, the timestamp is in a different column, whether it is *stuck* or merely slow
 * is a judgement nobody wrote down, and the query gets rebuilt from scratch by whoever is
 * on call at the time.
 *
 * Two halves here, and they share one measurement on purpose. `query` asks the question on
 * demand. A temporal constraint asks it continuously and escalates when the answer is yes.
 * If those were two implementations of "how long has this been here", they would eventually
 * give two answers.
 *
 * The part worth watching is what the escalation *is*. The runtime does not move the
 * instance. It delivers a trigger, through the normal inbox, to the normal handler, and the
 * handler decides. Below, two of the stuck deployments give up and one decides to keep
 * waiting, and the runtime is equally fine with both.
 *
 * The clock is injected, so five minutes takes no time at all.
 */

import { defineEntity, Ekman, stay, transitionTo } from "ekman";
import { banner, check, row, stream } from "./lib";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BOUND = 5 * MINUTE;

type State = "queued" | "deploying" | "live" | "failed";

interface Values extends Record<string, unknown> {
  region: string;
  /** What this deployment's handler will do if it gets escalated. */
  onEscalation: "give-up" | "keep-waiting";
  note: string;
}

/** Advanced by hand. Nothing here waits on a real timer. */
let clock = Date.UTC(2026, 0, 1, 12, 0, 0);

const deployments = defineEntity("deployments", {
  initial: "queued",
  values: {
    region: "",
    onEscalation: "give-up",
    note: "",
  } as Values,
  states: {
    queued: (deployment, trigger) =>
      transitionTo("deploying", {
        ...deployment.values,
        region: trigger.region as string,
        onEscalation: trigger.onEscalation as Values["onEscalation"],
        note: "started",
      }),

    deploying: (deployment, trigger) => {
      // The escalation is an ordinary trigger. It arrives here, in the handler, with the
      // state it is asking for on it, and this code decides whether to agree.
      if (trigger.type === "constraint.temporal") {
        if (deployment.values.onEscalation === "keep-waiting") {
          return stay({
            ...deployment.values,
            note: "escalated, still waiting on purpose",
          });
        }
        return transitionTo(trigger.escalateTo as State, {
          ...deployment.values,
          note: "gave up after the time bound",
        });
      }

      return trigger.type === "succeeded"
        ? transitionTo("live", { ...deployment.values, note: "deployed" })
        : transitionTo("failed", { ...deployment.values, note: "rejected" });
    },

    live: (deployment) => stay(deployment.values),
    failed: (deployment) => stay(deployment.values),
  },
  constraints: {
    temporal: [{ in: "deploying", within: BOUND, escalateTo: "failed" }],
  },
});

/**
 * A fleet, not an anecdote.
 *
 * The healthy ones exist so the query has something to *not* match, and so the sweep has
 * something to walk past. Both are the part that matters operationally: an answer is only
 * useful if it excludes things, and a constraint is only affordable if watching one state
 * does not cost every instance in the runtime.
 */
const HEALTHY = Array.from({ length: 300 }, (_, i) => `ok-${i}`);
const WEDGED = 40;

async function main(): Promise<void> {
  let escalations = 0;

  const ekman = new Ekman({
    entities: [deployments],
    now: () => clock,
    telemetry: {
      "constraint.escalated": (event) => {
        escalations += 1;
        // The first few, so the shape of the event is on screen, then a count. Forty
        // identical lines would say nothing the summary does not.
        if (escalations <= 3) {
          console.log(
            `    constraint.escalated  ${event.key}  stuck ${event.elapsedMs / MINUTE}m  ` +
              `asking for ${event.escalateTo}  delivered=${event.delivered}`
          );
        }
      },
    },
  });

  const handle = ekman.entities.deployments;

  // The ones that will wedge, staggered a minute apart so they have different ages. Every
  // fourth one will refuse the escalation when it comes, which is the interesting case.
  const wedged = Array.from({ length: WEDGED }, (_, i) => `wedged-${i}`);
  for (const [i, name] of wedged.entries()) {
    // Advanced before rather than after, so the youngest is zero minutes old when the loop
    // ends and the five minutes below put it exactly on the bound.
    if (i > 0) {
      clock += MINUTE;
    }
    // biome-ignore lint/performance/noAwaitInLoops: staggered on purpose, so each one has its own age
    await handle.send(name, {
      type: "start",
      region: "us-west-2",
      onEscalation: i % 4 === 3 ? "keep-waiting" : "give-up",
    });
  }
  const waiting = wedged.filter((_, i) => i % 4 === 3);

  // The fleet that behaves. They pass through `deploying` and out the other side, and the
  // query below has to leave every one of them alone.
  for (const name of HEALTHY) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential so each one's timestamps are attributable
    await handle.send(name, {
      type: "start",
      region: "us-west-2",
      onEscalation: "give-up",
    });
    await handle.send(name, { type: "succeeded" });
  }

  // Five more minutes pass. The youngest wedged one is now exactly on the bound.
  clock += 5 * MINUTE;

  banner("1. Ask the question");

  row("instances", HEALTHY.length + wedged.length);
  row("in deploying", wedged.length, "the rest went live");
  console.log("");

  const stuck = await handle.query({ state: "deploying", olderThan: "5m" });
  console.log('  query({ state: "deploying", olderThan: "5m" })\n');
  for (const match of stuck.instances.slice(0, 5)) {
    console.log(
      `    ${match.key.padEnd(24)} ${match.state.padEnd(10)} stuck ${match.ageMs / MINUTE}m`
    );
  }
  console.log(`    ... ${stuck.instances.length - 5} more, youngest last`);

  console.log("");
  row(
    "matched",
    stuck.instances.length,
    `of ${HEALTHY.length + wedged.length} instances`
  );
  row("oldest", `${(stuck.instances[0]?.ageMs ?? 0) / MINUTE}m`);
  row(
    "youngest",
    `${(stuck.instances.at(-1)?.ageMs ?? 0) / MINUTE}m`,
    "exactly on the bound"
  );
  row(
    "complete",
    String(stuck.complete),
    `reasons: [${stuck.reasons.join(", ")}]`
  );

  console.log(
    "\n  Every instance here is resident, so that answer happens to be the whole one. The\n" +
      "  runtime still will not claim it is, because with no durable store it cannot tell\n" +
      "  this case from having lost something before it started."
  );

  check(
    stuck.instances.length === wedged.length,
    `expected all ${wedged.length} wedged deployments, got ${stuck.instances.length}`
  );
  check(
    keysOf(stuck) === wedged.map((name) => `deployments:${name}`).join(","),
    "the answer is not oldest-in-state first"
  );
  check(
    stuck.instances.at(-1)?.ageMs === BOUND,
    "the youngest wedged one is not sitting exactly on the bound"
  );

  // The bound is inclusive, and one millisecond either side of it is the whole difference
  // between an alert firing and not firing. Worth pinning from both directions.
  const onTheBound = await handle.query({
    state: "deploying",
    olderThan: BOUND,
  });
  const justPast = await handle.query({
    state: "deploying",
    olderThan: BOUND + 1,
  });
  console.log("");
  row(
    `olderThan ${BOUND}ms`,
    onTheBound.instances.length,
    "the bound is inclusive"
  );
  row(
    `olderThan ${BOUND + 1}ms`,
    justPast.instances.length,
    "one fewer: the youngest is exactly on it"
  );
  check(
    onTheBound.instances.length === wedged.length &&
      justPast.instances.length === wedged.length - 1,
    "the bound is not inclusive the way the query documents it"
  );

  banner("2. Let the constraint ask it, continuously");

  const firstSweep = await ekman.sweep();
  console.log("");
  row("instances swept", HEALTHY.length + wedged.length, "one pass, every key");
  row("escalated", firstSweep, "only those past the bound");
  row("gave up", wedged.length - waiting.length, "handler agreed and moved");
  row("kept waiting", waiting.length, "handler declined, still deploying");

  check(
    escalations === wedged.length,
    `expected ${wedged.length} escalations, saw ${escalations}`
  );
  check(
    wedged
      .filter((name) => !waiting.includes(name))
      .every((name) => handle.inspect(name)?.state === "failed"),
    "the deployments that chose to give up did not move"
  );
  check(
    waiting.every((name) => handle.inspect(name)?.state === "deploying"),
    "a deployment that chose to keep waiting was moved anyway"
  );

  console.log(
    `\n  ${wedged.length - waiting.length} handlers agreed with the escalation and ${waiting.length} did not, and every one that\n` +
      "  did not is still exactly where it was. The runtime never wrote a state: it asked."
  );

  // A constraint that re-fired every pass would turn one stuck instance into an alert
  // storm. It fires once per entry into the state, and `stay` is not a re-entry.
  const secondSweep = await ekman.sweep();
  console.log("");
  row("a second sweep", secondSweep, "fires once per entry, not per pass");
  check(
    secondSweep === 0 && escalations === wedged.length,
    `the constraint fired again on a second sweep (${escalations} total)`
  );

  banner("3. Ask again");

  const after = await handle.query({ state: "deploying", olderThan: "5m" });
  const healthy = await handle.query({ state: "live" });
  row("still stuck", after.instances.length, "the ones that chose to wait");
  row("live", healthy.instances.length, "never swept, never escalated");

  check(
    keysOf(after) === waiting.map((name) => `deployments:${name}`).join(","),
    `expected only the ones that chose to wait, got ${keysOf(after)}`
  );
  check(
    healthy.instances.length === HEALTHY.length,
    `the healthy deployments were disturbed: ${healthy.instances.length} of ${HEALTHY.length} still live`
  );

  // The escalation is in the same per-key stream as the transitions, so "what happened to
  // this one" needs no second system.
  const gaveUp = wedged.find((name) => !waiting.includes(name)) as string;
  const { events } = await handle.history(gaveUp);
  console.log("\n  one that gave up, its whole stream:\n");
  stream(`deployments:${gaveUp}`, events);

  console.log(
    `\n${"=".repeat(78)}\n` +
      "One measurement answered both halves: the query an operator runs at 3am, and the\n" +
      "constraint that would have paged them at 3am. `query` reads the same time-in-state\n" +
      "the constraint watches, which is why the alert and the investigation can never\n" +
      "disagree about how long something has been stuck.\n"
  );

  await ekman.close();
}

/** Match keys in result order, as one string, so an assertion failure is readable. */
function keysOf(result: { instances: readonly { key: string }[] }): string {
  return result.instances.map((match) => match.key).join(",");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
