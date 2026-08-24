## Description

Briefly describe what this PR changes and why.

## Related Issues

Closes #<issue_number>

## Change impact

<!-- Your read: breaking change / feature / fix. Just a hint for the maintainer,
who picks the actual semver bump. Fine if it lands differently than you guessed.

Do not apply release labels, do not bump the version in package.json, and do not
add or edit CHANGELOG.md. `auto` owns all three. See CONTRIBUTING.md. -->

## Checklist

- [ ] `npm run typecheck` passes locally.
- [ ] `npm run lint` passes locally.
- [ ] `npm test` passes locally.
- [ ] `npm run conformance` passes locally.
- [ ] Tests added / updated for the change.
- [ ] `README.md` and the relevant page in `docs/` updated if user-facing behavior or the public surface changed.
- [ ] New dependencies (if any) listed below with name, version, and reason. See `CONTRIBUTING.md`.
- [ ] Change impact noted above (breaking change / feature / fix).

## Behaviour

- [ ] This changes what the runtime does, and a conformance scenario in `scenarios/` covers it
- [ ] This does not change what the runtime does

<!--
A change to behaviour lands with a scenario. That is what keeps a conformance claim
checkable and what makes a port to another language cheap. See CONTRIBUTING.md.
-->

## New dependencies

<!-- Delete this section if no new deps. Otherwise list them:
- `some-pkg ^1.2.3` (dev): what it is for.

Ekman ships zero runtime dependencies. A new runtime dep needs a strong case.
-->

## Output sample (if applicable)

<!-- Paste the relevant program and its output showing the new behavior, or the
demo / benchmark command that makes the change checkable. -->

## Additional Notes

<!-- Perf notes, follow-up work, things you were unsure about. -->
