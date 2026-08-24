# Concepts

[Back to the docs index](./README.md)

```ts
await ekman.send("deployments:abc123", { type: "deploy", region: "us-east-1" });
```

That line contains most of the model. `deployments` names an entity, `abc123` identifies one
instance of it, and the trigger is delivered to that instance's inbox rather than applied to it.

## The key is the unit of everything

A key is `<entity>:<segment>[:<segment>]*`, and its first segment names the entity. Keys are
human-readable on purpose: `deployments:abc123` is what you type into a query, what appears in
history, and what you page someone with at 3am.

One key owns one instance's state, its values, its inbox ordering, its resident memory, its
place in persistence, its sequence numbering, and its history. Nothing is shared across keys,
which is why nothing has to be locked across them.

```ts
import { buildKey, parseKey } from "ekman";

buildKey("deployments", "abc123");     // "deployments:abc123"
parseKey("deployments:abc123");        // { key, entity: "deployments", segments: ["abc123"] }
```

## What happens when a trigger arrives

```
trigger -> instance lookup (load or initialize)
        -> per-key bounded FIFO inbox
        -> dispatch on the current committed state
        -> handler, under an execution policy
        -> result: transitionTo | stay | fail
        -> constraints
        -> commit (state, values, sequence and event, atomically)
        -> persistence, then async audit fan-out
        -> memory accounting
        -> next queued trigger
```

Four properties of that pipeline are worth stating outright, because a plausible-looking
implementation gets them wrong.

**A trigger never mutates state.** Only a committed handler result does. Time-in-state
escalations and constraint escalations are delivered as triggers, not as writes, so every
state change is attributable to a piece of your code rather than to the runtime.

**Dispatch happens on the state at dequeue time,** never the state observed when the trigger
was enqueued. A trigger that waited behind three others is handled by whatever state those
three left behind.

**One handler runs per key at a time.** Retries keep the key occupied, so a queued trigger
cannot slip past an attempt that is still in flight.

**Unknown is never silent.** No handler for the current state, or a trigger type the entity
never declared, goes to the entity's unknown policy. That policy has no silent-discard
setting; unconfigured means refuse and record.

## Serialization is per key and nowhere else

This is what lets a handler read, `await` something slow, and write back without checking
whether anyone else is mid-flight:

```ts
pending: async (order, trigger) => {
  const receipt = await chargeCard(order.values.total);   // nothing else runs for this key
  return transitionTo("paid", { ...order.values, receipt });
},
```

Handlers for *different* keys overlap freely. A runtime that serialized globally would get the
same right answer and be useless, so both halves matter: at most one handler per key, and as
many concurrent handlers overall as there are busy keys.

```
npm run demo:concurrency    # 5,000 increments across 200 keys, 0 lost updates
```

## Domain state and runtime state are separate

`pending`, `deploying` and `paid` are yours. Busy, attempt count, queue depth and handler
duration are Ekman's. Runtime facts never appear as a domain state and never enter the per-key
event stream; they go to [telemetry](./telemetry.md). Your transition history stays domain-only,
which is what makes it readable a year later.

## Durability is configured, never implied

Omit `store` and nothing survives the process. That is a documented mode, not a degraded one.
Configure a store and commits are written before they are applied, so a `send()` that resolves
has already reached the commit authority. See [Durability](./durability.md).

## Next

- [Entities](./entities.md) for how to write one.
- [Ordering and the inbox](./ordering.md) for what happens when triggers arrive faster than they are handled.
