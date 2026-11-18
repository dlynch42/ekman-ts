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
truth: the last durable one. The rest are caches.

A commit goes to the authority, and resolves there. The caches are written afterwards, in order
per key, and no commit, `history()` or `close()` ever waits for one. A cache write still queued
when the runtime closes is dropped.

When an instance that is not resident is loaded, the caches are asked first, fastest first, and
the first that holds the key answers. If none does, the authority answers and the caches are
filled from it, so the next load of that key is a cache's. This is the one read a cache serves.
A load that arrives while writes for its key are still on their way to the caches does not wait
for them either: the authority answers it, so a cache that is slow, or never answers, costs the
key its cache and nothing else.
`history()` and `query()` always read the authority, because a cache holds the state of a key
and not necessarily its whole stream.

A cache is only read while it holds exactly what the authority accepted for a key, or nothing:

- A cache write that fails is reported through [telemetry](./telemetry.md) as
  `store.cacheFailed`, without failing the commit, and the key is deleted from that cache. Its
  next read is a miss, and the cache is filled again from the authority.
- If the key cannot be deleted either, that cache is neither read nor written for that key again,
  until a `forget` of the key succeeds there.
- A cache that fails to answer is treated as a miss and reported the same way.
- A cache that starts empty, as a memory layer does after every restart, is filled as instances
  are loaded. Nothing fails while it catches up.

Two things follow from a cache being read first:

- **A cache layer has to be able to stay honest.** One that does not declare a conditional
  append and `forget` is refused at startup with `INVALID_CONFIG`. So is an authority behind a
  cache that does not declare a conditional append, since refusing a commit built on a stale
  answer is its job.
- **Nothing else may write the authority.** A cache cannot know what another process committed,
  so a stack with a cache layer is refused under `coordination: "multi"`. If something outside
  the runtime does move a key, the cache can answer one load with the older state. The commit
  built on it is refused by the authority with `STORE_CONFLICT`, the key is cleared from the
  caches, and the next trigger loads from the authority.

A `"memory"` cache keeps every event it is sent, for every key, for the life of the process, and
none of that is counted by the [memory budget](./memory.md). It trades memory for skipping a disk
read when an evicted instance comes back. If the budget is the point, leave it out and use
`store: "file"` alone.

An `instance.restored` event says what the layer that answered held: `from: "snapshot"` when a
cache was filled from the authority and has had few events since, whatever the authority's own
log looks like.

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

The default directory depends on where the process was started. `.ekman/logs/` is placed beside
the nearest `package.json` at or above the **working directory**, and in the working directory
itself when there is none. Starting the same service from somewhere else can therefore find a
different, empty store:

- A service unit with `WorkingDirectory=/` and no `package.json` above it writes to `/.ekman/logs`.
- In a monorepo, starting from a package directory and starting from the repository root resolve
  to two different directories.
- A bundled single-file build or a container image often has no `package.json` beside it.
- On a read-only filesystem the directory cannot be created, and the runtime refuses to start
  with `INVALID_CONFIG`.

In production, name the path with `dir` and do not take the default.

One log per key, in a directory per entity:

```
.ekman/logs/orders/orders%3Aa-1.jsonl
```

### What a commit guarantees

A commit that resolved has been written to its log through the operating system. That survives
the process ending, by a crash or a kill. It does not survive the machine losing power before
the system flushes its cache: there is no fsync per commit.

### Open logs

A log being written to is kept open, so a commit is one write. Up to 256 are open at once, and
past that the one least recently written to is closed and opened again when it is next needed.
Change the number for a process with a tight descriptor limit, and read how many are open now:

```ts
const store = fileStore("/var/lib/app", { maxOpenLogs: 64 });
store.openLogs; // never more than 64
```

`ekman.close()` closes them. The files belong to the store while it runs: removing one from
outside leaves the store writing to a file nobody can reach, so delete through `forget`.

### File names

A file is named for its key, with every byte percent-escaped except lowercase ASCII letters,
digits, `-` and `_`. Uppercase letters are escaped as well: `orders:ABC` is stored as
`orders%3A%41%42%43.jsonl`. Keys are case-sensitive and many filesystems are not (macOS and
Windows by default, and most network shares), so two keys that differ only in case have to
differ in more than case on disk to stay two instances. The key itself is unchanged inside the
file, and it is the key, never the file name, that appears in history and queries.

Versions before this escaped less, leaving uppercase letters and `.` as they were. Files named
that way are renamed the first time the store uses their entity's directory, with no step for
you to run. If a key has a file under both schemes, which takes moving between versions and
back to produce, the store refuses that entity's directory with `STORE_UNAVAILABLE` and changes
neither file. It refuses the same way, naming the key, when an earlier file belongs to a key
whose name under the current scheme is too long to be a file name. Move that file out of the
store to carry on without the key.

A name has to fit in one path component, so the file store refuses a key whose escaped name is
longer than 240 bytes with `INVALID_KEY`. A key of lowercase letters and digits reaches that at
240 characters; each uppercase letter, `:` or `.` counts as three, and other characters as three
or more. A store used directly also refuses a key holding half of a surrogate pair, which the
runtime never lets through.

### Permissions

The store creates its directories as `0o700` and its files as `0o600`: readable by the user
the process runs as and nobody else. To share them with a group, say so:

```ts
store: { kind: "file", mode: { file: 0o640, dir: 0o750 } }
```

The mode is applied when something is created. Files that already exist keep the permissions
they have until a snapshot or a compaction replaces them.

### Compaction

Each log compacts once it passes 5MB. The events already folded into a snapshot are dropped, so
current state and replay are untouched and only `history()` shortens. When it does, `history()`
reports itself incomplete rather than presenting a truncated stream as a whole one.

A log that passes its limit is compacted shortly after the commit that crossed it, on a later
turn of the event loop, and not inside that commit: folding a log means rewriting it, and the
sender who happened to cross the limit should not wait for that. A caller that never gives the
event loop a turn, such as a loop of awaited sends and nothing else, gets a backstop instead: a
log that reaches twice its limit is compacted in the commit that got it there. So a log can run
to twice its limit, and no further. `ekman.close()` does any compaction still waiting.

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
the store instead, until the next pass of the same kind succeeds:

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

The file store reads the snapshot first and then only the events after it. The first load of a
key in a process parses its whole log, which is also when a torn last line is trimmed. After
that it remembers where the events past the snapshot begin, so an instance that is evicted and
reloaded over and over pays for what it committed since it was last loaded, not for its whole
history.

The reload is recorded in the per-key stream as a `restored` event, carrying the sequence it was
restored *to* without advancing it. That is what makes a gap in a stream explicable rather than
mysterious. It is deliberately not persisted; writing a restore back to the store would turn
every read into a write.

## Writing a store adapter

A store is anything that implements `Store`. Import the type, the shared helpers and the
contract from `ekman/store`, declare your capabilities honestly, since the runtime refuses a
configuration your declaration cannot satisfy, and run `storeContract` in your own tests:

```ts
import { describe, expect, it } from "vitest";
import { storeContract } from "ekman/store";

describe("my store", () => {
  storeContract("mine", () => myStore(), { durable: true }, { it, expect });
});
```

The contract takes the `it` and `expect` your suite already uses, so it depends on no test
framework of its own. An adapter that passes can be put in a stack without reading the
runtime.

## Next

- [Memory and eviction](./memory.md) for the other budget: resident bytes rather than disk bytes.
- [Queries and history](./queries.md) for reading any of this back.
