/**
 * A small HTTP server. No framework, because the framework is not the point.
 *
 * The one piece worth reading is `STATUS`. Every failure the runtime produces carries a
 * stable code, so mapping outcomes onto HTTP is a lookup table rather than a pile of
 * string matching, and a client gets an answer it can act on: 409 means this will never
 * work, 503 means try again shortly.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isEkmanError } from "ekman";

export interface RequestContext {
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: () => Promise<Record<string, unknown>>;
}

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export interface Route {
  readonly method: string;
  /** Path pattern with `:name` segments, e.g. `/deployments/:id/events`. */
  readonly path: string;
  readonly handle: (ctx: RequestContext) => Promise<Reply> | Reply;
}

/** A request-shape problem, as opposed to a domain one. Never reaches the runtime. */
export class BadRequest extends Error {}

export function json(
  status: number,
  body: unknown,
  headers?: Record<string, string>
): Reply {
  return headers === undefined ? { status, body } : { status, body, headers };
}

/**
 * Runtime error codes onto HTTP status codes.
 *
 * The distinction that matters to a caller is retryable versus not. A constraint violation
 * will be violated again in exactly the same way, so it is a 409 and the client should
 * stop. An inbox overflow is this instant only, so it is a 503 with `Retry-After`.
 */
const STATUS: Record<string, number> = {
  INVALID_KEY: 400,
  UNKNOWN_ENTITY: 404,
  UNKNOWN_STATE: 409,
  UNKNOWN_TRIGGER: 422,
  CONSTRAINT_VIOLATED: 409,
  INBOX_OVERFLOW: 503,
  TRIGGER_DROPPED: 503,
  MEMORY_EXHAUSTED: 503,
  HANDLER_TIMEOUT: 504,
  STORE_UNAVAILABLE: 503,
  STORE_CONFLICT: 409,
  HANDLER_FAILED: 500,
};

const RETRYABLE = 503;

export function replyForError(error: unknown): Reply {
  if (error instanceof BadRequest) {
    return json(400, { error: "bad_request", message: error.message });
  }
  if (!isEkmanError(error)) {
    return json(500, { error: "internal", message: String(error) });
  }

  const status = STATUS[error.code] ?? 500;
  const body: Record<string, unknown> = {
    error: error.code,
    message: error.message,
  };
  if (error.key !== undefined) {
    body.key = error.key;
  }

  return status === RETRYABLE
    ? json(status, body, { "retry-after": "1" })
    : json(status, body);
}

export function createApp(routes: readonly Route[]): Server {
  return createServer((req, res) => {
    handle(routes, req, res).catch((error: unknown) => {
      send(res, replyForError(error));
    });
  });
}

async function handle(
  routes: readonly Route[],
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = split(url.pathname);

  for (const route of routes) {
    if (route.method !== req.method) {
      continue;
    }
    const params = match(split(route.path), segments);
    if (params === undefined) {
      continue;
    }

    try {
      // biome-ignore lint/performance/noAwaitInLoops: at most one route matches, and this returns immediately after
      const reply = await route.handle({
        params,
        query: url.searchParams,
        body: () => readJson(req),
      });
      send(res, reply);
    } catch (error) {
      send(res, replyForError(error));
    }
    return;
  }

  send(
    res,
    json(404, { error: "no_route", message: `${req.method} ${url.pathname}` })
  );
}

function split(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/** Params if the pattern matches, undefined if it does not. */
function match(
  pattern: readonly string[],
  actual: readonly string[]
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) {
    return;
  }

  const params: Record<string, string> = {};
  for (const [i, expected] of pattern.entries()) {
    const got = actual[i] ?? "";
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(got);
    } else if (expected !== got) {
      return;
    }
  }
  return params;
}

async function readJson(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new BadRequest("body is not valid JSON", { cause: error });
  }
}

function send(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, {
    "content-type": "application/json",
    ...reply.headers,
  });
  res.end(`${JSON.stringify(reply.body, null, 2)}\n`);
}
