# Security Policy

## Supported versions

This Actor follows [semantic versioning](https://semver.org/) via automated release tagging (see [`.github/workflows/release.yml`](.github/workflows/release.yml)). Only the latest published major version receives security fixes — there is no long-term-support branch for older majors, consistent with this being a single-maintainer, independently-operated Actor rather than an enterprise product with a formal support matrix.

## Reporting a vulnerability

**Preferred: GitHub Private Vulnerability Reporting.** This repository has private vulnerability reporting enabled — go to the **Security** tab → **Report a vulnerability** to open a private advisory visible only to the maintainer until a fix is ready. This is the correct channel for anything that shouldn't be disclosed in a public issue (credential handling, injection risks, dependency CVEs affecting this Actor's real usage, etc.).

**Do not** open a public GitHub issue for a suspected security vulnerability — use private reporting instead so the disclosure stays coordinated.

## What's actually in scope

This Actor's real attack surface, honestly assessed:

- **One optional BYOK secret.** The two default sources (ADGM, DIFC) require no credential at all. The optional `DUBAI_MAINLAND` source requires the *user's own* approved Dubai Pulse API key, supplied via the `dubaiPulseApiKey` input field — this Actor never stores, logs, or transmits that key anywhere other than directly to `dubaipulse.gov.ae`'s own API.
- **No arbitrary-code or arbitrary-URL input surface**, with narrow exceptions for the user-supplied `webhookUrl` / `slackWebhookUrl` / `teamsWebhookUrl` fields, which are outbound-only notification destinations the operator configures for their own run, not attacker-controlled input. Input is otherwise a fixed JSON Schema (`.actor/input_schema.json`) enforced by the Apify platform before the Actor runs.
- **Dependency vulnerabilities** in `package.json`'s real dependency tree (`apify`, `fast-check`, and other dev dependencies) are a real, ongoing concern — tracked via Dependabot (`.github/dependabot.yml`) and GitHub's own dependency/secret scanning, both enabled on this repository.
- **Source integrity** (a compromised or spoofed ADGM, DIFC, or Dubai Pulse endpoint) is outside this Actor's control — it fetches from each source's own official, government-operated URL over HTTPS and does not implement independent content-signing verification beyond standard TLS.

## Response expectations

This is an independently developed and maintained Actor with no contractual security SLA. In practice, security reports are typically triaged within 48 hours, though there is no guaranteed fix timeline. Reports that turn out to be genuine, exploitable vulnerabilities will be credited in the fix's release notes unless the reporter requests otherwise.

## Enterprise / institutional customers

If your organization requires a signed security addendum, a formal disclosure SLA, or a security questionnaire completed as part of procurement, open an issue against this Actor's [Store page](https://apify.com/stefano_seggio/uae-corporate-registry-monitor) or connect via [LinkedIn](https://www.linkedin.com/in/stefanoseggio-deltaregistry) — these are handled case-by-case, not something this file can commit to on Stefano's behalf.
