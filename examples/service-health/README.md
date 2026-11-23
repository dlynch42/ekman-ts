# service-health

[Back to the main README](../../README.md)

A small service that keeps track of the other services it depends on. Where
[`deploy-service`](../deploy-service) is shaped like a workflow, this one is shaped like
**memory**: each key is a dependency, its values are what has been observed about it, and its
state follows from those observations.

One entity, an HTTP API, a prober that feeds it, and one runtime shared by both. No framework,
no dependencies beyond Ekman itself.

```
npm run example:health         # start it, watch /map change
npm run example:health:smoke   # boot it on an ephemeral port, drive it end to end, assert
```

> **This directory is not a standalone project.** Its `import ... from "ekman"` resolves through
> the repository's `tsconfig.json` path alias, which maps `ekman` to `src/index.ts`, and both
> commands above are scripts in the repository root. To lift it into a project of your own,
> run `npm install ekman` there; nothing in the source needs to change.

## The layout

```
src/
  entities/
    service.ts         what is remembered, the handlers, the rule and the freshness bound
  lib/
    runtime.ts         the single new Ekman({...}) for the process
    config.ts          everything read from the environment, once
  api/
    server.ts          a small router; maps a refusal's code to a status
    routes.ts          record a probe, read a service, /map, /quiet
  workers/
    prober.ts          synthetic probes on an interval: the application's loop
  app.ts               the route table, so the smoke test can boot it alone
  main.ts              listen, start probing, shut down in order
smoke.ts               the whole thing, end to end, asserted
```

## Things worth reading the code for

**The handlers only record and decide.** `entities/service.ts` has three handlers. A probe
arrives and the handler returns `patch(...)` with what the probe taught: the failure count,
the latency, the error. It never compares the count with a threshold and never reads a clock.

**A rule turns memory into a proposal.** `rules: [{ in: "healthy", when: failures >= 3,
propose: "degraded" }]`. After the commit that makes the condition hold, the runtime sends the
service a `rule.matched` trigger carrying `propose`. The handler agrees with `transitionTo`.
It fires once, however long the failures continue.

**Silence is noticed by the runtime, because nothing else can.** A service that stops being
probed has no handler running to notice. `stale: [{ after, propose: "unreachable" }]` is
evaluated by the sweep, for services in memory and for ones only the store holds. A probe is
a commit, so a service that is being probed is never quiet, whatever the probes say.

**One call says where everything is.** `GET /map` is `services.map()`, with `complete` and
`reasons` passed straight through. `GET /quiet` is a query by `staleFor` with
`includeValues`, which is the freshness bound's own measurement asked on demand.

**The prober is not the runtime.** `workers/prober.ts` is a `setInterval` in application
code. Ekman does not probe anything. It remembers what it is told, and notices when it stops
being told.

**A request body cannot become a proposal.** `routes.ts` checks the body and builds a `probe`
and nothing else. The trigger types the rule and the bound deliver are only ever raised by the
runtime.

## Try it

```
npm run example:health

# where everything is; give it a few seconds, then a minute
curl localhost:3001/map

# one service: what is known, and every proposal made to it and why
curl localhost:3001/services/payments-api

# what has said nothing for ten seconds, with what was last known about each
curl 'localhost:3001/quiet?for=10s'

# record a probe of your own
curl -XPOST localhost:3001/services/my-api/probes \
     -H 'content-type: application/json' \
     -d '{"ok":false,"latencyMs":900,"error":"connection refused"}'
```

Then stop the process and start it again. Every service is where it was, with what was known
about it, and the clocks kept running: one that was last heard from before the restart is
proposed as `unreachable` on the first sweep after it.

## Configuration

| Variable | Default | What it sets |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to listen on. Loopback unless told otherwise |
| `DATA_DIR` | `.ekman/logs/service-health` | Where the file store writes |
| `MEMORY_BYTES` | `262144` | Resident memory budget |
| `LOG_BYTES` | `65536` | How large one service's log grows on disk before old events are folded into a snapshot. `0` keeps every event |
| `FAILURES_BEFORE_DEGRADED` | `3` | Failed probes in a row before the rule proposes `degraded` |
| `QUIET_AFTER_MS` | `60000` | Silence before the freshness bound proposes `unreachable` |
| `SWEEP_MS` | `5000` | How often the freshness bound is evaluated |
| `PROBE_MS` | `2000` | How often the built-in prober runs. `0` turns it off |
| `MAX_BODY_BYTES` | `16384` | Largest request body that is read |
