import type { DifcCompanyRow } from './types.js';
import { NonRetryableFetchError } from './types.js';

const HANDLE_REQUEST_URL = 'https://www.difc.com/api/handleRequest';
const USER_AGENT = 'Mozilla/5.0 (compatible; DeltaRegistryComplianceMonitor/1.0; +https://apify.com)';
const MAX_RETRY_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
/** The real page size observed live for this endpoint (10 rows per default-list response, see AGENTS.md section 0.4). Not independently confirmable as configurable - no page-size parameter was observed in the real captured request, so this actor paginates purely via `offset`. */
const OBSERVED_PAGE_SIZE = 10;

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
async function fetchDifcPage(offset: number): Promise<DifcCompanyRow[]> {
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
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            // Exponential backoff plus up to 30% random jitter (matches tedClient.ts's
            // backoffDelay()) - without jitter, many concurrent Apify runs retrying on the exact
            // same 1s/2s/4s/8s/16s schedule could thunder-herd the same request at ADGM/DIFC.
            const exponential = Math.min(1000 * 2 ** attempt, 30_000);
            await new Promise((resolve) => {
                setTimeout(resolve, exponential + Math.random() * exponential * 0.3);
            });
        }
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
    throw new Error(`DIFC handleRequest failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`);
}

/**
 * Fetches every page of DIFC's public register with all filters blank (true bulk enumeration).
 * Stops on the first page returning fewer than OBSERVED_PAGE_SIZE rows, mirroring adgmSource.ts's
 * last-page signal.
 */
export async function fetchAllDifcCompanies(): Promise<DifcCompanyRow[]> {
    const allRows: DifcCompanyRow[] = [];
    let offset = 0;
    const MAX_PAGES = 5000;
    let pagesFetched = 0;
    while (pagesFetched < MAX_PAGES) {
        const rows = await fetchDifcPage(offset);
        allRows.push(...rows);
        pagesFetched += 1;
        if (rows.length < OBSERVED_PAGE_SIZE) break;
        offset += OBSERVED_PAGE_SIZE;
    }
    return allRows;
}
