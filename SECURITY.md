# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

Ekman is pre-1.0. Fixes land on the latest minor version; older minors are not patched.

## Reporting a vulnerability

Please report privately through GitHub, not in a public issue:

**[Open a private security advisory](https://github.com/dlynch42/ekman-ts/security/advisories/new)**

Include what you can: affected version, a minimal reproduction, the store configuration in use,
and what an attacker gains. You should get an acknowledgement within a few days. If a report is
valid, you will be told when a fix is planned and credited in the advisory unless you would rather
not be.

Please give a reasonable window to ship a fix before disclosing publicly.

## What Ekman does with your data and your code

Worth knowing when assessing it for a deployment. None of this is a vulnerability; it is the
design, and being explicit about it is more useful than a boilerplate policy.

**Handlers run in your process.** Ekman calls the functions you register, in the same isolate,
with no sandbox. It provides no isolation boundary between your handlers and the rest of your
application, and it is not a mechanism for running untrusted code.

**Committed values are written to disk in plaintext.** With `store: "file"`, whatever you put in
an instance's `values` is serialized as JSON into `.ekman/logs/`, one log per key, alongside the
transition history. Ekman does not encrypt, redact or classify it. If values hold secrets or
personal data, that is what is on disk, subject to your own filesystem permissions and retention.

**Keys are visible.** Keys appear in log filenames, history, query results, telemetry events and
error messages. They are designed to be human-readable, so do not encode secrets in them.

**Audit sinks receive committed events.** A sink you register gets a copy of every commit,
including values. Where a sink sends them is your decision.

**`forget(key)` deletes.** It removes an instance from memory and from every store layer. It is
the mechanism behind a deletion request, and it is never invoked automatically.

## Dependencies

Ekman has no runtime dependencies, so a published version's supply chain is the package itself and
Node. Development dependencies are in `package.json` under `devDependencies` and do not ship.
