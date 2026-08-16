/**
 * Durability: the runtime refuses what it cannot deliver.
 *
 * Run with `npm run demo:durability`.
 *
 * A state runtime has exactly one unforgivable lie, and it is claiming durability it does
 * not have. Everything else is a bug you find; that one is a bug you find during an
 * incident, from the fact that the data is gone.
 *
 * So every store declares what it can actually do, and those declarations are load-bearing
 * rather than decorative. A configuration those declarations cannot satisfy is refused at
 * construction, with a message naming the specific thing that does not add up, instead of
 * being quietly adjusted into something that starts up and under-delivers.
 *
 * Four refusals below, each a real mistake somebody makes. Then the configuration they
 * were protecting: a layered stack, a commit, and a second runtime built from nothing but
 * the directory on disk.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EkmanConfig } from "ekman";
import {
  defineEntity,
  Ekman,
  fileStore,
  isEkmanError,
  memoryStore,
  transitionTo,
} from "ekman";

const orders = defineEntity("orders", {
  initial: "open",
  values: { total: 0, customer: "" },
  states: {
    open: (order, trigger) =>
      transitionTo("paid", {
        ...order.values,
        total: trigger.total as number,
        customer: trigger.customer as string,
      }),
    paid: (order) => transitionTo("paid", order.values),
  },
});

const dir = mkdtempSync(join(tmpdir(), "ekman-durability-"));

async function main(): Promise<void> {
  capabilities();
  refusals();
  await theConfigurationThoseProtect();

  console.log(
    `\n${"=".repeat(78)}\n` +
      "Every one of those refusals could have been a default instead. Empty list could\n" +
      "have meant memory-only. A budget with nowhere to evict to could have meant an\n" +
      "unlimited budget. Each of those would have started up fine and lost data later,\n" +
      "which is the difference between a configuration error and an incident.\n"
  );
}

/** What the two shipped adapters say about themselves. */
function capabilities(): void {
  banner("What a store declares");

  const stores = [memoryStore(), fileStore(dir)];
  console.log("  name       durability  conditionalAppend  multiWriter  scan");
  for (const store of stores) {
    const caps = store.capabilities;
    console.log(
      `  ${store.name.padEnd(10)} ${caps.durability.padEnd(11)} ${String(caps.conditionalAppend).padEnd(18)} ${String(caps.multiWriter).padEnd(12)} byState=${caps.scan.byState} olderThan=${caps.scan.olderThan}`
    );
  }

  console.log(
    "\n  `multiWriter: false` on the file store is the honest one. Its conditional append\n" +
      "  is genuinely atomic inside one process and worth nothing across two, so it says\n" +
      "  so, and a configuration that needed otherwise can be refused exactly rather than\n" +
      "  guessed at."
  );
}

/** Four configurations that are recognized, unsatisfiable, and therefore refused. */
function refusals(): void {
  banner("Four configurations that are refused rather than adjusted");

  refused("store: []", { entities: [orders], store: [] });

  refused("an ephemeral layer claiming authority over a durable one", {
    entities: [orders],
    store: [memoryStore({ authority: true }), fileStore(dir)],
  });

  refused("maxBytes: 0 with nowhere to load from", {
    entities: [orders],
    memory: { maxBytes: 0 },
  });

  refused("a bounded budget that would have to discard what it evicts", {
    entities: [orders],
    memory: { maxBytes: 64 * 1024, eviction: { policy: "lru" } },
  });
}

/** The stack all of that was protecting. */
async function theConfigurationThoseProtect(): Promise<void> {
  banner("And the configuration those were protecting");

  // Fastest first. The runtime picks the last durable layer as the commit authority, so
  // the file store owns the truth and the memory layer is a cache in front of it.
  const first = new Ekman({
    entities: [orders],
    store: [memoryStore(), fileStore(dir)],
  });

  const committed = await first.entities.orders.send("a1", {
    type: "pay",
    total: 4200,
    customer: "amy",
  });
  console.log(
    `  committed: ${committed.state} seq=${committed.seq} total=${committed.values.total} customer=${committed.values.customer}`
  );

  // No shutdown, no flush, no ceremony. The commit resolved, so it is already durable.
  await first.close();

  const second = new Ekman({
    entities: [orders],
    store: [memoryStore(), fileStore(dir)],
  });

  // Nothing is resident in the new runtime until something asks for it.
  console.log(
    `  a fresh runtime, resident instances: ${second.memoryUsage.instances}`
  );

  const { events, complete, sources } =
    await second.entities.orders.history("a1");
  const restored = await second.entities.orders.send("a1", { type: "touch" });

  console.log(
    `  read back: ${restored.state} seq=${restored.seq} total=${restored.values.total} customer=${restored.values.customer}`
  );
  console.log(
    `  its stream: ${events.length} events, complete=${complete}, from [${sources.join(", ")}]`
  );

  check(
    restored.values.total === 4200 && restored.values.customer === "amy",
    "the values did not survive the restart"
  );
  check(
    restored.seq === committed.seq + 1,
    `the sequence did not continue: committed at ${committed.seq}, came back and moved to ${restored.seq}`
  );
  check(complete, `the history was not complete: ${complete}`);

  console.log(
    "\n  The second runtime shares nothing with the first but a directory. It picked up\n" +
      "  the sequence where the first left it, which is only possible because the layer\n" +
      "  that owned the truth was the durable one. That is the arrangement the second\n" +
      "  refusal above exists to protect."
  );

  await second.close();
}

/** Build a runtime that should not build, and show what it said. */
function refused(label: string, config: EkmanConfig): void {
  const error = caught(() => new Ekman(config));

  if (error === undefined) {
    throw new Error(`${label} was accepted, and should not have been`);
  }
  if (!(isEkmanError(error) && error.code === "INVALID_CONFIG")) {
    throw new Error(`${label} was refused, but not as INVALID_CONFIG`, {
      cause: error,
    });
  }

  console.log(`  ${label}\n    ${error.code}: ${wrap(error.message)}\n`);
}

/** Whatever a call threw, or undefined if it threw nothing. */
function caught(build: () => unknown): unknown {
  let thrown: unknown;
  try {
    build();
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

/** Keep a long refusal message readable in a terminal. */
function wrap(message: string): string {
  const width = 72;
  const lines: string[] = [];
  let line = "";
  for (const word of message.split(" ")) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines.join("\n    ");
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function banner(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
