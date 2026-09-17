# Changelog

## 2026-09-17

Published to the Apify Store as `stefano_seggio/uae-corporate-registry-monitor` (actor ID
`BmhA43NYN15DxOLTD`).

### Added

- Standalone, zero-dependency external health-probe script (`docs/monitoring/uae_probe.js`) and an
  operational playbook (`docs/monitoring/UAE_OUTAGE_PLAYBOOK.md`) after a live production audit
  found ADGM and DIFC — this actor's two zero-setup default data sources — both down due to
  confirmed, reproducible, government-side server defects: a `NullPointerException` in ADGM's own
  Salesforce Apex controller, and a live HTTP 500 from DIFC's `/api/handleRequest` route. Neither
  is fixable by a client-side code change; see `AGENTS.md`'s "Retry and error-handling design"
  section for the full record.

### Fixed

- Added up to 30% random jitter to the retry backoff delay in `src/adgmSource.ts` and
  `src/difcSource.ts`, matching the sibling TED actor's `tedClient.ts` formula, to avoid a
  thundering-herd retry pattern across concurrent runs once both sources recover.
  `src/dubaiPulseSource.ts` was deliberately left on its original unjittered formula, since it has
  no live default-input exposure and was out of scope for this pass.

## 1.0.0 - 2026-09-16

Initial release.

- **ADGM (Abu Dhabi Global Market) and DIFC (Dubai International Financial Centre) public register monitoring**: fully anonymous, live-verified, bulk-queryable integrations. Detects new entity registrations and entity/license status changes (e.g. Registered -> Deregistered, Active -> Dissolved/Inactive - Struck Off).
- **Dubai mainland trade-license monitoring (Dubai Pulse)**: best-effort integration against DED's `ded_license_master-open`/`ded_trade_name-open` datasets. Requires the user's own Dubai Pulse API key (obtained via Dubai Pulse's own approval process - see README "Dubai mainland setup"). This integration's exact wire format could not be verified against live traffic during development; see AGENTS.md section 0.2 and the confidence-tier notice in `src/dubaiPulseSource.ts`.
- **Bilingual Arabic/English entity-name normalization** (`src/bilingualNormalizer.ts`): diacritic stripping, alef/yeh variant normalization, Arabic-Indic digit conversion, bidi-control-character stripping, and UAE-specific English legal-entity-suffix canonicalization (LLC, FZ-LLC, PJSC, Sole Establishment, etc.).
- **Delta engine** distinguishing BASELINE_SNAPSHOT, NEW_ENTITY, STATUS_CHANGED, ENTITY_UPDATED, and ENTITY_UNCHANGED, with separate status and content fingerprints so a status transition is never conflated with a cosmetic content edit.
- **Multi-channel alerting** (generic webhook, Slack Block Kit, Microsoft Teams Adaptive Cards via the current "Workflows" webhook mechanism) with bilingual payloads and status-change visual accents.
- **135 automated tests** across 11 files: unit, property-based (via `fast-check`), dedicated fuzzing (`test/fuzzing.test.ts`), and full-lifecycle integration tests.
- **9 confirmed findings from a 5-dimension adversarial review fixed before release**, including a Slack `<!channel>`-injection vector, a silent Dubai trade-name join collision, a real ADGM field (`Trade_Names__r`) that was captured live but never mapped into the delta engine, and a normalizer bug in this module's own documented example - full list in AGENTS.md section 7.
- **Corrected mandate assumptions** (see AGENTS.md section 3 for the full record): no single open, bulk-queryable "UAE Mainland Corporate Registry" exists across all emirates; the UAE's federal National Economic Register ("Growth") is a UAE Pass-gated lookup tool, not a bulk API; officer/manager-level data is not exposed by any of the three verified public sources' list views.
