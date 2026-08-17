# deploy-service

A small service that tracks deployments, built the way you would actually build one. It
exists to answer the question the README cannot: **where does this go in my codebase?**

Two entities, an HTTP API, a queue consumer, and one runtime shared by both. No framework,
no dependencies beyond Ekman itself.

```
npm run example:api      # start it, poke it with curl
npm run example:smoke    # boot it on an ephemeral port, drive it end to end, assert
```

## The layout

```
src/
  entities/
    deployment.ts      states, handlers, constraints, per-state execution policy
    incident.ts        opened / acknowledged / resolved, deliberately idempotent
  lib/
    config.ts          environment, read once at startup
    runtime.ts         the single new Ekman({...}) for the process
    metrics.ts         telemetry sink -> counters behind /ops/metrics
    audit-log.ts       audit sink -> JSONL on disk
    reactions.ts       audit sink that opens an incident when a deployment fails
  api/
    server.ts          node:http, a small router, error codes -> status codes
    routes/
      deployments.ts   create, send an event, read one, read its history
      ops.ts           /ops/stuck, /ops/incidents, /ops/sweep, /ops/prune, /ops/metrics
  workers/
    consumer.ts        a fake queue that redelivers, bursts, and sends a typo
  app.ts               the route table
  main.ts              starts the server and the consumer, handles shutdown
smoke.ts               the end-to-end test that keeps this example honest
```

## What each layer is for

**`entities/` is where the domain lives.** A deployment's states, its handlers, its
transition graph, its guard, its invariant, its time-in-state bound, and the execution
policy for the one state that talks to an external API are all in one file, next to each
other. Nothing in there knows about HTTP or about the queue.

**`lib/runtime.ts` is the file to copy.** The runtime is constructed once, at startup, and
every decision that would otherwise be made implicitly and repeatedly, where state is
stored, how much memory it may use, how deep a queue may get, how many times a handler is
retried, how often time bounds are checked, is one line in one block.

**`api/routes/` handlers do almost nothing.** Read the request, send a trigger, shape the
answer. No locks, no transactions, no read-modify-write, no retry loops. Two requests for
the same deployment arriving at the same instant need nothing here to be safe, because the
per-key inbox already serialized them.

**`workers/consumer.ts` proves a transport is not special.** It drives the same runtime the
API drives. A message and an HTTP request are both just triggers, and if they arrive for
the same deployment at the same moment, the key is what orders them.

## Things worth reading the code for

**Error codes become status codes.** Every failure the runtime raises carries a stable
code, so `api/server.ts` maps them in a lookup table rather than by matching on message
strings. The distinction that matters to a caller is retryable or not:

| Runtime code | HTTP | Why |
|---|---|---|
| `CONSTRAINT_VIOLATED` | 409 | Will be violated again identically. Stop. |
| `UNKNOWN_TRIGGER` | 422 | The producer sent something never agreed to. |
| `INBOX_OVERFLOW` | 503 + `Retry-After` | This instant only. Try again shortly. |
| `HANDLER_TIMEOUT` | 504 | The attempt was abandoned and fenced. |

`workers/consumer.ts` makes the same distinction differently: retryable codes stay on the
queue, the rest go to a dead-letter queue instead of being redelivered forever.

**The queue consumer's backlog misbehaves on purpose.** It redelivers a `deploy` for a
deployment that has already gone live, and it sends one message with a typo in its type.
The handler that receives the redelivery is naive: it just applies the message. The
transition graph is what refuses it. The typo never reaches a handler at all.

**An incident is opened by an audit sink, not by a handler.** `lib/reactions.ts` explains
why at length, and the short version is that a handler returns one result for one instance,
so a reaction to a commit belongs after the commit. The cost is that delivery is
at-least-once, which is exactly why every handler in `entities/incident.ts` is idempotent.

**The ops endpoints pass `complete` and `reasons` through.** An operator acting on "nothing
is stuck" needs to know whether that was the whole answer.

**Retention is application code, not a runtime setting.** `POST /ops/prune` is a `query` for
rolled-back deployments older than `RETAIN_FOR`, followed by `ekman.forget` on each one.
Nothing inside the runtime decides when a deployment stops mattering, because that is a
product question. The route supports `dryRun=true` for the same reason, and reports the keys
it skipped because a handler was running rather than treating a busy key as a failure.

## Try it

```bash
npm run example:api
```

```bash
# create a deployment
curl -XPOST localhost:3000/deployments/billing-api \
     -H 'content-type: application/json' \
     -d '{"service":"billing-api","region":"us-east-1","version":"1.0.0"}'

# the transition graph refuses a redelivered deploy for something already live
curl -i -XPOST localhost:3000/deployments/payments-api \
     -H 'content-type: application/json' \
     -d '{"service":"payments-api","region":"us-west-2","version":"2.4.1"}'

# a trigger type the entity never declared
curl -i -XPOST localhost:3000/deployments/billing-api/events \
     -H 'content-type: application/json' -d '{"type":"succeded"}'

# what is stuck, and for how long
curl 'localhost:3000/ops/stuck?state=deploying&olderThan=0ms'

# everything that happened to one deployment: transitions, refusals, violations, reloads
curl localhost:3000/deployments/billing-api/history

# incidents opened in reaction to failed deployments
curl localhost:3000/ops/incidents

# runtime telemetry, which never appears in any deployment's history
# `memory` is resident bytes; `storage` is bytes on disk, which eviction never frees
curl localhost:3000/ops/metrics

# what a prune would delete, without deleting it
curl -XPOST 'localhost:3000/ops/prune?olderThan=0ms&dryRun=true'
```

Then **stop the process and start it again**, and read `billing-api` back. It is still
there, in its exact state, with its full history, because the commit authority is a durable
store rather than the process.

## Configuration

Everything is environment-driven, with defaults in `src/lib/config.ts`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `.ekman/logs/deploy-service` | Where the transition log lives. Gitignored; delete it to start clean |
| `MEMORY_BYTES` | `262144` | Resident memory budget. Deliberately small, so eviction is observable |
| `INBOX_CAPACITY` | `32` | Triggers that may wait behind the one being handled, per deployment |
| `STUCK_AFTER_MS` | `300000` | How long a deployment may sit in `deploying` before it is escalated |
| `SWEEP_MS` | `1000` | How often time bounds are checked |
| `STORAGE_BYTES` | `67108864` | Bytes the transition logs may occupy before new deployments are refused |
| `RETAIN_FOR` | `30d` | How long a rolled-back deployment is kept before `POST /ops/prune` may remove it |
| `DEPLOY_MAX_ATTEMPTS` | `4` | Attempts for the state that calls the deploy API |
| `DEPLOY_TIMEOUT_MS` | `5000` | Per-attempt timeout for that state |

`.ekman` is resolved from the nearest `package.json` above the working directory, so the
service finds the same state whether you start it from the repository root or from
`examples/deploy-service`.

Set `STUCK_AFTER_MS=2000` and leave a deployment in `deploying` to watch the escalation
arrive as a trigger and an incident open behind it.
