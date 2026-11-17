# Durability and stores

[Back to the docs index](./README.md)

```ts
const ekman = new Ekman({
  entities: [orders],
  store: ["memory", "file"],   // fastest first; the last durable layer owns the truth
});
```

Durability is configured, never implied. Omit `store` and you get a memory-only runtime: nothing
survives the process, and nothing pretends to. That is a documented mode, not a degraded one.

Configure one and commits are written before they are applied. A `send()` that resolves has
already reached the commit authority, so a crash a microsecond later loses nothing.

## Naming a store

Stores are named rather than constructed, so configuring one never means importing a database
client you are not using.

| Value | What it is |
|---|---|
| `"memory"` | An in-process event log. Fast, ephemeral. |
| `"file"` | Durable. Writes to `.ekman/logs/`. |
| `"none"` | Says out loud that this runtime keeps nothing. |
| `{ kind: "file", dir, retention }` | The file store with options. |
| a `Store` instance | An adapter Ekman does not ship. |

## Layering

```ts
store: ["memory", "file"],
```

Layers are listed fastest first. **Exactly one layer is the commit authority** and owns the
truth: the last durable one. The rest are caches, written after the fact, and a cache that fails
to write is reported through [telemetry](./telemetry.md) as `store.cacheFailed` without failing
the commit.

## Capabilities, and configurations that are refused

Every store declares what it can actually do: durable or ephemeral, conditional append, safe
across processes. The runtime **refuses configurations those declarations cannot satisfy** rather
than quietly under-delivering.

A store never reports durability it does not have. Asking for multi-runtime coordination on a
store whose conditional append is not atomic between processes is refused at startup, with a
message naming what was asked for and what the store can do.

```
npm run demo:durability     # four configurations the runtime refuses to start with
npm run demo:coordination   # what two runtimes over one directory actually do
```

## The file store

```ts
store: "file"                              // .ekman/logs/
store: { kind: "file", dir: "/var/lib/app" }
```

`.ekman/logs/` is found by walking up from the working directory to the nearest `package.json`,
so the same service finds the same state however it was launched. A deployment with no
`package.json` beside it, such as a bundled single-file build, should name the path explicitly
rather than take the default.

One log per key:

```
.ekman/logs/orders/orders%3Aa-1.jsonl
```

### Compaction

Each log compacts once it passes 5MB. The events already folded into a snapshot are dropped, so
current state and replay are untouched and only `history()` shortens. When it does, `history()`
reports itself incomplete rather than presenting a truncated stream as a whole one.

The snapshot and the shortened log are each written under a temporary name and renamed into
place, snapshot first, so a crash mid-compaction leaves the old files or the new ones.
Refusals and violations are never folded. A log that holds nothing else is left alone until
the next commit gives compaction something to fold.

### Failures

A filesystem failure (a full disk, a permission change, a corrupt log) surfaces as
`STORE_UNAVAILABLE`. The message names the store and the key, never a path; `store.dir` says
where the files are, and the original error is on `cause`.

A commit is reported as failed only if its line did not reach the log. Accounting and
compaction run after the write, and a failure there does not fail the commit. It is kept on
the store instead, until the next pass succeeds:

```ts
const store = fileStore("/var/lib/app");
store.lastHousekeepingError; // EkmanError | undefined
```

A write that fails partway can leave a fragment at the end of a log. The store trims it
before the next append to that key, so the fragment costs the one event that never landed.

## Retention

```ts
store: { kind: "file", dir, retention: { totalBytes: 500 * 1024 * 1024, policy: "reject" } },
```

`ekman.storageUsage` answers what the durable layers are holding. Give it a ceiling with
`retention: { totalBytes }` and it is measured against one. Add `policy: "reject"` and new
instances are refused with `STORE_FULL` rather than filling the disk. Instances the store
already holds keep committing.

**Deleting is never automatic.** `forget(key)` destroys an instance outright, and a retention
sweep is that plus the `query()` you already have:

```ts
const done = await ekman.query({ entity: "orders", state: "shipped", olderThan: "30d" });
for (const instance of done.instances) await ekman.forget(instance.key);
```

`await ekman.sweepStorage()` runs the store's own retention pass and reports what it did.

```
npm run demo:retention   # a log that compacts, a budget, and a delete you ask for
npm run demo:recovery    # commit, crash, restart, everything resumes
```

## Reload after eviction or restart

A trigger for an instance that is not resident reloads it transparently, from a snapshot where
one exists and by replaying the stream where one does not. Your code cannot tell a resident
instance from one that just came back off disk.

The reload is recorded in the per-key stream as a `restored` event, carrying the sequence it was
restored *to* without advancing it. That is what makes a gap in a stream explicable rather than
mysterious. It is deliberately not persisted; writing a restore back to the store would turn
every read into a write.

## Next

- [Memory and eviction](./memory.md) for the other budget: resident bytes rather than disk bytes.
- [Queries and history](./queries.md) for reading any of this back.
