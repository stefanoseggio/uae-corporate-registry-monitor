import { log } from 'apify';

import type { AdgmEntityRow } from './types.js';
import { NonRetryableFetchError } from './types.js';

const SEARCH_PAGE_URL = 'https://newreg.adgm.com/s/search-results';
const AURA_ENDPOINT = 'https://newreg.adgm.com/s/sfsites/aura';
const USER_AGENT = 'Mozilla/5.0 (compatible; DeltaRegistryComplianceMonitor/1.0; +https://apify.com)';
const MAX_RETRY_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;

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
    const response = await fetch(SEARCH_PAGE_URL, {
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

async function postAuraSearch(bootstrap: AuraBootstrap, nameFilter: string, pageNumber: number): Promise<AdgmEntityRow[]> {
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
            const response = await fetch(`${AURA_ENDPOINT}?r=${pageNumber}&aura.ApexAction.execute=1`, {
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
            return action.returnValue?.returnValue?.data?.data ?? [];
        } catch (error) {
            if (error instanceof NonRetryableFetchError) throw error;
            lastError = error instanceof Error ? error : new Error(String(error));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw new Error(`ADGM Aura search failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`);
}

/**
 * Fetches every page of ADGM's public register with a blank name filter (true bulk enumeration,
 * not a per-company lookup - see AGENTS.md section 0.3 for the live confirmation that a
 * blank search returns "Displaying 1 - 10 of 18745 Results" with full pagination). Stops when a
 * page returns fewer rows than PAGE_SIZE (the standard last-page signal) or an empty page.
 */
export async function fetchAllAdgmEntities(): Promise<AdgmEntityRow[]> {
    const bootstrap = await fetchAuraBootstrap();
    const allRows: AdgmEntityRow[] = [];
    let pageNumber = 1;
    // A defensive upper bound on pages, not a silent coverage cap: 18,745 real entities observed at
    // PAGE_SIZE=50 is ~375 pages; 2000 pages (100,000 entities) is generously above any plausible
    // near-term growth of ADGM's register, so hitting this indicates a genuine pagination bug
    // (e.g. an endless duplicate page) rather than legitimate exhaustive coverage being cut short.
    const MAX_PAGES = 2000;
    while (pageNumber <= MAX_PAGES) {
        const rows = await postAuraSearch(bootstrap, '', pageNumber);
        allRows.push(...rows);
        if (rows.length < PAGE_SIZE) break;
        pageNumber += 1;
    }
    if (pageNumber > MAX_PAGES) {
        log.warning(
            `ADGM pagination exceeded ${MAX_PAGES} pages without reaching a final short page - stopping early. This may indicate a real ADGM site change; ${allRows.length} entities were collected before stopping.`,
        );
    }
    return allRows;
}
