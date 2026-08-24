# Contributing to `ekman`

Thanks for your interest in contributing. Contributions of all kinds are welcome: bug reports, feature requests, doc improvements, and code.

This document covers the dev setup, the rules the project holds the line on, and the PR flow.

## Code of Conduct

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md). Please be respectful in all interactions.

## How can I contribute?

### Reporting bugs

Before opening a bug report, search the [issue tracker](https://github.com/dlynch42/ekman-ts/issues) to see if it has already been reported. If not, open a new issue using the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) and include:

- A clear, descriptive title.
- The smallest program that triggers it. A single file that runs under `tsx` is ideal.
- **Your store configuration**, exactly as you pass it, plus `memory`, `inbox` or `coordination` if you set them. This field is required and it is not boilerplate: most of Ekman's behaviour branches on the store stack, and a report without it usually cannot be acted on.
- Your environment: the `ekman` version and `node -v`.
- The full error including its `code`. Every failure carries a stable one; see [`docs/errors.md`](docs/errors.md).

Relevant `history()` output or telemetry events you saw are often the fastest way to narrow something down.

### Suggesting enhancements

Feature requests go in the issue tracker too, via the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Describe the specific problem it solves, sketch the API if you have one in mind, and say how it sits against the scope line below.

### Pull requests

1. **Fork** the repository and create a branch from `main`.
2. **Set up** your local environment (see [Getting set up](#getting-set-up)).
3. **Commit** with clear, concise messages. Imperative mood (`Add foo`, not `Added foo`); first line under 72 chars; reference issues with `Closes #N` in the body.
4. **Test**: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run conformance` must all pass locally before you push.
5. **Submit** a PR against `release` using the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Fill out every section.

For small fixes (typos, doc clarifications, obvious one-line bugs), feel free to skip the issue and go straight to a PR. For non-trivial changes, open an issue first; it saves rework if the design needs iteration.

## Releases

Releases are automated with [`auto`](https://intuit.github.io/auto/). Merging to `main` runs `npx auto shipit`: it picks the semver bump from the merged PRs' labels, generates `CHANGELOG.md`, bumps the version in `package.json`, creates the `vX.Y.Z` git tag and GitHub release, and publishes to npm.

**Contributors do not touch the changelog, the version, or the labels.**

- **`CHANGELOG.md` is generated.** Do not create or hand-edit it. `auto` owns it entirely, and it is written from merged PR titles and labels.
- **Do not hand-edit the version in `package.json`.** `auto` owns that too.
- **Do not apply labels to your own PR.** Release labels (`major` / `minor` / `patch` / `skip-release`) drive the semver bump, and a maintainer applies them during review.

All you need to do is fill in the **Change impact** line in the PR template with your read: breaking change, feature, or fix. It is a hint for the maintainer, not a decision, and it is fine if it lands differently than you guessed.

Ekman is pre-1.0, so minor versions may make breaking changes.

## Getting set up

Ekman is a TypeScript project and requires Node.js 20 or newer. It has no runtime dependencies, and the file store writes under `.ekman/` in the working directory.

```bash
git clone https://github.com/dlynch42/ekman-ts
cd ekman-ts

npm install
npm run build          # tsup, emits ESM + CJS + .d.ts to dist/
```

Before you push:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # ultracite / biome, no writes. `npm run format` autofixes
npm test               # Vitest unit tests plus the conformance suite
npm run conformance    # standalone report, pass/fail per scenario per level
npm run test:coverage  # coverage gate. Floor is 90%; actual coverage is 100%
```

CI runs the same set. They must pass.

## Where things live

| Directory | What it is |
|---|---|
| `src/` | The implementation. `src/index.ts` is the only public entry point. |
| `test/` | Unit tests. |
| `scenarios/` | The language-agnostic conformance suite. |
| `runner/` | The thin runner that executes scenarios against this implementation. |
| `docs/` | Public reference documentation. |
| `demos/` | Runnable programs, one per behaviour. Each asserts. |
| `benchmarks/` | Performance suites and their recorded baselines. |
| `examples/` | A worked service built on Ekman. |

## What Ekman is (and isn't)

Ekman is an **embedded runtime for addressable stateful instances**. Each instance is identified by a human-readable key, holds its own state and values, and processes its triggers one at a time. Around that it owns the operational layer: transition history, constraints, retries and timeouts, queries, and a memory budget. It is constructed in your process. A runtime you embed, not a platform you operate.

It is **not** an orchestration platform, a workflow DSL, transport-coupled, a distributed transaction coordinator, or durable by default.

### The scope line

When proposing a feature, ask whether it keeps Ekman a library or starts turning it into a platform. The full statement is under [Scope](README.md#scope) in the README, and a proposal that moves toward any of the following will be declined however well built it is:

- **A mandatory server, cluster, sidecar, or control plane.** There is nothing to deploy. Ekman is `new Ekman({...})` in your process, and that is the whole product.
- **A workflow DSL.** States are data, handlers are functions, configuration is code. There is no language to learn and there will not be one.
- **Transport coupling.** Kafka messages, HTTP requests, timers and direct calls are all just triggers. Nothing in the core may know which one it is.
- **Distributed transactions.** The transition log is the source of truth and cache layers are derived from it. Ekman coordinates one key at a time and does not span keys.
- **Durability by default.** Memory-only is a valid, documented, intentionally ephemeral mode, not a degraded one. Durability exists when a store is configured and never otherwise.

If a proposal blurs the line, expect pushback. This is not a marketing rule. It is what lets someone adopt Ekman without adopting an operational commitment, and the moment it stops being true the reason to use it is gone.

## What's public API

Treat these as stable surface and don't change them casually:

1. **Everything exported from `src/index.ts`.** That barrel is the entire public surface, deliberately. Removing or renaming an export is a breaking change.
2. **The key format** `<entity>:<segment>...`. Keys are the public identity and appear in history, queries, telemetry, log filenames and error messages.
3. **The error codes** in `src/errors.ts`. Callers branch on `code`, so the set and their meanings are contract. Messages are not.
4. **The telemetry event names and shapes** in `src/telemetry.ts`. These land in other people's metrics pipelines.
5. **The on-disk log format** the file store reads and writes under `.ekman/logs/`. A change here has to replay old logs or ship a migration.
6. **The conformance scenario format** documented in [`scenarios/README.md`](scenarios/README.md). Other implementations parse it.

Breaking changes to any of these need a version bump and a migration note in the PR.

## Behaviour changes need a scenario

This is the one convention worth stating loudly.

Ekman's behaviour is defined by [`scenarios/`](scenarios), a declarative suite that every implementation copies verbatim and runs through its own public API. A scenario says: given these states, constraints and policies, deliver these triggers, and assert these committed events and rejections. Nothing in a scenario is TypeScript-specific.

So a change to what the runtime *does*, as opposed to how it does it, lands with a scenario. That is what makes "conforming at level X" a checkable statement rather than a claim, and it is what makes a port to another language cheap instead of speculative.

[`scenarios/README.md`](scenarios/README.md) documents the full format: the `given` / `when` / `then` shape, every assertable field, the error codes, and the determinism rules. Read it before adding one.

### Running the suite against another implementation

The suite is deliberately portable. To conform a new implementation:

1. Copy `scenarios/` unchanged. Do not edit scenarios to suit an implementation; if one is ambiguous, that is a bug in the scenario and worth an issue.
2. Write a thin runner for your language that reads a scenario, drives your public API, and reports pass or fail. `runner/` is the reference for what that runner has to do.
3. State which levels you claim, per spec version, in your implementation's README.

Conformance levels stack: **Core**, then **Durable**, then **Coordinated**. A level is claimed only when everything it requires is implemented, not when its scenarios happen to pass. A partial claim is worse than no claim, because somebody will believe it.

## Dependency policy

Ekman ships with **zero runtime dependencies**, and that is a feature rather than an accident. Adding one requires justification in the PR description and a high bar.

### Rules

1. **Justify it.** What does it enable? Why can't we vendor or reimplement?
2. **Runtime dependencies are close to a no.** The package is embedded in other people's processes. Anything only needed for builds, tests, or tooling goes in `devDependencies`, where the bar is ordinary.
3. **Pin a lower bound, not an upper bound.** Use the existing `^X.Y.Z` convention. Avoid hard `<` constraints unless there's a known incompatibility; they cause downstream resolver pain.
4. **License.** MIT, BSD, Apache-2.0, MPL-2.0, ISC only. No GPL / LGPL / AGPL or commercial-restricted licenses.
5. **Supply-chain hygiene.** Prefer packages with active maintenance (commit in last 12 months), multiple maintainers, and meaningful download volume. Flag anything that doesn't meet that bar in the PR.
6. **Document it in the PR.** List each new dep as `name version (runtime/dev): reason`.

Store adapters are the deliberate exception, and they are handled by *not* taking the dependency: an adapter Ekman does not ship is passed in as a `Store` instance, so configuring a store never means importing a database client you are not using.

## Adding a demo

Demos live in `demos/`, one file each, wired to an `npm run demo:*` script. A demo earns its place by taking one claim the documentation makes and making it **checkable**: it asserts rather than only printing, so a broken claim fails the run instead of scrolling past, and it ends by saying what its output means. Shared helpers are in `demos/lib.ts`.

## Adding a benchmark

Suites live in `benchmarks/`, with recorded baselines in `benchmarks/baseline.json`. [`benchmarks/README.md`](benchmarks/README.md) covers what each suite measures, what it deliberately does not, and how to add one. A performance claim in a pull request should name the suite it came from.

## Style guidelines

- **Code style.** `ultracite` / `biome` for lint and format (`npm run lint`, `npm run format`) and TypeScript strict mode. CI will fail otherwise.
- **Comments and JSDoc.** Inline comments are one line, two at most; JSDoc carries the long explanations. A comment that only restates the next line gets deleted. Exported API gets `@param` / `@returns` without type annotations.
- **Errors.** Every failure raised to a caller carries a stable `code`. Never introduce a failure path that surfaces as a bare `Error`, and never swallow one silently. Unknown is never silent is a project rule, not a slogan.
- **Documentation.** If you change user-facing behaviour or the public surface, update `README.md` and the relevant page in `docs/` in the same PR.

## Reporting security issues

Do *not* file a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the full reporting flow, supported-versions policy, and disclosure expectations. The short version: use GitHub's [Report a vulnerability](https://github.com/dlynch42/ekman-ts/security/advisories/new) link.

## Legal notice

By contributing to this project, you certify that you have the right to submit the work, that it is your original creation or that you are authorized to submit it, and that it does not violate any third-party rights.

## Contributor copyright assignment and relicensing

**Read this before submitting a contribution. Submitting one means you accept it.**

By submitting a contribution to this project, you **assign to Devin Lynch all right, title, and interest worldwide in and to the copyright in your contribution**, including all rights to reproduce, distribute, modify, sublicense, and relicense it, in perpetuity. You do not retain ownership of the contribution once it is submitted.

Where such an assignment is not permitted or is unenforceable under applicable law, you instead grant Devin Lynch a **perpetual, worldwide, irrevocable, non-exclusive, royalty-free, fully paid-up, transferable, and sublicensable license** to use, reproduce, modify, distribute, publicly perform and display, prepare derivative works of, and **relicense** your contribution under any terms, including proprietary terms, without further notice, attribution obligation, or compensation. To the fullest extent permitted by law, you waive any moral rights and any right to be identified as author in respect of the contribution.

For the avoidance of doubt:

- **The project may be relicensed at any time, at the sole discretion of Devin Lynch**, under a different open source license or a proprietary one, and your contribution goes with it.
- You retain the right to use your own contribution for your own purposes, under the project's then-current public license like anyone else.
- If your employer holds rights to work you create, you are responsible for obtaining their permission before contributing, or for contributing under an account and capacity where those rights do not attach.
- Ekman is currently licensed to the public under [Apache 2.0](LICENSE). That is the outbound license today; this section governs the inbound grant and is deliberately broader.

**If you cannot agree to these terms, do not submit contributions to this project.** Open an issue instead; describing a problem or a design costs you nothing and is genuinely useful.

## Governance

Merge access to `main` is restricted to the maintainer. External contributors land changes through PRs reviewed and merged by a maintainer. Anyone can open an issue proposing a non-trivial change; the decision to accept or decline rests with the maintainer.

## Questions

For anything that doesn't fit an issue or PR (design discussions, "is this the right approach"), open a [GitHub Discussion](https://github.com/dlynch42/ekman-ts/discussions).
