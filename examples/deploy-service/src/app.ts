/**
 * The route table, assembled in one place.
 *
 * Separate from `main.ts` so the smoke test can start the same application on an ephemeral
 * port without also starting the queue consumer and the signal handlers.
 */

import type { Server } from "node:http";
import { deploymentRoutes } from "./api/routes/deployments";
import { opsRoutes } from "./api/routes/ops";
import { createApp } from "./api/server";

export const routes = [...deploymentRoutes, ...opsRoutes];

export function buildServer(): Server {
  return createApp(routes);
}
