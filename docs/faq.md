# Questions people ask first

[Back to the docs index](./README.md)

## How is this different from XState, or any state machine library?

A state machine library gives you dispatch and transitions for a machine you hold in your
hand. Which machine belongs to which thing, where its state lives between requests, what
happens when two triggers for it arrive at once, how much memory ten thousand of them take,
and how you ask which ones are stuck are left to you. Ekman starts from the other end: a key
is the identity of one thing, and identity, per-key ordering, persistence, a memory budget,
history and fleet-wide queries come with it. The transition logic is the small part. If what
you need is a statechart for one UI component or one in-memory flow, a state machine library
is the better tool.

## How is this different from Temporal, Orleans, or Durable Objects?

Those give you similar guarantees by having you run their runtime, or by binding you to the
vendor who runs it: a cluster, workers, a control plane, a deployment of its own. Ekman is a
library you construct at your entrypoint. There is nothing else to deploy and nothing to
operate, and durability is a store you name in a config object. The cost of that is scope.
Ekman does not orchestrate long workflows across services and does not coordinate
distributed transactions. If you need a workflow engine, use one.

## Why not a mutex, or a promise chain per key?

That works, and it is the first thing Ekman replaces. `npm run demo:concurrency` runs 5,000
increments across 200 keys three ways: with no coordination, which loses thousands of
updates without a single error, with a promise chain per key written by hand, which loses
none, and through the runtime, which also loses none. It then prints what the runtime costs
per commit over the hand-written chain on your machine. What that cost buys is everything
the chain does not have: a bounded inbox that tells the sender when it is full, retries and
timeouts that cannot commit a stale result, history, constraints, a memory budget with
transparent reload, and an answer to "where is every one of them right now".

## When should I not use Ekman?

When the thing you are modelling has a handful of states, lives in one process, and you do
not need its history, a bound on its memory, or to ask questions across many of it. A field
and a `switch` are fine, and adding a runtime to them is cost with no return. The same goes
for state that is only ever read and written by one request at a time and already lives in
your database: the database is the right owner. Ekman earns its place when there are many
keyed things, triggers for them arrive concurrently, and somebody will one day ask what
state they are all in.
