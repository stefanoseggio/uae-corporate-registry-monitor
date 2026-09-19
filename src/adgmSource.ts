import { log } from 'apify';
import { Impit } from 'impit';

import { createRunDeadline, type RunDeadline } from './timeBudget.js';
import type { AdgmEntityRow } from './types.js';
import { NonRetryableFetchError } from './types.js';

// impit gives every request a real, internally-consistent Chrome TLS/HTTP2 fingerprint (JA3/JA4),
// unlike Node's native fetch/undici, whose fingerprint is a well-known automation signal to
// bot-management layers. A single module-level instance is reused across every ADGM request
// (bootstrap page load and every paginated Aura POST) so they share one connection pool/cookie
// jar, exactly like a real browser tab would. See AGENTS.md's "HTTP transport" section for why
// this is applied here but NOT in dubaiPulseSource.ts.
const impit = new Impit({ browser: 'chrome' });

const SEARCH_PAGE_URL = 'https://newreg.adgm.com/s/search-results';
const AURA_ENDPOINT = 'https://newreg.adgm.com/s/sfsites/aura';
const USER_AGENT = 'Mozilla/5.0 (compatible; DeltaRegistryComplianceMonitor/1.0; +https://apify.com)';
const MAX_RETRY_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
/**
 * Reserved for row processing/pushing/notifying of whatever ADGM rows are already collected once
 * fetching stops, plus DIFC_FREEZONE still queued behind ADGM_FREEZONE in routes.ts's run() loop
 * when both are selected (the actor's DEFAULT_DATA_SOURCES) - see timeBudget.ts.
 */
const FETCH_TIME_BUDGET_SAFETY_MARGIN_MS = 60_000;

/**
 * The exact `jsonSearchString` field-schema object ADGM's own guest search page echoes back to
 * itself between its "get search config" call and its "submit search" call - captured verbatim
 * from a real, live response this session (see AGENTS.md section 0.3). Only
 * `generalSearch[0].headers[0].value` (the name filter), `pageNumber`, and `pageSize` are mutated
 * per request; everything else is ADGM's own object-model metadata, not user-specific state, so
 * reusing a captured copy rather than re-fetching the config every run is a deliberate
 * fewer-requests optimization, not a shortcut - it is exactly what a real browser session does for
 * the lifetime of one page view.
 */
function buildJsonSearchString(nameFilter: string, pageNumber: number, pageSize: number): string {
    const template = {
        advancedSearch: [
            {
                fieldSetName: 'SearchFieldsAdvGen',
                headers: [
                    {
                        dataType: 'BOOLEAN',
                        fieldAPIName: 'Is_continued__c',
                        isRequired: false,
                        label: 'Is continued?',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Entity_Status__c',
                        isRequired: false,
                        label: 'Entity Status',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'DATE',
                        fieldAPIName: 'Incorporation_Date__c',
                        isRequired: false,
                        label: 'Incorporation Date',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Category__c',
                        isRequired: false,
                        label: 'Category',
                        options: [],
                        value: '',
                    },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_auditors: [
            {
                fieldSetName: 'SearchFieldsAuditor',
                headers: [],
                isParent: false,
                objectName: 'Account',
                relationshipName: 'Subject_Account__r',
            },
        ],
        advancedSearch_companies: [
            {
                fieldSetName: 'SearchFieldsAdvComp',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_foliostrataplanstratalot: [
            {
                fieldSetName: 'SearchFieldsFolioStrataPlanLotAdvanced',
                headers: [],
                isParent: false,
                objectName: 'Property__c',
            },
        ],
        advancedSearch_foundation: [
            {
                fieldSetName: 'SearchFieldsAdvFoun',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_general: [
            {
                fieldSetName: 'SearchFieldsAdvGen',
                headers: [
                    {
                        dataType: 'BOOLEAN',
                        fieldAPIName: 'Is_continued__c',
                        isRequired: false,
                        label: 'Is continued?',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Entity_Status__c',
                        isRequired: false,
                        label: 'Entity Status',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'DATE',
                        fieldAPIName: 'Incorporation_Date__c',
                        isRequired: false,
                        label: 'Incorporation Date',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Category__c',
                        isRequired: false,
                        label: 'Category',
                        options: [],
                        value: '',
                    },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_InsolvencyPractitioner: [
            {
                fieldSetName: 'SearchFieldsInsolvencyPractitioner',
                headers: [],
                isParent: false,
                objectName: 'Account',
                relationshipName: 'Subject_Account__r',
            },
        ],
        advancedSearch_partnership: [
            {
                fieldSetName: 'SearchFieldsAdvPart',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedsearch_RegisteredBuilding: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvancedBuilding',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedsearch_RegisteredLand: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvancedLand',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedsearch_RegisteredLease: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvanced',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedsearch_RegisteredUnit: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvancedUnit',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedSearch_reservedname: [
            {
                fieldSetName: 'ReservedName',
                headers: [],
                isParent: true,
                objectName: 'Trade_Name__c',
            },
        ],
        advancedSearch_role: [
            {
                fieldSetName: 'RoleSearchFields',
                headers: [],
                isParent: true,
                objectName: 'Role__c',
            },
            {
                fieldSetName: 'RoleFieldSet',
                headers: [],
                isParent: false,
                objectName: 'Account',
                relationshipName: 'Subject_Account__r',
            },
        ],
        advancedSearch_temporarypermit: [
            {
                fieldSetName: 'TempPermitSearchFields',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        buttonConfig: {
            buttonPlacement: 'RIGHT',
            buttons: [
                {
                    actionType: 'Create_BookMark',
                    label: 'Add to Watchlist',
                    renderCheckField: 'Show_Request_Option__c',
                    renderCheckValue: 'Add BookMark',
                    styleClass: 'requestBtn',
                },
                {
                    actionType: 'Remove_BookMark',
                    label: 'Remove from Watchlist',
                    renderCheckField: 'Show_Request_Option__c',
                    renderCheckValue: 'Remove BookMark',
                    styleClass: 'cancelBtn',
                },
            ],
            canSelectMultiple: false,
            rowLevel: true,
        },
        defaultOrderBy: 'ASC',
        generalSearch: [
            {
                fieldSetName: 'SearchFields',
                headers: [
                    {
                        dataType: 'STRING',
                        fieldAPIName: 'Name',
                        isRequired: false,
                        label: 'Account Name',
                        options: [],
                        value: nameFilter,
                    },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        generalSearch_Folio: [
            {
                fieldSetName: 'SearchFieldsFolioGeneral',
                headers: [],
                isParent: true,
                objectName: 'Property__c',
            },
        ],
        generalsearch_RegisteredLease: [
            {
                fieldSetName: 'SearchFieldsLeaseGeneral',
                headers: [],
                isParent: true,
                objectName: 'Linked_Unit__c',
            },
        ],
        generalSearch_StrataLot: [
            {
                fieldSetName: 'SearchFieldsStrataLotGeneral',
                headers: [],
                isParent: true,
                objectName: 'Property__c',
            },
        ],
        generalSearch_StrataPlan: [
            {
                fieldSetName: 'SearchFieldsStrataPlanGeneral',
                headers: [],
                isParent: true,
                objectName: 'Property__c',
            },
        ],
        orderByFields: 'Name',
        resultFieldSet: 'RequestAccessSearchResult',
        showAdvancedSearch: false,
        showRegisteredEntities: true,
        pageNumber,
        pageSize: String(pageSize),
    };
    return JSON.stringify(template);
}

interface AuraBootstrap {
    fwuid: string;
    appLoadedMarker: string;
}

/**
 * ADGM's Aura RPC requires a `fwuid` (Salesforce framework build id) and an app-instance marker
 * that both rotate whenever ADGM's Salesforce org is redeployed - there is no stable, documented
 * long-lived value to hardcode. Both are embedded in the initial search-results page's HTML, in a
 * `/s/sfsites/l/{urlEncodedJson}/bootstrap.js` resource reference - this function fetches that page
 * fresh and regex-extracts them, exactly as a real browser session would read them from its own
 * initial page load before making any Aura call.
 */
async function fetchAuraBootstrap(): Promise<AuraBootstrap> {
    const response = await impit.fetch(SEARCH_PAGE_URL, {
        headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
        throw new Error(`ADGM search page returned HTTP ${response.status} while fetching Aura bootstrap config.`);
    }
    const html = await response.text();
    const bootstrapMatch = /\/s\/sfsites\/l\/(%7B[^"'\s]+?%7D)\/bootstrap\.js/.exec(html);
    if (!bootstrapMatch) {
        throw new Error("Could not locate the Aura bootstrap config in ADGM's search-results page - the site structure may have changed.");
    }
    const decoded = JSON.parse(decodeURIComponent(bootstrapMatch[1])) as {
        fwuid?: string;
        loaded?: Record<string, string>;
    };
    const { fwuid } = decoded;
    const appLoadedMarker = decoded.loaded?.['APPLICATION@markup://siteforce:communityApp'];
    if (!fwuid || !appLoadedMarker) {
        throw new Error("ADGM's Aura bootstrap config was found but is missing fwuid/app-loaded fields - the site structure may have changed.");
    }
    return { fwuid, appLoadedMarker };
}

function buildAuraContext(bootstrap: AuraBootstrap): string {
    return JSON.stringify({
        mode: 'PROD',
        fwuid: bootstrap.fwuid,
        app: 'siteforce:communityApp',
        loaded: {
            'APPLICATION@markup://siteforce:communityApp': bootstrap.appLoadedMarker,
        },
        dn: [],
        globals: {},
        uad: true,
    });
}

interface AuraApexResponse {
    actions: {
        state: string;
        returnValue?: { returnValue?: { data?: { data?: AdgmEntityRow[] } } };
        error?: unknown[];
    }[];
}

async function postAuraSearch(bootstrap: AuraBootstrap, nameFilter: string, pageNumber: number, deadline: RunDeadline): Promise<AdgmEntityRow[]> {
    const message = {
        actions: [
            {
                id: `${pageNumber};a`,
                descriptor: 'aura://ApexActionController/ACTION$execute',
                callingDescriptor: 'UNKNOWN',
                params: {
                    namespace: '',
                    classname: 'RASearchUtil',
                    method: 'getSearchResponseForPR',
                    params: {
                        jsonSearchString: buildJsonSearchString(nameFilter, pageNumber, PAGE_SIZE),
                    },
                    cacheable: false,
                    isContinuation: false,
                },
            },
        ],
    };
    const body = new URLSearchParams({
        message: JSON.stringify(message),
        'aura.context': buildAuraContext(bootstrap),
        'aura.pageURI': '/s/search-results',
        'aura.token': 'null',
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
            // remaining retries for THIS page - throwing below, which processAdgm/fetchAllAdgmEntities
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
            const response = await impit.fetch(`${AURA_ENDPOINT}?r=${pageNumber}&aura.ApexAction.execute=1`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': USER_AGENT,
                },
                body: body.toString(),
                signal: timeoutController.signal,
            });
            if (!response.ok) {
                if (response.status >= 500 || response.status === 429) {
                    lastError = new Error(`ADGM Aura endpoint returned HTTP ${response.status}`);
                    continue;
                }
                throw new NonRetryableFetchError(`ADGM Aura endpoint returned non-retryable HTTP ${response.status} - the bootstrap fwuid may be stale.`);
            }
            const json = (await response.json()) as AuraApexResponse;
            const action = json.actions[0];
            if (!action || action.state !== 'SUCCESS') {
                // A non-SUCCESS Aura action state is an application-level rejection (e.g. a stale
                // fwuid, or a malformed jsonSearchString), not a transient network condition -
                // retrying it 5 times unchanged would just waste the retry budget on a guaranteed
                // repeat failure, exactly like the non-retryable-4xx case above.
                throw new NonRetryableFetchError(`ADGM Aura search action did not succeed: ${JSON.stringify(action?.error ?? 'unknown error')}`);
            }
            // `state === 'SUCCESS'` only confirms the Apex call itself didn't error - it says
            // NOTHING about whether the expected `returnValue.returnValue.data.data` result path is
            // actually present. Found by adversarial review: the previous `?? []` fallback here
            // treated a structurally-broken response (a redirected/bot-check page that still parses
            // as JSON, or ADGM reshaping RASearchUtil.getSearchResponseForPR's envelope) exactly the
            // same as a real, well-formed empty page - both silently became `[]`. Since
            // fetchAllAdgmEntities() stops paginating as soon as one page returns fewer than
            // PAGE_SIZE rows, a shifted path on page 1 alone reads as "ADGM's whole register is
            // empty", which (via processAdgm's recordSourceChecked) can wrongly mark this source's
            // baseline as complete despite zero entities ever having been recorded - poisoning the
            // delta baseline and causing every real entity to be misclassified as a brand-new
            // NEW_ENTITY (and re-notified/re-charged) the next time the fetch actually works. Only a
            // *present* `data` object whose own `data` field is a real Array is trusted as a genuine
            // (possibly legitimately empty) result page; anything else is a structural break that
            // must fail loudly instead of masquerading as "zero results".
            const dataContainer = action.returnValue?.returnValue?.data;
            if (dataContainer === undefined || dataContainer === null || !Array.isArray(dataContainer.data)) {
                throw new NonRetryableFetchError(
                    `ADGM Aura search reported SUCCESS but its response did not contain the expected returnValue.returnValue.data.data array - the site's response shape may have changed (or the page returned a bot-check/interstitial instead of real search results). Raw returnValue: ${JSON.stringify(action.returnValue).slice(0, 500)}`,
                );
            }
            return dataContainer.data;
        } catch (error) {
            if (error instanceof NonRetryableFetchError) throw error;
            lastError = error instanceof Error ? error : new Error(String(error));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw new Error(
        abandonedForTimeBudget
            ? `ADGM Aura search for page ${pageNumber} abandoned after ${attemptsMade} of ${MAX_RETRY_ATTEMPTS} attempt(s): the actor's run-level time budget is nearly exhausted, so remaining retries were skipped to leave time to push whatever pages were already fetched. Last error: ${lastError?.message ?? 'previous attempt(s) failed'}`
            : `ADGM Aura search failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
    );
}

/** `complete: false` means pagination stopped before a genuine last/short page was reached (a real full-register enumeration did NOT happen this run) - see fetchAllAdgmEntities. */
export interface AdgmFetchResult {
    rows: AdgmEntityRow[];
    complete: boolean;
}

/**
 * Fetches every page of ADGM's public register with a blank name filter (true bulk enumeration,
 * not a per-company lookup - see AGENTS.md section 0.3 for the live confirmation that a
 * blank search returns "Displaying 1 - 10 of 18745 Results" with full pagination). Stops when a
 * page returns fewer rows than PAGE_SIZE (the standard last-page signal) or an empty page.
 *
 * CONFIRMED BUG FIX: this used to always report a full enumeration to its caller regardless of how
 * pagination actually ended. `complete` now distinguishes a genuine last-page stop from an early
 * stop (the MAX_PAGES safety valve, or the new run-level time budget guard below) - routes.ts uses
 * this to avoid marking ADGM_FREEZONE's delta baseline complete after a run that never actually
 * finished enumerating the register, which would otherwise misclassify every not-yet-reached real
 * entity as a brand-new NEW_ENTITY (and re-notify/re-charge for it) once a later run finally reaches
 * it, rather than correctly treating it as still part of an unfinished baseline.
 */
export async function fetchAllAdgmEntities(): Promise<AdgmFetchResult> {
    // See timeBudget.ts: the actor's real, live run deadline (Actor.getEnv().timeoutAt), not a
    // hardcoded copy of timeoutSecs. Checked before each retry attempt (in postAuraSearch) and
    // before each new page below, so pagination and per-page retries self-terminate with a real
    // safety margin instead of risking the whole run being hard-killed mid-fetch.
    const deadline = createRunDeadline(FETCH_TIME_BUDGET_SAFETY_MARGIN_MS);
    const bootstrap = await fetchAuraBootstrap();
    const allRows: AdgmEntityRow[] = [];
    let pageNumber = 1;
    // A defensive upper bound on pages, not a silent coverage cap: 18,745 real entities observed at
    // PAGE_SIZE=50 is ~375 pages; 2000 pages (100,000 entities) is generously above any plausible
    // near-term growth of ADGM's register, so hitting this indicates a genuine pagination bug
    // (e.g. an endless duplicate page) rather than legitimate exhaustive coverage being cut short.
    const MAX_PAGES = 2000;
    let stoppedForTimeBudget = false;
    while (pageNumber <= MAX_PAGES) {
        if (pageNumber > 1 && deadline.isExpired()) {
            stoppedForTimeBudget = true;
            log.warning(
                `ADGM_FREEZONE: stopping pagination early at page ${pageNumber} (${allRows.length} entities collected so far) because the actor's run-level time budget is nearly exhausted. This is NOT a full enumeration of ADGM's register this run - the baseline will not be marked complete, so every remaining entity is safely re-evaluated on a future run instead of being misclassified as newly appeared.`,
            );
            break;
        }
        const rows = await postAuraSearch(bootstrap, '', pageNumber, deadline);
        allRows.push(...rows);
        if (rows.length < PAGE_SIZE) break;
        pageNumber += 1;
    }
    if (pageNumber > MAX_PAGES) {
        log.warning(
            `ADGM pagination exceeded ${MAX_PAGES} pages without reaching a final short page - stopping early. This may indicate a real ADGM site change; ${allRows.length} entities were collected before stopping.`,
        );
    }
    const complete = !stoppedForTimeBudget && pageNumber <= MAX_PAGES;
    return { rows: allRows, complete };
}
