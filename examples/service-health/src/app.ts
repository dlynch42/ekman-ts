/**
 * The application, assembled in one place.
 *
 * Separate from `main.ts` so the smoke test can start the same routes on an ephemeral
 * port without also starting the prober and the signal handlers.
 */

import type { Server } from "node:http";
import { routes } from "./api/routes";
import { createApp } from "./api/server";

export function buildServer(): Server {
  return createApp(routes);
}
