/**
 * A small HTTP server. No framework, because the framework is not the point.
 *
 * The one piece worth reading is `STATUS`. Every failure the runtime produces carries a
 * stable code, so mapping outcomes onto HTTP is a lookup table rather than a pile of
 * string matching. The code goes out in the body as well, because the status alone does
 * not say whether sending again can help: two codes can share one and differ on that.
 */

import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isEkmanError } from "ekman";
import { config } from "../lib/config";

export interface RequestContext {
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
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

/** A body past the configured limit. It was not buffered, and it is not parsed. */
export class PayloadTooLarge extends Error {}

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
 * A status says what kind of refusal it was, not whether to try again. A constraint
 * violation and a store conflict are both 409, and only the conflict is worth sending
 * again. A client that has to decide reads the `error` code in the body.
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
  STORE_FULL: 503,
  STORE_UNAVAILABLE: 503,
  STORE_CONFLICT: 409,
  KEY_BUSY: 409,
  COMMIT_FENCED: 409,
  RUNTIME_CLOSED: 503,
  HANDLER_FAILED: 500,
};

const RETRYABLE = 503;
const BEARER = /^bearer +(.+)$/i;
const INTERNAL = 500;

/**
 * Turn a failure into a response.
 *
 * A 500 carries a fixed message. Its real one is a handler's own error or something
 * nobody anticipated, and either can hold details that belong in this service's logs
 * rather than in a client's hands, so it is logged here and not echoed.
 */
function replyForError(error: unknown): Reply {
  if (error instanceof BadRequest) {
    return json(400, { error: "bad_request", message: error.message });
  }
  if (error instanceof PayloadTooLarge) {
    return json(413, { error: "payload_too_large", message: error.message });
  }
  if (!isEkmanError(error)) {
    console.error(error);
    return json(INTERNAL, { error: "internal", message: "internal error" });
  }

  const status = STATUS[error.code] ?? INTERNAL;
  if (status === INTERNAL) {
    console.error(error);
  }
  const body: Record<string, unknown> = {
    error: error.code,
    message: status === INTERNAL ? "internal error" : error.message,
  };
  if (error.key !== undefined) {
    body.key = error.key;
  }

  return status === RETRYABLE
    ? json(status, body, { "retry-after": "1" })
    : json(status, body);
}

/**
 * Gate a route that changes things on an operator token.
 *
 * Returns the refusal to send, or nothing when the caller may go on. This stands in for
 * whatever authentication a real deployment already has: a session, mutual TLS, a gateway
 * in front. The part worth copying is the shape, which is that a route able to delete
 * state checks who is asking before it does anything else, and that with no token
 * configured the route is off, not open.
 */
export function requireOperator(ctx: RequestContext): Reply | undefined {
  if (config.opsToken === "") {
    return json(503, {
      error: "ops_disabled",
      message: "set OPS_TOKEN to enable operator routes",
    });
  }

  // The scheme name is case-insensitive and may be followed by more than one space, so it
  // is parsed off and only the token is compared.
  const [, token = ""] = BEARER.exec(ctx.headers.authorization ?? "") ?? [];
  const presented = Buffer.from(token);
  const expected = Buffer.from(config.opsToken);
  // Compared in constant time, and only once the lengths match, which is all
  // `timingSafeEqual` accepts.
  const allowed =
    presented.length === expected.length &&
    timingSafeEqual(presented, expected);

  return allowed
    ? undefined
    : json(
        401,
        { error: "unauthorized", message: "operator token required" },
        { "www-authenticate": "Bearer" }
      );
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

  // Refused on its declared length, before routing, so the limit holds for every route
  // and not only the ones that go on to read a body. A body that does not declare its
  // length is counted as it is read, in `readBody`; a route that never reads one never
  // buffers it.
  if (Number(req.headers["content-length"] ?? 0) > config.maxBodyBytes) {
    // What is still arriving is read and dropped. Closing the socket under a client that
    // is mid-send resets it, and the client then sees a broken connection and no status.
    req.resume();
    send(res, replyForError(tooLarge()));
    return;
  }

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
        headers: req.headers,
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

function tooLarge(): PayloadTooLarge {
  return new PayloadTooLarge(
    `the request body is larger than ${config.maxBodyBytes} bytes`
  );
}

/**
 * Read a request body, up to the configured limit and no further.
 *
 * Counted as it arrives. A body is somebody else's choice of size, and buffering all of it
 * before looking is how one request takes a process down. Past the limit nothing more is
 * kept: the rest is read and thrown away, so the client can read the reply and is not cut
 * off mid-send.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let refused = false;

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (refused) {
        return;
      }
      if (received > config.maxBodyBytes) {
        refused = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const raw = (await readBody(req)).toString("utf8");
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
