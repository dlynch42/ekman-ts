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

**The end-to-end suites do not resolve small costs.** A commit costs microseconds, most of it
in work every commit has to do, while a constraint check costs nanoseconds. An instrument
that pays for a whole commit on every sample cannot resolve a change to something that is a
fraction of a percent of it. The `constraints` suite says so in its own output rather than
leaving you to infer it: it reports the bound it can support and states that it cannot
measure the check. That is what `edge-check` exists for, and why its figures are per-check
rather than per-commit.

**They measure the runtime with no store configured.** Every suite builds `new Ekman({
entities })` and nothing else, so there is no durability, no network, and no fsync in any
figure here. What they report is what Ekman adds to a handler, not what a system built on
it will do.

## What each suite is telling you

Current figures live in the [project README](../README.md). This file is about how they are
produced and how to read them, so it deliberately does not repeat them: two copies of the
same numbers is two things to update and they will drift.

**`commit-rate`.** One key, fully serialized. The two latency figures are inherently noisier
than the rate figures, and p99 especially so, since it is a tail statistic over a few
thousand samples. Treat a p99 change under about 50% as weather.

**`constraints`.** The same workload at four levels of strictness. This suite bounds the cost
of a constraint set rather than measuring it: the whole range across all four levels is
narrower than the suite's own run-to-run variation, which the suite says in its own output
rather than leaving you to work out. That bound is the useful thing it produces. Resolving
the check itself is what `edge-check` is for.

**`edge-check`.** Three graph sizes, because a hash lookup is flat in the number of states
and other representations are not, so a figure taken at one size would hide whichever of
those is about to matter. Flatness across the sweep is the property being checked, not a
nice-to-have. The refusal path is measured separately and runs several times the cost of the
legal path, because it builds a violation message: string work rather than lookup work, and
the path an entity in `warn` mode takes on every violation it exists to discover.

**`fan-out`.** Both halves of the fan-out argument are here on purpose. With a handler that
returns immediately, many keys aggregate to *less* than the one-key rate in `commit-rate`:
there is nothing to overlap, so keys cost throughput. With a handler that waits, which is
what real handlers do, keys overlap and throughput multiplies. The first figure read alone
says "keys are expensive", which is true only of a runtime with nothing to overlap and was
actively misleading on its own. The 50-key figure carries a wide spread; do not read small
changes in it.

**`overflow`.** The shed rates are deterministic, which is why their spread is zero and why
the suite marks them `neither` rather than claiming a direction. A larger inbox sheds less
and takes longer to drain, which is the trade the capacity setting exists to make.

## Adding a suite

A suite is a module exporting `NAME` and `run(): Promise<SuiteResult>`, registered in
`run.ts`. Two rules earn a suite its place:

1. **Assert what landed.** Every suite here checks its own commit counts. A rate from a run
   that lost work measures nothing, and the check is what stops that going unnoticed.
2. **Say which direction is better.** A figure declares `higher`, `lower` or `neither`.
   `neither` is for figures like the shed rate, where the number describes behaviour and
   calling a change to it "faster" would be meaningless.
