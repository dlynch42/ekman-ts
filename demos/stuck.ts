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

import type { EkmanEvent } from "ekman";
import { defineEntity, Ekman, stay, transitionTo } from "ekman";
import { banner, check } from "./lib";

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

const HEALTHY = ["blue", "green", "teal", "amber", "coral"];

async function main(): Promise<void> {
  let escalations = 0;

  const ekman = new Ekman({
    entities: [deployments],
    now: () => clock,
    telemetry: {
      "constraint.escalated": (event) => {
        escalations += 1;
        console.log(
          `    telemetry  constraint.escalated  ${event.key}  stuck ${event.elapsedMs / MINUTE}m  asking for ${event.escalateTo}  delivered=${event.delivered}`
        );
      },
    },
  });

  const handle = ekman.entities.deployments;

  // Three that will wedge, staggered a minute apart so they have different ages.
  await handle.send("wedged-1", {
    type: "start",
    region: "us-west-2",
    onEscalation: "give-up",
  });
  clock += MINUTE;
  await handle.send("wedged-2", {
    type: "start",
    region: "us-east-1",
    onEscalation: "give-up",
  });
  clock += MINUTE;
  await handle.send("wedged-3", {
    type: "start",
    region: "eu-west-1",
    onEscalation: "keep-waiting",
  });

  // Five that behave. They pass through `deploying` and out the other side.
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

  const stuck = await handle.query({ state: "deploying", olderThan: "5m" });
  console.log('  query({ state: "deploying", olderThan: "5m" })\n');
  for (const match of stuck.instances) {
    console.log(
      `    ${match.key.padEnd(24)} ${match.state.padEnd(10)} stuck ${match.ageMs / MINUTE}m`
    );
  }
  console.log(
    `\n  complete: ${stuck.complete}  reasons: [${stuck.reasons.join(", ")}]  sources: [${stuck.sources.join(", ")}]`
  );
  console.log(
    "  Every instance here is resident, so that answer happens to be the whole one. The\n" +
      "  runtime still will not claim it is, because with no durable store it cannot tell\n" +
      "  this case from having lost something before it started."
  );

  check(
    keysOf(stuck) ===
      "deployments:wedged-1,deployments:wedged-2,deployments:wedged-3",
    `expected the three wedged deployments oldest-first, got ${keysOf(stuck)}`
  );
  check(
    stuck.instances[0]?.ageMs === 7 * MINUTE &&
      stuck.instances[2]?.ageMs === BOUND,
    "the ages are not what the clock says they should be"
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
  console.log(
    `\n  olderThan ${BOUND}ms exactly -> ${onTheBound.instances.length} matches` +
      `\n  olderThan ${BOUND + 1}ms       -> ${justPast.instances.length} matches, because wedged-3 is exactly on the bound`
  );
  check(
    onTheBound.instances.length === 3 && justPast.instances.length === 2,
    "the bound is not inclusive the way the query documents it"
  );

  banner("2. Let the constraint ask it, continuously");

  console.log("  sweep 1:\n");
  const firstSweep = await ekman.sweep();
  console.log(`\n  ${firstSweep} instances escalated\n`);

  for (const name of ["wedged-1", "wedged-2", "wedged-3"]) {
    const snapshot = handle.inspect(name);
    console.log(
      `    ${name}  ${snapshot?.state.padEnd(10)} ${snapshot?.values.note}`
    );
  }

  check(escalations === 3, `expected 3 escalations, saw ${escalations}`);
  check(
    handle.inspect("wedged-1")?.state === "failed" &&
      handle.inspect("wedged-2")?.state === "failed",
    "the deployments that chose to give up did not move"
  );
  check(
    handle.inspect("wedged-3")?.state === "deploying",
    "the deployment that chose to keep waiting was moved anyway"
  );

  console.log(
    "\n  Two handlers agreed with the escalation and one did not, and the one that did\n" +
      "  not is still exactly where it was. The runtime never wrote a state: it asked."
  );

  // A constraint that re-fired every pass would turn one stuck instance into an alert
  // storm. It fires once per entry into the state, and `stay` is not a re-entry.
  console.log("\n  sweep 2 (nothing should fire):");
  const secondSweep = await ekman.sweep();
  console.log(`    ${secondSweep} instances escalated`);
  check(
    secondSweep === 0 && escalations === 3,
    `the constraint fired again on a second sweep (${escalations} total)`
  );

  banner("3. Ask again");

  const after = await handle.query({ state: "deploying", olderThan: "5m" });
  console.log(
    `  still stuck: ${after.instances.map((m) => m.key).join(", ") || "(none)"}`
  );
  check(
    keysOf(after) === "deployments:wedged-3",
    `expected only the one that chose to wait, got ${keysOf(after)}`
  );

  const healthy = await handle.query({ state: "live" });
  check(
    healthy.instances.length === HEALTHY.length,
    `the healthy deployments were disturbed: ${healthy.instances.length} of ${HEALTHY.length} still live`
  );
  console.log(
    `  untouched:   ${HEALTHY.length} deployments still live, never swept, never escalated`
  );

  // The escalation is in the same per-key stream as the transitions, so "what happened to
  // this one" needs no second system.
  const { events } = await handle.history("wedged-1");
  console.log("\n  wedged-1's stream:");
  for (const event of events) {
    console.log(
      `    ${event.type.padEnd(11)} ${describe(event)}  (seq ${event.seq})`
    );
  }

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

/** One readable line per stream event, whatever kind it is. */
function describe(event: EkmanEvent): string {
  if (event.type === "transition") {
    return `${event.from ?? "(new)"} -> ${event.to}`;
  }
  if (event.type === "violation") {
    return `${event.constraint.kind}:${event.constraint.name}  ${event.reason}`;
  }
  return event.type;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
