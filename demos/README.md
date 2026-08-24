# Demos

[Back to the main README](../README.md)

Thirteen runnable programs, one per behaviour. Each one **asserts rather than only printing**, so
a broken claim fails the run instead of scrolling past, and each ends by saying what its output
means. If a demo passes, the claim it stands behind is true on your machine.

```
npm run demo:ordering
```

Nothing here needs setup. The ones that write to disk use a temporary directory and clean up after
themselves.

## Ordering and concurrency

| Command | What it makes checkable |
|---|---|
| `demo:ordering` | Five triggers at one slow key, doing a read-modify-write with an `await` in the middle, and not one lost update. No lock anywhere in the handler. Ends with a full queue refusing a trigger. |
| `demo:concurrency` | The same argument under load. 5,000 increments across 200 keys, run three ways: no coordination (fast, thousands of lost updates), a promise chain per key written by hand (correct), and through the runtime. Samples itself every 5ms so you can watch 200 handlers stay in flight, and reports peak handlers for any one key (1, always) against peak handlers overall. |

## Failure and time

| Command | What it makes checkable |
|---|---|
| `demo:fencing` | A handler that ignores its timeout, runs to completion, tries to commit, and is refused. Plus `commit.raced`, the honest counterpart, where a commit that already reached the store stands. |
| `demo:execution-policy` | Retries, timeouts and backoff layered runtime to entity to state, field by field. A trigger queued behind a retrying attempt waits for it. |
| `demo:stuck` | "Everything stuck in `deploying` for more than five minutes", as a query and as a constraint, on one injected clock. Two handlers accept the escalation and one declines it. |
| `demo:unknown` | A typo'd trigger type, and a deploy that removed a state instances were still sitting in. Both refused loudly and recorded. |

## Constraints

| Command | What it makes checkable |
|---|---|
| `demo:no-going-backwards` | A redelivered message tries to rewind an order. The same naive handler runs unconstrained, under `warn`, and under `reject`. Prints the graph its own traffic walked, then enforces it. |

## Durability and memory

| Command | What it makes checkable |
|---|---|
| `demo:recovery` | Commit, crash without ceremony, restart, and everything resumes in its exact state with history intact. |
| `demo:durability` | Four configurations the runtime refuses to start with, each with the message it actually prints, then the layered stack they were protecting. |
| `demo:memory-bound` | 5000 instances inside a 64 KB budget. Cold ones evict with a snapshot and reload transparently. |
| `demo:retention` | Bytes on disk, watched as they accumulate. 400 commits to one key with the cap off and on, printed as a graph, ending 80x apart with the same sequence and values. Then a budget filling past its ceiling and being pulled back under by a sweep, and 40 finished instances pruned with `query` plus `forget`. |
| `demo:coordination` | Two runtimes taking turns over one directory, 400 writes, and 44% of what was acknowledged missing from the record afterwards. Nothing errors. Then the startup refusal that stops you configuring it, and the same load against a store that can see both writers: every collision refused, nothing lost. |

## Observability

| Command | What it makes checkable |
|---|---|
| `demo:audit` | One audit sink that throws, one that hangs forever, one that is merely slow. Every commit lands anyway. |

## Adding one

A demo earns its place by taking one claim the documentation makes and making it checkable. It
asserts, it uses only the public API, and it ends by explaining its own output. Shared helpers are
in [`lib.ts`](./lib.ts). Wire a new one to an `npm run demo:*` script in `package.json`, and see
[CONTRIBUTING.md](../CONTRIBUTING.md).
