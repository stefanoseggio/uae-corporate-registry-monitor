# Go-to-market & Apify Store SEO — UAE Corporate Registry Monitor

## The same honest correction as Actors #1-3

Apify Store ranking is percentile-based against the entire marketplace and explicitly weights
real usage, not just title/description keyword match. Metadata below maximizes discoverability at
every stage of this actor's adoption curve — it cannot manufacture a top rank for a zero-review
actor on day one.

## Real Store metadata

**Title** (set in [`.actor/actor.json`](.actor/actor.json)):
> UAE Corporate Registry Monitor - Dubai Mainland, ADGM & DIFC

**Description** (also set in `.actor/actor.json`):
> Delta-tracks UAE corporate registrations and license-status changes across Dubai's DED mainland
> trade-license register (via Dubai Pulse open data), ADGM (Abu Dhabi Global Market), and DIFC
> (Dubai International Financial Centre) public registers. Bilingual Arabic/English entity-name
> normalization. Multi-channel alerting (Slack, Teams, webhook) with status-change visual accents.
> Pay-per-event: billed only for what changed.

**Category**: `BUSINESS` (already set).

## Real competitive landscape (verified live via the Apify Store API on this actor's build date)

Unlike Actors #1-3, this niche is **not empty**. A direct Store API search for `"UAE company
registry"` returned two genuinely relevant existing actors:

1. **"UAE ADGM Public Register Scraper"** (`regdata`) — a direct, real competitor scraping the
   exact same ADGM register this actor covers (company name, registration number, status, type,
   classification, incorporation date, address, trade names).
2. **"UAE Industrial Licence Monitor"** (`getascraper`) — monitors a *different* UAE registry
   entirely (Ministry of Industry and Advanced Technology industrial licenses), not a direct
   competitor, but confirms buyer demand for UAE regulatory-change monitoring exists on the Store.

A separate search for `"DIFC Dubai trade license"` returned **zero** DIFC-specific or
Dubai-mainland/DED-specific competitors — the top results were unrelated (real estate, startup
directories, healthcare).

**Honest positioning given this**: this actor does not enter an empty niche the way Actors #1-3
did. Its real differentiation against the one direct ADGM competitor is genuine, not cosmetic:

- **Three registers in one actor**, not one — ADGM, DIFC, and (with the user's own credentials)
  Dubai mainland, all normalized into the same output schema.
- **Delta/monitoring semantics, not a one-time scrape** — pay-per-event billing tied specifically
  to `NEW_ENTITY` and `STATUS_CHANGED`, with a persisted baseline so re-running the actor doesn't
  re-charge for unchanged entities.
- **Active alerting** (Slack, Teams, generic webhook) with a status-change visual accent, not just
  a downloadable dataset.
- **Bilingual normalization** — relevant specifically to the Dubai-mainland tier, where DED
  publishes both `trade_name_ar` and `trade_name_en`; ADGM/DIFC are English-only common-law free
  zones, so this differentiator applies to one of the three registers, not all three, and is
  described that way rather than oversold as a blanket capability.

## Real target-term mapping

| Target term / intent | How this listing addresses it |
|---|---|
| "ADGM register" / "ADGM company search" | Verbatim in description — the exact free-zone name a compliance buyer searches, alongside the direct competitor's own listing |
| "DIFC company register" | Verbatim — the one segment with zero existing Store competition found |
| "Dubai trade license" / "DED license status" | Verbatim — matches the real Dubai Pulse dataset name and DED's own terminology |
| "UAE company monitoring" / "license status change" | "status-change alerting" — the real mechanism (STATUS_CHANGED events), not a vague "monitoring" claim |
| "Arabic company name" / "bilingual UAE business data" | "Bilingual Arabic/English entity-name normalization" — verbatim, tied to the one tier (Dubai mainland) where it actually applies |

## What actually moves ranking over time

Same as Actors #1-3: early real usage and reviews compound faster than any further metadata
iteration. Given a real, existing single-register competitor already exists for ADGM specifically,
this actor's differentiated pitch (three registers, real delta/alerting semantics, not just a
scrape) is the argument to lead with in any organic-engagement outreach — not a claim of being
first-to-market, which would be false here unlike Actors #1-3.
