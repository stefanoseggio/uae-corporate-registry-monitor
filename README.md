# UAE Corporate Registry Monitor — Dubai Mainland, ADGM & DIFC

[![Built for Apify](https://img.shields.io/badge/built%20for-Apify-3E7BFA)](https://apify.com/stefano_seggio/uae-corporate-registry-monitor) [![Pay-Per-Event](https://img.shields.io/badge/pricing-pay--per--event%20%E2%80%94%20%240.02-orange)](https://apify.com/stefano_seggio/uae-corporate-registry-monitor) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) [![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)

[![Run on Apify Store](https://img.shields.io/badge/Run%20on-Apify%20Store-FF9012?style=for-the-badge&logo=apify&logoColor=white)](https://apify.com/stefano_seggio/uae-corporate-registry-monitor)

Live and public at [apify.com/stefano_seggio/uae-corporate-registry-monitor](https://apify.com/stefano_seggio/uae-corporate-registry-monitor).

**Delta-tracks UAE corporate registrations and license-status changes across three real, live, independently-verified registers: Dubai's DED mainland trade-license register (via the Dubai Pulse open-data portal), ADGM (Abu Dhabi Global Market), and DIFC (Dubai International Financial Centre).**

Bilingual Arabic/English entity-name normalization. Part of
[Delta Registry](https://github.com/stefanoseggio), a pay-per-event regulatory/compliance data
fleet.

No third-party API key is required for the two default, zero-setup sources (ADGM, DIFC). BYOK
status: a key is needed only if you opt into the optional `DUBAI_MAINLAND` source — your own
approved Dubai Pulse API key, see **Dubai mainland setup** below.

## No, there isn't a single "UAE Mainland Corporate Registry" open API — here's what's real instead

This actor's original brief asked for one bulk-queryable, anonymous, multi-emirate open API. Live
verification (six parallel research passes plus direct, first-hand browser interaction — not
background knowledge) found that source does not exist. What's real:

- **The UAE's federal "National Economic Register" (نمو / Growth) exists and is correctly named**,
  but its bulk-capable license-search/export service sits behind **UAE Pass** — the UAE's personal
  government digital identity system — confirmed by directly navigating to it and watching it
  redirect to a login page reading "Login with Digital Identity." Not automatable by an unattended
  actor, at any price.
- **Dubai mainland (DED) genuinely does publish exactly this data** through Dubai Pulse, a real
  government open-data portal — but access requires the _actor's user_ to complete Dubai Pulse's
  own "Request Permission" approval (up to 14 days) and supply their own API key. This actor
  cannot get you that key; see **Dubai mainland setup** below.
- **ADGM and DIFC — genuinely free-zone, not "mainland," but real, live, anonymous, and
  bulk-queryable with zero setup** — confirmed by directly submitting a blank search and watching
  it return the entire register with pagination and export, not a single-record lookup.

Full verification record, including the sources investigated and ruled out (Abu Dhabi, Sharjah,
Ajman, and the UAE's federal CKAN portals), is in [AGENTS.md](AGENTS.md#0-live-data-source-verification-record).

## Quickstart

### cURL

```bash
curl "https://api.apify.com/v2/acts/stefano_seggio~uae-corporate-registry-monitor/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dataSources": ["ADGM_FREEZONE", "DIFC_FREEZONE"],
    "maxItems": 100
  }'
```

### Python

```python
from apify_client import ApifyClient

client = ApifyClient("<YOUR_APIFY_TOKEN>")
run = client.actor("stefano_seggio/uae-corporate-registry-monitor").call(run_input={
    "dataSources": ["ADGM_FREEZONE", "DIFC_FREEZONE"],
    "maxItems": 100,
})

for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(f"{item['event_type']}: {item['commercial_name_en']} ({item['data_source']}) - {item['registration_status']}")
```

### Node.js

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client.actor('stefano_seggio/uae-corporate-registry-monitor').call({
    dataSources: ['ADGM_FREEZONE', 'DIFC_FREEZONE'],
    maxItems: 100,
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
items.forEach((item) => console.log(`${item.event_type}: ${item.commercial_name_en} (${item.data_source}) - ${item.registration_status}`));
```

## Use this from Claude Desktop, Cursor, or Windsurf (via MCP)

This actor is also reachable as a tool through Apify's own hosted `@apify/actors-mcp-server` at `https://mcp.apify.com`, scoped to just this one actor via a `?tools=stefano_seggio/uae-corporate-registry-monitor` query string — it is not a separate "Delta Registry MCP server," and each config below connects an MCP client to this single actor, not the wider fleet. Get a token from [Apify Console → Settings → Integrations](https://console.apify.com/settings/integrations) first.

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` on Windows (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS). Claude Desktop connects via the `mcp-remote` stdio bridge, not a direct URL:

```json
{
  "mcpServers": {
    "delta-registry-uae-corporate-registry-monitor": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.apify.com/?tools=stefano_seggio/uae-corporate-registry-monitor",
        "--header",
        "Authorization: Bearer ${APIFY_TOKEN}"
      ]
    }
  }
}
```

`mcp-remote` does not expand shell environment variables inside the JSON string — paste your real token literally in place of `${APIFY_TOKEN}`, and keep this file out of version control.

### Cursor

Edit `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json` (global). Cursor uses native HTTP transport:

```json
{
  "mcpServers": {
    "delta-registry-uae-corporate-registry-monitor": {
      "url": "https://mcp.apify.com/?tools=stefano_seggio/uae-corporate-registry-monitor",
      "headers": {
        "Authorization": "Bearer ${APIFY_TOKEN}"
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`. Windsurf uses `serverUrl`, not `url`:

```json
{
  "mcpServers": {
    "delta-registry-uae-corporate-registry-monitor": {
      "serverUrl": "https://mcp.apify.com/?tools=stefano_seggio/uae-corporate-registry-monitor",
      "headers": {
        "Authorization": "Bearer ${env:APIFY_TOKEN}"
      }
    }
  }
}
```

Windsurf's `${env:...}` syntax genuinely resolves from your environment at runtime, unlike `mcp-remote` above.

Want every Delta Registry actor (all 28) reachable from one closed-scope MCP config instead of connecting to each actor individually? See [`delta-registry-website/MCP_INTEGRATION.md`](https://github.com/stefanoseggio/delta-registry-website/blob/main/MCP_INTEGRATION.md).

## Dubai mainland setup (optional — ADGM/DIFC need none of this)

`DUBAI_MAINLAND` is not enabled by default because it requires setup this actor cannot do for you:

1. Register at [dubaipulse.gov.ae](https://www.dubaipulse.gov.ae) and request access to the
   `ded_license_master-open` and `ded_trade_name-open` datasets ("Request Permission" — Dubai
   Pulse's own documented turnaround is up to 14 days).
2. Once approved, paste the API key you receive into this actor's `dubaiPulseApiKey` input, and
   add `DUBAI_MAINLAND` to `dataSources`.

**Honest caveat, not a hidden footnote**: this is the one integration in this actor whose exact
wire format could not be verified against live traffic during development — Dubai Pulse rejected
every direct connection attempt made from every tool available in this build environment (see
[AGENTS.md §0.2](AGENTS.md#02-dubai-mainland-dubai-pulse---the-closest-real-match-but-with-real-access-friction)).
The field schema is verified from the dataset's own real documentation; the response envelope
shape and status-code vocabulary are not. `src/dubaiPulseSource.ts` is built to fail with a
specific, diagnostic error rather than silently misparse if the real API differs from what's
implemented — test it against your own approved credentials before relying on it in production.

## Pricing (pay-per-event)

| Event                                    | Price            | When it fires                                                                                                                                      |
| ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new-entity`                             | $0.02            | A registration never seen before appears, after that source's baseline is established.                                                             |
| `status-changed`                         | $0.02            | An entity's registration or license status changed (e.g. `Registered` → `Deregistered`, `Active` → `Inactive - Struck Off`) — the flagship signal. |
| `entity-updated`                         | $0.01            | Some other real content changed (address, activities, legal form) but status did not — delivered, but not pushed to real-time alert channels.      |
| `ENTITY_UNCHANGED` / `BASELINE_SNAPSHOT` | **Never billed** | First-run baseline observations and confirmed-unchanged entities are always free.                                                                  |

_Pricing above is live — this actor is published on Apify Store, and these are the exact,
currently-active Pay-Per-Event prices configured in the Apify Console's monetization settings, not
a proposal. `apify-actor-start` is retained (the first 5 seconds of platform compute is waived on
every run) and `apify-default-dataset-item` is removed (no automatic per-write dataset charge), so
the "unchanged entities cost nothing" guarantee above is enforced at both the application layer
and the Console billing layer._

## Input reference

See [`.actor/input_schema.json`](.actor/input_schema.json) for the full, authoritative schema.

| Field                                                | Type    | Default                              | Notes                                                                                                                                                                                |
| ---------------------------------------------------- | ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dataSources`                                        | array   | `["ADGM_FREEZONE", "DIFC_FREEZONE"]` | `DUBAI_MAINLAND`, `ADGM_FREEZONE`, `DIFC_FREEZONE`. Abu Dhabi mainland, Sharjah, and other emirates are not offered — no real bulk public data exists for them (see AGENTS.md §0.5). |
| `dubaiPulseApiKey`                                   | string  | —                                    | Required only if `dataSources` includes `DUBAI_MAINLAND`. See **Dubai mainland setup**.                                                                                              |
| `maxItems`                                           | integer | 50                                   | This actor's own per-run push cap, across all selected sources.                                                                                                                      |
| `deltaStateName` / `resetState` / `onlyNew`          | —       | fleet defaults                       | Same convention as the rest of this fleet.                                                                                                                                           |
| `webhookUrl` / `slackWebhookUrl` / `teamsWebhookUrl` | string  | —                                    | See **Alerting** below.                                                                                                                                                              |

## What this actor deliberately does not do

- **No officer/manager/director tracking.** None of the three verified sources expose this in
  their public list views — only entity-level status, name, activity, and address. Detecting
  officer changes would require a paid or authenticated detailed-report tier this actor doesn't
  have access to; see [AGENTS.md §3](AGENTS.md#3-corrected-mandate-assumptions).
- **No numeric ISIC-style activity codes for the free-zone sources.** ADGM and DIFC expose named
  categories and free-text activity lists, not a numeric taxonomy.
- **No coverage for Abu Dhabi mainland, Sharjah, or the other emirates.** Investigated and found
  to have no real, bulk, per-company public data (see AGENTS.md §0.5) — not silently
  omitted, not offered as a filter that would return nothing.
- **No classic Microsoft Teams connector support** — retired; this actor uses the current
  "Workflows" webhook mechanism (see **Alerting** below).

## Output record

```json
{
    "@type": "schema:Corporation",
    "event_id": "a3d619040582275b82a0b3fdbabe6ba1310e3535",
    "event_type": "BASELINE_SNAPSHOT",
    "record_id": "ADGM_FREEZONE::22086",
    "data_source": "ADGM_FREEZONE",
    "free_zone": true,
    "commercial_name_en": "0727 HOLDING LIMITED",
    "commercial_name_ar": null,
    "legal_form": "Private Company Limited By Shares",
    "registration_status": "Registered",
    "license_status": "Licensed",
    "trade_name_status": "Active",
    "previous_registration_status": null,
    "previous_license_status": null,
    "previous_trade_name_status": null,
    "activities": ["Non-Financial (Category B)", "Special Purpose Vehicle"],
    "issue_date": "2024-11-07",
    "expiry_date": null,
    "cancel_date": null,
    "registered_address": "Sub-Unit 1 of the Unit 4, Level 8, Al Sarab Tower, Adgm Square, Al Maryah Island, Abu Dhabi, United Arab Emirates",
    "status_fingerprint": "1345e799976260d9385e820a0cb3a399782cf8865576b35661ade7386309b891",
    "content_fingerprint": "29763666dd29ac3d096f7611a4068fc4102a4b6b75a160f64e552344dc07030b",
    "is_new": true,
    "scraped_at": "2026-09-17T02:22:55.844Z"
}
```

This is a real record, generated by running this actor's own pipeline against real data captured
live from ADGM's public register during this actor's development — not a fabricated example.

`event_id` is a SHA-1 idempotency key over `(record_id, event_type, status_fingerprint,
content_fingerprint)`. `record_id` is `{dataSource}::{sourceSpecificId}` — e.g. the license/
registration number DED, ADGM, or DIFC themselves already use as each entity's stable identifier.

## Alerting

`status-changed` and `new-entity` always notify; `entity-updated` (a cosmetic content edit) is
delivered and charged but not pushed to real-time channels — see
[AGENTS.md §4](AGENTS.md#4-delta-engine-design-srcdeltaenginets). Every channel
receives both the English and (when available) Arabic commercial name, and a visual accent —
red/"attention" for a status change, green/"good" for a brand-new entity — so the highest-priority
signal is visible at a glance.

### Slack

Create the webhook via a **Slack App** (Slack's own current, documented method — not the older
"legacy custom integrations" path). Paste the URL into `slackWebhookUrl`. Messages use Block Kit
with a colored attachment bar for the status-change accent.

### Microsoft Teams

Microsoft retired the classic Teams "Incoming Webhook" connector in a May 2026 cutover — same
finding as Actors #2 and #3 of this fleet. Use a **Workflows** webhook URL (Teams channel →
Workflows → "When a Teams webhook request is received") in `teamsWebhookUrl`. This actor posts a
standard Adaptive Card with a status-colored container; a Power Automate flow's exact trigger
schema is user-configurable per flow, so adjust your flow's parsing step to this actor's payload
if needed (documented in [`src/notifier.ts`](src/notifier.ts)).

## Architecture

Full spec in [AGENTS.md](AGENTS.md). Summary:

```
  Actor input ──▶ src/main.ts (migrating/aborting-safe state flush,
                   one KV store keyed by deltaStateName)
                        │
                        ▼
        src/routes.ts: for each selected data source
                        │
          ┌─────────────┼─────────────────────┐
          ▼             ▼                     ▼
  src/dubaiPulseSource  src/adgmSource.ts     src/difcSource.ts
  .ts (best-effort,     (Salesforce Aura RPC, (Next.js API proxy,
  requires user's own   anonymous, fwuid      anonymous, offset-
  API key - see          bootstrapped fresh    paginated - the
  AGENTS.md §0.2) each run)              simplest integration)
          │             │                     │
          └─────────────┴─────────┬───────────┘
                                   ▼
       src/bilingualNormalizer.ts: Arabic diacritic/alef/yeh/
       digit normalization (ASCII source, runtime-built regexes -
       see AGENTS.md §2), English legal-form canonicalization
                                   │
                                   ▼
       src/deltaEngine.ts: normalize -> SHA-256 status + content
       fingerprints -> classify (NEW_ENTITY / STATUS_CHANGED /
       ENTITY_UPDATED / ENTITY_UNCHANGED / BASELINE_SNAPSHOT)
                                   │
                                   ▼
       src/state.ts: Key-Value Store persistence (per-entity
       fingerprints + per-source baseline-completion flags)
                                   │
                                   ▼
      Apify Dataset (pay-per-event push)
           + src/notifier.ts (bilingual webhook / Slack / Teams,
             status-change visual accents, fired only on
             STATUS_CHANGED or NEW_ENTITY)
```

## Testing

```bash
npm test
```

135 real, passing tests across 11 files:

- [`test/bilingualNormalizer.test.ts`](test/bilingualNormalizer.test.ts) — unit and
  **property-based** (via `fast-check`) tests for Arabic diacritic/alef/yeh/digit normalization,
  bidi-control stripping, and English legal-form canonicalization — including the real trailing-
  period regex bug this suite caught during development (see AGENTS.md §2).
- [`test/fuzzing.test.ts`](test/fuzzing.test.ts) — dedicated stochastic fuzzing (an explicit
  mandate deliverable): random mixed Arabic/English/bidi-control/astral-plane-surrogate-pair
  strings verifying zero-crash guarantees across the full normalization and entity-normalization
  pipeline, plus malformed-row handling that fails loudly rather than silently.
- [`test/deltaEngine.test.ts`](test/deltaEngine.test.ts) — per-source normalization against real
  captured field shapes, SHA-256 fingerprint behavior, and the full classify/shouldDeliver state
  machine, including a regression test for the real `onlyNew`/`ENTITY_UNCHANGED` delivery bug this
  suite caught during development (see AGENTS.md §4).
- [`test/adgmSource.test.ts`](test/adgmSource.test.ts) / [`test/difcSource.test.ts`](test/difcSource.test.ts) / [`test/dubaiPulseSource.test.ts`](test/dubaiPulseSource.test.ts) —
  HTTP retry/backoff/timeout, pagination, non-retryable-4xx handling, and (for Dubai Pulse
  specifically) defensive multi-shape response-envelope handling and full coverage of both the
  license and trade-name fetchers.
- [`test/notifier.test.ts`](test/notifier.test.ts) — payload-shape, escaping, bilingual-name, and
  status-accent-color tests for all three channels, including a regression test for the real Slack
  `<!channel>`-injection bug this suite caught during development (see AGENTS.md §7.1).
- [`test/state.test.ts`](test/state.test.ts) — Key-Value Store round-tripping.
- [`test/routes.test.ts`](test/routes.test.ts) — unit tests for the pure per-entity logic.
- [`test/integration.test.ts`](test/integration.test.ts) — a full multi-run, multi-source
  lifecycle simulation (baseline → unchanged → a real status change and a cosmetic update in the
  same run → a new entity) verifying every delta trigger fires correctly, plus regression tests
  for maxItems-truncation safety, per-source failure isolation, the `eventChargeLimitReached` stop
  condition, Dubai-mainland's no-API-key skip path, and a malformed-row-alongside-a-valid-row case
  exercised through `run()` itself.
- [`test/main.test.ts`](test/main.test.ts) — shutdown-safety wiring: the `migrating`/`aborting`
  handlers actually flush state when invoked, a flush failure never crashes the shutdown path, and
  state is saved even when `run()` fails.

A dedicated 5-dimension adversarial review found and fixed 9 real issues after the above suite
already passed cleanly (a Slack injection vector, a silent data-join collision, a real ADGM field
being dropped entirely, a normalizer bug in this module's own documented example, dead
configuration, three test-coverage gaps, and a transcription error in this very README) - the full
list, with the exact failure scenario for each, is in
[AGENTS.md §7](AGENTS.md#7-adversarial-review-findings).

## CI/CD

[`.github/workflows/test.yaml`](.github/workflows/test.yaml): every push and pull request runs
lint, type-check/build, and the full test suite — a public quality signal, not a deploy pipeline.
Deployment to Apify is manual (`apify login --token` + `apify push`), matching how every actor
across this developer's portfolio is actually shipped; see
[`docs/GITHUB_REMOTE_SETUP.md`](docs/GITHUB_REMOTE_SETUP.md) for detail.

---

This actor is part of **Delta Registry** — pay-per-event regulatory & compliance data
infrastructure built and operated by Stefano Seggio. For the rest of the fleet, see
[github.com/stefanoseggio](https://github.com/stefanoseggio).
