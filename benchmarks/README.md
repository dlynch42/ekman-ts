# Benchmarks

```
npm run bench                  every suite, compared against the committed baseline
npm run bench -- fan-out       one suite
npm run bench -- --save        run, then record what ran as the new baseline
```

Five suites. Four drive the runtime through its public API only, the same way the
conformance runner does, with synchronous handlers that do nothing, because the figures are
meant to be what Ekman costs rather than what a handler costs.

| Suite | Measures |
|---|---|
| `commit-rate` | One key, fully serialized: commits per second, and send-to-commit latency at p50 and p99 |
| `fan-out` | 500 keys with their triggers all in flight at once: aggregate commits per second |
| `constraints` | The same workload under no constraints, a transition graph, guards, and invariants |
| `overflow` | A burst larger than the inbox: how much load is shed, and how fast the answer comes back |
| `edge-check` | The constraint check on its own, with no commit under it |

`edge-check` is the exception: it calls the constraint checker directly rather than through
a runtime. That is a deliberate cost, taken because the other suites cannot resolve a
change that small, and it is the reason its figures are per-check rather than per-commit.
It carries a control that runs the same loop against an entity with no constraints, so the
share of each figure that is the loop rather than the check is visible instead of assumed.

## Reading the output

Every figure is the **median across timed rounds**, with warmup rounds discarded. The
number beside it is the **spread**: the full range across those rounds as a fraction of the
median. Spread is not decoration. It is the noise floor, and a delta that does not clear it
is not a result.

When a baseline exists, each figure is compared against it and labelled `faster`, `slower`
or `no change`. `no change` is applied whenever the delta falls inside the widest spread
either run saw, with a floor of 3% regardless. This is deliberate: a benchmark that reports
a 1% improvement is reporting the weather.

## What these figures are not

**They are machine-local.** `baseline.json` records the CPU, core count, platform and Node
version it came from. Comparing against a baseline captured on other hardware prints that
it cannot be compared, rather than a delta. Cross-machine numbers are not evidence, and the
harness will not let the file pretend otherwise.

**They are not a comparison against anything else.** Nothing here benchmarks Ekman against
another library. The suites exist to catch a regression in this implementation between two
commits, which is a question they can actually answer.

**The end-to-end suites do not resolve small costs.** One commit costs a few microseconds,
most of it in work every commit has to do. The `constraints` suite says so in its own
output: the transition-graph check is smaller than the run-to-run spread of the rate it is
part of, so those four suites can bound that cost but cannot measure it. That is what
`edge-check` is for, and the two agree: `edge-check` puts a constraint check at roughly
200ns and `commit-rate` puts a commit at roughly 4µs, which is the 5% that `constraints`
brackets between 1% and 11%.

## Adding a suite

A suite is a module exporting `NAME` and `run(): Promise<SuiteResult>`, registered in
`run.ts`. Two rules earn a suite its place:

1. **Assert what landed.** Every suite here checks its own commit counts. A rate from a run
   that lost work measures nothing, and the check is what stops that going unnoticed.
2. **Say which direction is better.** A figure declares `higher`, `lower` or `neither`.
   `neither` is for figures like the shed rate, where the number describes behaviour and
   calling a change to it "faster" would be meaningless.
