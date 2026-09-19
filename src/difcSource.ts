import { log } from 'apify';

import { createRunDeadline, type RunDeadline } from './timeBudget.js';
import type { DifcCompanyRow } from './types.js';
import { NonRetryableFetchError } from './types.js';

const HANDLE_REQUEST_URL = 'https://www.difc.com/api/handleRequest';
const USER_AGENT = 'Mozilla/5.0 (compatible; DeltaRegistryComplianceMonitor/1.0; +https://apify.com)';
const MAX_RETRY_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
/** The real page size observed live for this endpoint (10 rows per default-list response, see AGENTS.md section 0.4). Not independently confirmable as configurable - no page-size parameter was observed in the real captured request, so this actor paginates purely via `offset`. */
const OBSERVED_PAGE_SIZE = 10;
/**
 * Reserved for row processing/pushing/notifying of whatever DIFC rows are already collected once
 * fetching stops, plus whatever data source still runs after DIFC_FREEZONE in routes.ts's run()
 * loop - see timeBudget.ts and adgmSource.ts's identical FETCH_TIME_BUDGET_SAFETY_MARGIN_MS.
 */
const FETCH_TIME_BUDGET_SAFETY_MARGIN_MS = 60_000;

interface DifcApiResponse {
    Data: { companyList: DifcCompanyRow[] } | null;
    IsSuccess: boolean;
    Message: string | null;
}

/**
 * DIFC's public register is served through a simple, real, anonymous Next.js API proxy route -
 * live-verified this session (see AGENTS.md section 0.4): `POST /api/handleRequest` with a
 * `{name, licenseType, licenseNo, status, offset, slug: "/CRM/public-register", method: "POST"}`
 * body, all filter fields blank for full bulk enumeration. This is a dramatically simpler and more
 * stable integration than ADGM's Salesforce Aura RPC (no rotating framework-build id to bootstrap),
 * since it is DIFC's own first-party Next.js backend route rather than a raw CRM RPC surface.
 */
async function fetchDifcPage(offset: number, deadline: RunDeadline): Promise<DifcCompanyRow[]> {
    const requestBody = JSON.stringify({
        name: '',
        licenseType: '',
        licenseNo: '',
        status: '',
        offset,
        slug: '/CRM/public-register',
        method: 'POST',
    });

    let lastError: Error | undefined;
    let attemptsMade = 0;
    let abandonedForTimeBudget = false;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            // CONFIRMED BUG FIX: this retry loop used to back off and retry unconditionally, with
            // no awareness of the actor's own run timeout - a single page whose every attempt
            // times out could alone burn up to ~189s (5 x 30s REQUEST_TIMEOUT_MS + ~39s of
            // worst-case backoff below), and just a handful of such pages exhausts the actor's
            // real 600s run timeout outright. Checking the real run deadline here means we abandon
            // remaining retries for THIS page - throwing below, which processDifc/fetchAllDifcCompanies
            // already handle as a normal recoverable failure - rather than risking the whole run
            // (and every page already fetched) being hard-killed by the platform with nothing pushed.
            if (deadline.isExpired()) {
                abandonedForTimeBudget = true;
                break;
            }
            // Exponential backoff plus up to 30% random jitter (matches tedClient.ts's
            // backoffDelay()) - without jitter, many concurrent Apify runs retrying on the exact
            // same 1s/2s/4s/8s/16s schedule could thunder-herd the same request at ADGM/DIFC.
            const exponential = Math.min(1000 * 2 ** attempt, 30_000);
            await new Promise((resolve) => {
                setTimeout(resolve, exponential + Math.random() * exponential * 0.3);
            });
        }
        attemptsMade += 1;
        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(HANDLE_REQUEST_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': USER_AGENT,
                },
                body: requestBody,
                signal: timeoutController.signal,
            });
            if (!response.ok) {
                if (response.status >= 500 || response.status === 429) {
                    lastError = new Error(`DIFC handleRequest returned HTTP ${response.status}`);
                    continue;
                }
                throw new NonRetryableFetchError(`DIFC handleRequest returned non-retryable HTTP ${response.status}`);
            }
            const json = (await response.json()) as DifcApiResponse;
            if (!json.IsSuccess) {
                // An IsSuccess: false response is an application-level rejection, not a transient
                // network condition - retrying it unchanged would just waste the retry budget.
                throw new NonRetryableFetchError(`DIFC handleRequest reported failure: ${json.Message ?? 'no message'}`);
            }
            // `IsSuccess: true` only confirms DIFC's own handleRequest proxy didn't reject the call -
            // it says NOTHING about whether the expected Data.companyList array is actually present.
            // Found by adversarial review: the previous `?? []` fallback here treated a
            // structurally-broken response (DIFC's Next.js route reshaping its envelope, or returning
            // IsSuccess:true with a redirected/empty shell body) exactly the same as a real,
            // well-formed empty page - both silently became `[]`. Since fetchAllDifcCompanies() stops
            // paginating as soon as one page returns fewer than OBSERVED_PAGE_SIZE rows, a shifted
            // shape on the very first page reads as "DIFC's whole register is empty", which (via
            // processDifc's recordSourceChecked) can wrongly mark this source's baseline as complete
            // despite zero companies ever having been recorded - poisoning the delta baseline and
            // causing every real company to be misclassified as a brand-new NEW_ENTITY (and
            // re-notified/re-charged) the next time the fetch actually works. Only a *present* Data
            // object whose own companyList field is a real Array is trusted as a genuine (possibly
            // legitimately empty) result page - matching the existing "empty first page" test fixture
            // exactly (`Data: { companyList: [] }`) - anything else is a structural break that must
            // fail loudly instead of masquerading as "zero results".
            if (json.Data === null || json.Data === undefined || !Array.isArray(json.Data.companyList)) {
                throw new NonRetryableFetchError(
                    `DIFC handleRequest reported IsSuccess but its response did not contain the expected Data.companyList array - the site's response shape may have changed. Raw response: ${JSON.stringify(json).slice(0, 500)}`,
                );
            }
            return json.Data.companyList;
        } catch (error) {
            if (error instanceof NonRetryableFetchError) throw error;
            lastError = error instanceof Error ? error : new Error(String(error));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw new Error(
        abandonedForTimeBudget
            ? `DIFC handleRequest for offset ${offset} abandoned after ${attemptsMade} of ${MAX_RETRY_ATTEMPTS} attempt(s): the actor's run-level time budget is nearly exhausted, so remaining retries were skipped to leave time to push whatever pages were already fetched. Last error: ${lastError?.message ?? 'previous attempt(s) failed'}`
            : `DIFC handleRequest failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
    );
}

/** `complete: false` means pagination stopped before a genuine last/short page was reached (a real full-register enumeration did NOT happen this run) - see fetchAllDifcCompanies. */
export interface DifcFetchResult {
    rows: DifcCompanyRow[];
    complete: boolean;
}

/**
 * Fetches every page of DIFC's public register with all filters blank (true bulk enumeration).
 * Stops on the first page returning fewer than OBSERVED_PAGE_SIZE rows, mirroring adgmSource.ts's
 * last-page signal.
 *
 * CONFIRMED BUG FIX: this used to always report a full enumeration to its caller regardless of how
 * pagination actually ended. `complete` now distinguishes a genuine last-page stop from an early
 * stop (the MAX_PAGES safety valve, or the new run-level time budget guard below) - routes.ts uses
 * this to avoid marking DIFC_FREEZONE's delta baseline complete after a run that never actually
 * finished enumerating the register, which would otherwise misclassify every not-yet-reached real
 * company as a brand-new NEW_ENTITY (and re-notify/re-charge for it) once a later run finally
 * reaches it, rather than correctly treating it as still part of an unfinished baseline.
 */
export async function fetchAllDifcCompanies(): Promise<DifcFetchResult> {
    // See timeBudget.ts: the actor's real, live run deadline (Actor.getEnv().timeoutAt), not a
    // hardcoded copy of timeoutSecs. Checked before each retry attempt (in fetchDifcPage) and
    // before each new page below, so pagination and per-page retries self-terminate with a real
    // safety margin instead of risking the whole run being hard-killed mid-fetch.
    const deadline = createRunDeadline(FETCH_TIME_BUDGET_SAFETY_MARGIN_MS);
    const allRows: DifcCompanyRow[] = [];
    let offset = 0;
    const MAX_PAGES = 5000;
    let pagesFetched = 0;
    let stoppedForTimeBudget = false;
    while (pagesFetched < MAX_PAGES) {
        if (pagesFetched > 0 && deadline.isExpired()) {
            stoppedForTimeBudget = true;
            log.warning(
                `DIFC_FREEZONE: stopping pagination early at offset ${offset} (${allRows.length} companies collected so far) because the actor's run-level time budget is nearly exhausted. This is NOT a full enumeration of DIFC's register this run - the baseline will not be marked complete, so every remaining company is safely re-evaluated on a future run instead of being misclassified as newly appeared.`,
            );
            break;
        }
        const rows = await fetchDifcPage(offset, deadline);
        allRows.push(...rows);
        pagesFetched += 1;
        if (rows.length < OBSERVED_PAGE_SIZE) break;
        offset += OBSERVED_PAGE_SIZE;
    }
    const complete = !stoppedForTimeBudget && pagesFetched < MAX_PAGES;
    return { rows: allRows, complete };
}
