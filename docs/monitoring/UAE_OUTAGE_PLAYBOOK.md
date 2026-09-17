# UAE Registry Outage — Operational Playbook

**Scope:** what to do about the two live, ongoing, government-side outages affecting this actor's
default data sources (ADGM_FREEZONE, DIFC_FREEZONE), and how to safely re-enable full multi-source
polling once they recover. This is an operational document, not a design document — see
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the actor's own resilience design (retry/backoff,
`NonRetryableFetchError` classification, per-source failure isolation).

## Current, confirmed status (as of 2026-09-17, 4 independent checks between 04:56 and 05:25 UTC)

| Source        | Status  | Signature                                                                                                                                                                                | Client-side fix possible?                                                                                                                                                                                                                                         |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADGM_FREEZONE | 🔴 DOWN | `System.NullPointerException` ("null input to JSON parser") at `Class.RASearchUtil.getSearchResponseForPR: line 2889, column 1` — a live defect in ADGM's own Salesforce Apex controller | **No.** This is thrown by ADGM's own server-side code before it ever produces a response the actor's client-side retry logic could route around.                                                                                                                  |
| DIFC_FREEZONE | 🔴 DOWN | Live HTTP 500 from DIFC's own `/api/handleRequest` Next.js route                                                                                                                         | **No.** The actor's existing 5-attempt retry loop already exhausts against this exact failure every time (confirmed both in production runs and in independent standalone tests) — more retries do not help a server that is genuinely erroring on every attempt. |

Both failures reproduce identically on fresh, independent requests (a fresh ADGM bootstrap token,
a fresh DIFC connection) — this rules out a stale-token or connection-pooling explanation on this
actor's side. They are real, current, external conditions.

## How to check current status yourself

```bash
node docs/monitoring/uae_probe.js
```

This is a standalone, zero-dependency Node.js script (no `npm install` needed, no Apify runtime
required) that sends the exact same first-page request shape the actor itself uses, against the
real ADGM and DIFC endpoints, and classifies the result. Exit code `0` means both sources are up;
`1` means at least one is still down; `2` means the probe script itself broke (a bug in the probe,
not a finding about ADGM/DIFC — check your Node version, which must be 20+).

For machine-readable output (for a script, cron job, or CI step to parse):

```bash
node docs/monitoring/uae_probe.js --json
```

To track state across runs and get an explicit "this just recovered" signal instead of having to
diff two outputs yourself:

```bash
node docs/monitoring/uae_probe.js --state-file /path/to/uae_probe_state.json
```

On the first run this just records the current state. On every subsequent run, if a source that
was previously `DOWN_KNOWN` or `DOWN_UNKNOWN` comes back `UP`, its status is reported as
`RESOLVED` instead of a plain `UP`, and a `>>> ACTION NEEDED` line is printed — that is your signal
to act on the section below, not just a status update to skim past.

**A note on `DOWN_UNKNOWN` vs `DOWN_KNOWN`:** if a probe ever reports `DOWN_UNKNOWN`, that means
the failure it saw does NOT match the exact signatures documented above (a different exception, a
different HTTP status, a timeout, a network error). Treat that as more urgent than a routine
`DOWN_KNOWN` check-in — it means the situation changed in some way not yet accounted for, and
needs a human look at the probe's `detail` field before assuming it's "the same outage as before."

## Recommended check cadence while both sources are down

There is no value in checking more than a few times a day — a government backend defect like
ADGM's `NullPointerException` is not the kind of issue that resolves itself minute-to-minute. A
reasonable cadence:

- **Manually, once every 24-72 hours** — simplest, no infrastructure needed, matches the realistic
  pace at which a third party fixes a server-side bug.
- **Or, once this repository has a GitHub remote** (see
  [`../GITHUB_REMOTE_SETUP.md`](../GITHUB_REMOTE_SETUP.md)), a scheduled GitHub Actions workflow
  can run this probe automatically and open an issue or send a notification on a state change. A
  starter workflow for this is intentionally NOT included in this pass — wiring up a recurring,
  autonomous, unattended job (as opposed to a script you run on demand) is a standing operational
  commitment worth deciding deliberately, not something to silently add. If you want it, the probe
  script's `--json` output and exit codes are already designed to make that straightforward to add
  later (`node docs/monitoring/uae_probe.js --json --state-file state.json`, parse the JSON,
  `exit 1` maps directly to a failed/alerting CI step).

Do **not** poll more aggressively than this — both endpoints are real government infrastructure,
not a service built to absorb frequent automated health-checks, and the actor's own daily
production runs (once re-enabled) already exercise these endpoints once a day.

## Re-enabling a recovered source

When the probe reports `RESOLVED` for a source (or you've manually confirmed `UP` twice, a few
hours apart, to rule out a flapping/intermittent recovery rather than a genuine fix):

1. **Confirm with the real actor code, not just the probe.** The probe intentionally sends a
   minimal, single-page request; before trusting full production traffic to a newly-recovered
   source, run the actual actor with only that source selected:
    ```bash
    apify call BmhA43NYN15DxOLTD --timeout 300
    ```
    with input `{"dataSources": ["ADGM_FREEZONE"]}` (or `["DIFC_FREEZONE"]`) via the Apify Console's
    "Save as a new task" / Input tab, or via `apify call <actorId> --input '{"dataSources":["ADGM_FREEZONE"]}'`.
    Confirm it completes `SUCCEEDED` and pushes real, sane-looking records (correct field shapes,
    no obviously-truncated or malformed entity data) — a source can return HTTP 200 while still
    emitting corrupted data if it's mid-recovery, which the probe's shallow check (one page, does
    the response parse and report success) would not catch on its own.
2. **No code change is needed to re-enable a source that's already in the default `dataSources`
   array** (`ADGM_FREEZONE` and `DIFC_FREEZONE` both already are — see
   `.actor/input_schema.json`). Recovery on the government's end is enough; this actor's own retry
   and error-handling code was never the blocker (see `docs/ARCHITECTURE.md`'s 2026-09-17 update
   in the "Retry and error-handling design" section).
3. **Update this playbook and `.actor/audit_manifest.json`'s `resilienceAudit`/`knownRisks`
   fields** to reflect the recovery date and remove the "HIGH, UNRESOLVED, EXTERNAL" risk entry —
   leave a dated note rather than silently deleting the history of the incident, so a future reader
   understands this actor has weathered a real, multi-day-or-longer external outage before.
4. **If only one of the two sources recovers first,** there is nothing else to do — the actor's
   existing per-source isolation (see `docs/ARCHITECTURE.md`) already delivers whatever the
   healthy source finds while continuing to gracefully skip the still-down one. No manual
   toggling of `dataSources` is needed either way; a still-down source degrades gracefully on its
   own each run regardless of what else is enabled.

## What would make this playbook wrong, and how you'd know

This playbook assumes both failures are genuinely external and unfixable from this actor's side.
That assumption was checked, not assumed: both failures were reproduced independently, multiple
times, directly against the real endpoints, outside of any Apify run, using fresh tokens/requests
each time — ruling out a stale-credential or actor-side caching explanation. If a future probe
ever shows a DIFFERENT error shape than the two documented signatures (`DOWN_UNKNOWN` rather than
`DOWN_KNOWN`), do not assume this playbook still applies without rereading `docs/ARCHITECTURE.md`'s
resilience section and re-verifying the new failure mode the same way — a different failure could
have a different, possibly actor-side, cause.
