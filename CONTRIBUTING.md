# Contributing

This repository ships the real, buildable TypeScript source for the **UAE Corporate Registry Monitor** Apify Actor. It is independently maintained by Stefano Seggio as part of the [Delta Registry](https://github.com/stefanoseggio) fleet — there is no separate contributor team, but external bug reports, source-coverage proposals, and documentation fixes are welcome.

## Local setup

```bash
git clone https://github.com/stefanoseggio/uae-corporate-registry-monitor.git
cd uae-corporate-registry-monitor
npm install
apify login          # once per machine, needed only for `apify run`
```

No third-party credentials are required for the two default sources (ADGM, DIFC) — both are open and unauthenticated. The optional `DUBAI_MAINLAND` source requires your own approved Dubai Pulse API key (see the README's "Dubai mainland setup" section); it is not needed to build, lint, or run the test suite.

## Development workflow

```bash
npm run start:dev     # tsx src/main.ts, reads ./storage/key_value_stores/default/INPUT.json
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npm run format         # prettier --write .
npm run build          # tsc
npm test               # vitest run
```

Local runs against `ADGM_FREEZONE`/`DIFC_FREEZONE` hit the real, live registers — there is no bundled fixture/mock server for those two. Use a small `maxItems` while developing to keep runs fast and avoid unnecessary load on the source registers.

## Branch naming

- `fix/<short-description>` — bug fixes
- `feat/<short-description>` — new input fields, new output fields, new source coverage
- `docs/<short-description>` — README/documentation-only changes
- `chore/<short-description>` — dependency bumps, tooling, CI changes

## Commit convention

This repository follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>

<optional body>
```

Types used here: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`. The `type` prefix drives automated changelog generation via `release-please` (see [`.github/workflows/release.yml`](.github/workflows/release.yml)) — a `feat:` commit triggers a minor version bump, `fix:` triggers a patch bump, and `feat!:`/a `BREAKING CHANGE:` footer triggers a major bump. Non-conventional commit messages are still accepted but won't be reflected in the auto-generated changelog entry for that change.

## Pull requests

1. Fork or branch, make your change, and ensure `npm run lint`, `npm run build`, and `npm test` all pass locally.
2. Open a PR against `main` using the repository's [PR template](.github/PULL_REQUEST_TEMPLATE.md).
3. CI (`.github/workflows/test.yaml`) runs automatically and must pass before merge.
4. Behavioral changes to the Actor's input/output schema should also update `.actor/input_schema.json` / `.actor/dataset_schema.json` and the corresponding README sections in the same PR — schema and documentation drift is treated as a real bug, not a follow-up.

## Scope boundaries

New source-coverage proposals are evaluated against this Actor's own documented, live-verified doctrine (README → "What this actor deliberately does not do" and AGENTS.md §0's source-verification record): no officer/manager/director tracking (not exposed by any of the three verified sources' public list views), no numeric activity-code taxonomy for the free-zone sources (they don't expose one), and no coverage claim for Abu Dhabi mainland, Sharjah, or other emirates unless a real, bulk, anonymous public data source for them is independently verified first — a filter that would silently return nothing is treated as worse than no filter at all.

## Questions or non-code issues

For questions that aren't a code change (pricing, licensing, enterprise inquiries), use the Apify Store's Issues tab on the [live Actor page](https://apify.com/stefano_seggio/uae-corporate-registry-monitor) rather than a GitHub issue.
