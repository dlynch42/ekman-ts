/**
 * A queue consumer, driving the same runtime the HTTP API drives.
 *
 * This is the point of the file. A transport is not a special case: Kafka messages, HTTP
 * requests, timers and direct calls are all just triggers, and two of them arriving for
 * the same deployment at the same instant is handled by the per-key inbox rather than by
 * anything written here.
 *
 * The fake queue below does the three things real queues do and application code usually
 * forgets: it redelivers, it arrives out of order, and it bursts.
 */

import { isEkmanError } from "ekman";
import { deployments } from "../lib/runtime";

interface Message {
  readonly key: string;
  readonly trigger: Record<string, unknown> & { type: string };
  readonly note: string;
}

/** What the broker hands us. Note the duplicate and the late arrival. */
const DEPLOY_PAYMENTS = {
  type: "deploy",
  service: "payments-api",
  region: "us-west-2",
  version: "2.4.1",
} as const;

const BACKLOG: readonly Message[] = [
  {
    key: "payments-api",
    trigger: { ...DEPLOY_PAYMENTS },
    note: "normal",
  },
  {
    key: "payments-api",
    trigger: { type: "succeeded" },
    note: "normal",
  },
  {
    // The same deploy message the broker already delivered. The handler will try to apply
    // it, and the transition graph will refuse: a live deployment does not restart because
    // a queue repeated itself.
    key: "payments-api",
    trigger: { ...DEPLOY_PAYMENTS },
    note: "REDELIVERED, an hour later",
  },
  {
    key: "search-api",
    trigger: {
      type: "deploy",
      service: "search-api",
      region: "eu-west-1",
      version: "0.9.0",
    },
    note: "normal",
  },
  {
    key: "search-api",
    trigger: { type: "failed", reason: "health check never passed" },
    note: "normal",
  },
  {
    key: "search-api",
    trigger: { type: "succeded" },
    note: "TYPO in the producer",
  },
];

export interface ConsumerResult {
  readonly committed: number;
  readonly refused: number;
  readonly lines: readonly string[];
}

/**
 * Drain the backlog once.
 *
 * Sequential on purpose, the way a single-partition consumer is. Nothing here coordinates
 * with the HTTP API, and nothing needs to: if a request for `checkout-api` arrives while
 * this loop is mid-message, it queues behind it on that key alone.
 */
export async function drainOnce(): Promise<ConsumerResult> {
  const lines: string[] = [];
  let committed = 0;
  let refused = 0;

  for (const message of BACKLOG) {
    // biome-ignore lint/performance/noAwaitInLoops: one message at a time is the situation being modelled
    const outcome = await deliver(message);
    if (outcome.startsWith("committed")) {
      committed += 1;
    } else {
      refused += 1;
    }
    lines.push(
      `  ${message.key.padEnd(14)} ${message.trigger.type.padEnd(11)} ${outcome.padEnd(32)} ${message.note}`
    );
  }

  return { committed, refused, lines };
}

/**
 * Deliver one message and decide what to tell the broker.
 *
 * The error code is the whole reason this is short. `CONSTRAINT_VIOLATED` and
 * `UNKNOWN_TRIGGER` mean the message will never work, so it goes to a dead-letter queue
 * instead of being redelivered forever. `INBOX_OVERFLOW` means try again shortly, so it
 * stays on the queue. Without a stable classification this function is a pile of string
 * matching that gets it wrong.
 */
async function deliver(message: Message): Promise<string> {
  try {
    const result = await deployments.send(message.key, message.trigger);
    return `committed -> ${result.state}`;
  } catch (error) {
    if (!isEkmanError(error)) {
      throw error;
    }
    const disposition =
      error.code === "INBOX_OVERFLOW" || error.code === "STORE_UNAVAILABLE"
        ? "requeue"
        : "dead-letter";
    return `refused ${error.code} (${disposition})`;
  }
}
