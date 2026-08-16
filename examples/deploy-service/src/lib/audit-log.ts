/**
 * An audit sink that writes every committed event to a JSONL file.
 *
 * In a real service this is Kafka, or an append-only table in a different database from
 * the one the store uses. The shape of the code does not change: take an event, put it
 * somewhere else, and never make the commit wait for you.
 *
 * If this file's disk fills up, deployments keep deploying. The runtime retries delivery a
 * bounded number of times and then reports `audit.failed` in telemetry. That is the whole
 * contract: an audit outage is a monitoring problem, not a write outage.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditSink } from "ekman";
import { config } from "./config";

const path = join(config.dataDir, "audit.jsonl");

export const auditLog: AuditSink = {
  name: "audit-log",
  deliver: async (event) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  },
};
