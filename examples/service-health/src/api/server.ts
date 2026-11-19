/**
 * A small HTTP layer: routes with one optional `:name` segment, JSON in and out.
 *
 * Deliberately not a framework. What matters about it is at the bottom: a failure from the
 * runtime carries a code, and the code picks the status, so a refused trigger is the
 * caller's 4xx and never an anonymous 500.
 */

import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { isEkmanError } from "ekman";
import { config } from "../lib/config";

export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

export interface RequestContext {
  /** The `:name` segment of the path, when the route has one. */
  readonly name: string;
  readonly query: URLSearchParams;
  /** The parsed JSON body. An empty object when the request had none. */
  readonly body: Record<string, unknown>;
}

export interface Route {
  readonly method: "GET" | "POST";
  /** Path segments. `:name` matches any one segment. */
  readonly path: string;
  readonly handle: (ctx: RequestContext) => Reply | Promise<Reply>;
}

export class BadRequest extends Error {}
class PayloadTooLarge extends Error {}

export const json = (status: number, body: unknown): Reply => ({
  status,
  body,
});

/** What each refusal means to an HTTP caller. Anything not listed is a 500. */
const STATUS: Record<string, number> = {
  INVALID_KEY: 400,
  UNKNOWN_TRIGGER: 400,
  CONSTRAINT_VIOLATED: 409,
  INBOX_OVERFLOW: 503,
  MEMORY_EXHAUSTED: 503,
  STORE_UNAVAILABLE: 503,
  RUNTIME_CLOSED: 503,
};

function replyForError(error: unknown): Reply {
  if (error instanceof BadRequest) {
    return json(400, { error: "bad_request", message: error.message });
  }
  if (error instanceof PayloadTooLarge) {
    return json(413, { error: "payload_too_large", message: error.message });
  }
  const status = isEkmanError(error) ? (STATUS[error.code] ?? 500) : 500;
  if (status === 500 || !isEkmanError(error)) {
    // Logged here and not echoed: a handler's own error can hold details that belong in
    // this service's logs and not in a client's hands.
    console.error(error);
    return json(500, { error: "internal", message: "internal error" });
  }
  return json(status, { error: error.code, message: error.message });
}

function match(route: Route, method: string, segments: readonly string[]) {
  const wanted = route.path.split("/").filter(Boolean);
  if (route.method !== method || wanted.length !== segments.length) {
    return;
  }
  let name = "";
  for (const [i, part] of wanted.entries()) {
    const given = segments[i] as string;
    if (part === ":name") {
      name = given;
    } else if (part !== given) {
      return;
    }
  }
  return { name };
}

/**
 * Read a request body, up to the configured limit and no further.
 *
 * Counted as it arrives, on the stream's own events. Past the limit nothing more is kept:
 * the rest is read and thrown away, so the client can finish sending and read the 413.
 * Leaving the stream early instead, as breaking out of a `for await` over it does,
 * destroys it, and the client sees a reset connection where the answer should be.
 */
function received(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (refused) {
        return;
      }
      if (size > config.maxBodyBytes) {
        refused = true;
        chunks.length = 0;
        reject(
          new PayloadTooLarge(
            `request body is over ${config.maxBodyBytes} bytes`
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const raw = await received(req);
  if (raw.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new BadRequest("body is not valid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequest("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function handle(
  routes: readonly Route[],
  req: IncomingMessage
): Reply | Promise<Reply> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return json(400, { error: "bad_request", message: "malformed path" });
  }

  for (const route of routes) {
    const matched = match(route, req.method ?? "GET", segments);
    if (matched !== undefined) {
      return serve(route, matched.name, url.searchParams, req);
    }
  }
  return json(404, { error: "not_found", message: "no such route" });
}

async function serve(
  route: Route,
  name: string,
  query: URLSearchParams,
  req: IncomingMessage
): Promise<Reply> {
  return route.handle({ name, query, body: await readBody(req) });
}

export function createApp(routes: readonly Route[]): Server {
  return createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(routes, req))
      .catch(replyForError)
      .then((reply) => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
  });
}
