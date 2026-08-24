# Memory and eviction

[Back to the docs index](./README.md)

```ts
const ekman = new Ekman({
  entities: [orders],
  memory: { maxBytes: 32 * 1024 * 1024, eviction: { policy: "lru", snapshotOnEvict: true } },
});
```

Memory is a budget you set, not a hope. This is a separate budget from
[retention](./durability.md#retention): `memory` is resident bytes in this process, `retention`
is bytes on disk. Evicting an instance frees the first and never the second.

## How an instance is accounted

Serialized UTF-8 byte length of **the key, the state name, and the values**, measured at commit.

Values are being serialized at that moment anyway, so this costs nothing extra on the path that
matters, and it is a number you can reason about because it is roughly what the instance costs to
persist. It is approximate as a measure of heap. It is exact and reproducible as a measure of
itself, which is the property that matters for a budget you can test against.

Supply your own basis if you need a different one:

```ts
memory: { maxBytes: 32 * 1024 * 1024, sizeOf: (values) => values.blob.byteLength },
```

`ekman.memoryUsage` reports `{ bytes, instances, maxBytes }` at any time.

## When the budget is full

| Policy | What happens |
|---|---|
| `lru` | Releases the coldest **idle** instances, snapshotting them on the way out. |
| `reject` | Refuses to materialize new instances with `MEMORY_EXHAUSTED` and leaves the resident ones working. |
| `none` | Measures and reports without acting. |

`none` is how you learn what your real working set is before enforcing a limit on it. Turn it on,
watch `memory.accounted` in [telemetry](./telemetry.md), then set a number you have evidence for.

## Eviction only touches idle instances

Idle means no active handler and an empty inbox. A commit in flight can never be thrown away, and
an instance only becomes evictable once its key goes idle.

```ts
eviction: { policy: "lru", snapshotOnEvict: true },
```

With a durable store configured, `snapshotOnEvict` writes a snapshot before releasing, so the
reload is a snapshot read rather than a full replay. `allowDiscard` governs whether an instance
may be released when there is no durable store to snapshot into, which would discard state
outright.

## Reload is transparent

A trigger for an evicted instance reloads it. Your application code cannot tell a resident
instance from one that just came back off disk: the same `send()`, the same result, the same
guarantees. The reload appears in the per-key stream as a `restored` event and in telemetry as
`instance.restored`.

```
npm run demo:memory-bound   # 5000 instances inside a 64 KB budget
```

## Next

- [Durability](./durability.md) for the disk-side budget.
- [Telemetry](./telemetry.md) for `memory.accounted`, `memory.refused` and `instance.evicted`.
