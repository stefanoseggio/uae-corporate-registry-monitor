#!/usr/bin/env node
/**
 * Standalone, dependency-free health probe for ADGM (Aura RPC) and DIFC (Next.js API proxy) —
 * the two zero-setup default data sources for the UAE Corporate Registry Monitor actor
 * (stefano_seggio/uae-corporate-registry-monitor, actor ID BmhA43NYN15DxOLTD).
 *
 * PURPOSE: check whether the two live, ongoing government-side outages documented in this
 * repository's .actor/audit_manifest.json and AGENTS.md have resolved, WITHOUT
 * running the full Apify actor (no Actor.init(), no Key-Value Store, no dataset writes, no
 * Apify platform dependency at all — this runs as a plain Node.js script anywhere Node 20+ is
 * available: `node docs/monitoring/uae_probe.js`).
 *
 * This intentionally does NOT import src/adgmSource.ts or src/difcSource.ts — those export only
 * their full, multi-page bulk-enumeration entry points (fetchAllAdgmEntities/
 * fetchAllDifcCompanies), which would page through the ENTIRE live register just to answer "is
 * this endpoint healthy right now," defeating the point of a lightweight probe. Instead, this
 * script sends the exact same SINGLE first-page request shape those modules use internally
 * (bootstrap + one blank-filter search page for ADGM; one blank-filter offset-0 request for
 * DIFC) — copied here as a static request template, not imported, so this probe stays fully
 * decoupled from the actor's own runtime and this file never needs to change if the actor's
 * internal pagination/retry code changes for unrelated reasons.
 *
 * KNOWN BASELINE FAILURE SIGNATURES (confirmed live, independently, 3 separate times between
 * 2026-09-17 04:56 and 05:06 UTC during this fleet's institutional audit — see
 * .actor/audit_manifest.json's resilienceAudit field):
 *   - ADGM: a live, ongoing System.NullPointerException ("null input to JSON parser") thrown by
 *     ADGM's own Salesforce Apex controller, at the exact stack frame
 *     Class.RASearchUtil.getSearchResponseForPR: line 2889, column 1. This is a server-side
 *     defect in ADGM's own backend, not a client-side bug or transient blip.
 *   - DIFC: a live, ongoing HTTP 500 Internal Server Error from DIFC's own /api/handleRequest
 *     Next.js route.
 *
 * This script classifies each source into exactly one of four states:
 *   UP           - a clean, successful response with real data returned.
 *   DOWN_KNOWN   - the exact, already-documented failure signature above. This is what you
 *                  expect to see until the outage is fixed on the government's own end.
 *   DOWN_UNKNOWN - some OTHER failure (a different exception, a different HTTP status, a
 *                  network-level error, a timeout). This is more urgent than DOWN_KNOWN: it
 *                  means the situation changed and needs a human look, not just "still waiting."
 *   RESOLVED     - special case of UP specifically flagged when the LAST known state (read from
 *                  the --state-file, if provided) was DOWN_KNOWN or DOWN_UNKNOWN. This is the
 *                  signal the operational playbook (docs/monitoring/UAE_OUTAGE_PLAYBOOK.md) tells
 *                  you to act on.
 *
 * USAGE:
 *   node docs/monitoring/uae_probe.js                       # human-readable output, exit 0 if
 *                                                            # both UP, exit 1 if either is down
 *   node docs/monitoring/uae_probe.js --json                # machine-readable JSON on stdout
 *   node docs/monitoring/uae_probe.js --state-file path.json  # persist last-seen state across
 *                                                              # runs and detect UP -> RESOLVED
 *                                                              # transitions (see JSDoc above)
 *
 * EXIT CODES: 0 = both sources UP (or RESOLVED). 1 = at least one source DOWN_KNOWN or
 * DOWN_UNKNOWN. 2 = the probe script itself failed to run (a bug in this script, not a finding
 * about ADGM/DIFC) - distinguished from exit 1 so a scheduler (cron, GitHub Actions) can tell
 * "the sources are down" apart from "the monitor itself is broken."
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const USER_AGENT = 'Mozilla/5.0 (compatible; DeltaRegistryComplianceMonitor/1.0; +https://apify.com)';
const REQUEST_TIMEOUT_MS = 30_000;

const ADGM_SEARCH_PAGE_URL = 'https://newreg.adgm.com/s/search-results';
const ADGM_AURA_ENDPOINT = 'https://newreg.adgm.com/s/sfsites/aura';

const DIFC_HANDLE_REQUEST_URL = 'https://www.difc.com/api/handleRequest';

const KNOWN_ADGM_FAILURE = {
    exceptionType: 'System.NullPointerException',
    stackFrame: 'Class.RASearchUtil.getSearchResponseForPR',
};
const KNOWN_DIFC_FAILURE_STATUS = 500;

/** Exact copy of adgmSource.ts's buildJsonSearchString() request template (blank name filter,
 * page 0) - kept here as a static literal, not imported, so this probe has zero coupling to the
 * actor's own module internals. See the file-level JSDoc above for why. */
function buildAdgmJsonSearchString(nameFilter, pageNumber, pageSize) {
    return JSON.stringify({
        advancedSearch: [
            {
                fieldSetName: 'SearchFieldsAdvGen',
                headers: [
                    { dataType: 'BOOLEAN', fieldAPIName: 'Is_continued__c', isRequired: false, label: 'Is continued?', options: [], value: '' },
                    { dataType: 'PICKLIST', fieldAPIName: 'Entity_Status__c', isRequired: false, label: 'Entity Status', options: [], value: '' },
                    { dataType: 'DATE', fieldAPIName: 'Incorporation_Date__c', isRequired: false, label: 'Incorporation Date', options: [], value: '' },
                    { dataType: 'PICKLIST', fieldAPIName: 'Category__c', isRequired: false, label: 'Category', options: [], value: '' },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_auditors: [{ fieldSetName: 'SearchFieldsAuditor', headers: [], isParent: false, objectName: 'Account', relationshipName: 'Subject_Account__r' }],
        advancedSearch_companies: [{ fieldSetName: 'SearchFieldsAdvComp', headers: [], isParent: true, objectName: 'Account' }],
        advancedSearch_foliostrataplanstratalot: [{ fieldSetName: 'SearchFieldsFolioStrataPlanLotAdvanced', headers: [], isParent: false, objectName: 'Property__c' }],
        advancedSearch_foundation: [{ fieldSetName: 'SearchFieldsAdvFoun', headers: [], isParent: true, objectName: 'Account' }],
        advancedSearch_general: [
            {
                fieldSetName: 'SearchFieldsAdvGen',
                headers: [
                    { dataType: 'BOOLEAN', fieldAPIName: 'Is_continued__c', isRequired: false, label: 'Is continued?', options: [], value: '' },
                    { dataType: 'PICKLIST', fieldAPIName: 'Entity_Status__c', isRequired: false, label: 'Entity Status', options: [], value: '' },
                    { dataType: 'DATE', fieldAPIName: 'Incorporation_Date__c', isRequired: false, label: 'Incorporation Date', options: [], value: '' },
                    { dataType: 'PICKLIST', fieldAPIName: 'Category__c', isRequired: false, label: 'Category', options: [], value: '' },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_InsolvencyPractitioner: [{ fieldSetName: 'SearchFieldsInsolvencyPractitioner', headers: [], isParent: false, objectName: 'Account', relationshipName: 'Subject_Account__r' }],
        advancedSearch_partnership: [{ fieldSetName: 'SearchFieldsAdvPart', headers: [], isParent: true, objectName: 'Account' }],
        advancedsearch_RegisteredBuilding: [{ fieldSetName: 'SearchFieldsLeaseAdvancedBuilding', headers: [], isParent: false, objectName: 'Linked_Unit__c' }],
        advancedsearch_RegisteredLand: [{ fieldSetName: 'SearchFieldsLeaseAdvancedLand', headers: [], isParent: false, objectName: 'Linked_Unit__c' }],
        advancedsearch_RegisteredLease: [{ fieldSetName: 'SearchFieldsLeaseAdvanced', headers: [], isParent: false, objectName: 'Linked_Unit__c' }],
        advancedsearch_RegisteredUnit: [{ fieldSetName: 'SearchFieldsLeaseAdvancedUnit', headers: [], isParent: false, objectName: 'Linked_Unit__c' }],
        advancedSearch_reservedname: [{ fieldSetName: 'ReservedName', headers: [], isParent: true, objectName: 'Trade_Name__c' }],
        advancedSearch_role: [
            { fieldSetName: 'RoleSearchFields', headers: [], isParent: true, objectName: 'Role__c' },
            { fieldSetName: 'RoleFieldSet', headers: [], isParent: false, objectName: 'Account', relationshipName: 'Subject_Account__r' },
        ],
        advancedSearch_temporarypermit: [{ fieldSetName: 'TempPermitSearchFields', headers: [], isParent: true, objectName: 'Account' }],
        buttonConfig: {
            buttonPlacement: 'RIGHT',
            buttons: [
                { actionType: 'Create_BookMark', label: 'Add to Watchlist', renderCheckField: 'Show_Request_Option__c', renderCheckValue: 'Add BookMark', styleClass: 'requestBtn' },
                { actionType: 'Remove_BookMark', label: 'Remove from Watchlist', renderCheckField: 'Show_Request_Option__c', renderCheckValue: 'Remove BookMark', styleClass: 'cancelBtn' },
            ],
            canSelectMultiple: false,
            rowLevel: true,
        },
        defaultOrderBy: 'ASC',
        generalSearch: [
            {
                fieldSetName: 'SearchFields',
                headers: [{ dataType: 'STRING', fieldAPIName: 'Name', isRequired: false, label: 'Account Name', options: [], value: nameFilter }],
                isParent: true,
                objectName: 'Account',
            },
        ],
        generalSearch_Folio: [{ fieldSetName: 'SearchFieldsFolioGeneral', headers: [], isParent: true, objectName: 'Property__c' }],
        generalsearch_RegisteredLease: [{ fieldSetName: 'SearchFieldsLeaseGeneral', headers: [], isParent: true, objectName: 'Linked_Unit__c' }],
        generalSearch_StrataLot: [{ fieldSetName: 'SearchFieldsStrataLotGeneral', headers: [], isParent: true, objectName: 'Property__c' }],
        generalSearch_StrataPlan: [{ fieldSetName: 'SearchFieldsStrataPlanGeneral', headers: [], isParent: true, objectName: 'Property__c' }],
        orderByFields: 'Name',
        resultFieldSet: 'RequestAccessSearchResult',
        showAdvancedSearch: false,
        showRegisteredEntities: true,
        pageNumber,
        pageSize: String(pageSize),
    });
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function probeAdgm() {
    const startedAt = new Date().toISOString();
    try {
        const bootstrapResponse = await fetchWithTimeout(ADGM_SEARCH_PAGE_URL, {
            headers: { 'User-Agent': USER_AGENT },
        });
        if (!bootstrapResponse.ok) {
            return {
                source: 'ADGM_FREEZONE',
                status: 'DOWN_UNKNOWN',
                startedAt,
                detail: `Bootstrap page returned HTTP ${bootstrapResponse.status} (expected 200) - ADGM's site structure or availability may have changed beyond the known Aura NullPointerException.`,
            };
        }
        const html = await bootstrapResponse.text();
        const bootstrapMatch = /\/s\/sfsites\/l\/(%7B[^"'\s]+?%7D)\/bootstrap\.js/.exec(html);
        if (!bootstrapMatch) {
            return {
                source: 'ADGM_FREEZONE',
                status: 'DOWN_UNKNOWN',
                startedAt,
                detail: "Could not locate the Aura bootstrap config in ADGM's search-results page HTML - the site structure has likely changed (this is a DIFFERENT failure mode than the known NullPointerException, and needs investigation, not just waiting).",
            };
        }
        const decoded = JSON.parse(decodeURIComponent(bootstrapMatch[1]));
        const { fwuid } = decoded;
        const appLoadedMarker = decoded.loaded?.['APPLICATION@markup://siteforce:communityApp'];
        if (!fwuid || !appLoadedMarker) {
            return {
                source: 'ADGM_FREEZONE',
                status: 'DOWN_UNKNOWN',
                startedAt,
                detail: 'Aura bootstrap config found but missing fwuid/app-loaded fields - site structure change, not the known NullPointerException.',
            };
        }

        const auraContext = JSON.stringify({
            mode: 'PROD',
            fwuid,
            app: 'siteforce:communityApp',
            loaded: { 'APPLICATION@markup://siteforce:communityApp': appLoadedMarker },
            dn: [],
            globals: {},
            uad: true,
        });
        const message = {
            actions: [
                {
                    id: '0;a',
                    descriptor: 'aura://ApexActionController/ACTION$execute',
                    callingDescriptor: 'UNKNOWN',
                    params: {
                        namespace: '',
                        classname: 'RASearchUtil',
                        method: 'getSearchResponseForPR',
                        params: { jsonSearchString: buildAdgmJsonSearchString('', 0, 1) },
                        cacheable: false,
                        isContinuation: false,
                    },
                },
            ],
        };
        const body = new URLSearchParams({
            message: JSON.stringify(message),
            'aura.context': auraContext,
            'aura.pageURI': '/s/search-results',
            'aura.token': 'null',
        });
        const searchResponse = await fetchWithTimeout(`${ADGM_AURA_ENDPOINT}?r=0&aura.ApexAction.execute=1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
            body: body.toString(),
        });
        if (!searchResponse.ok) {
            return {
                source: 'ADGM_FREEZONE',
                status: 'DOWN_UNKNOWN',
                startedAt,
                detail: `Aura endpoint returned non-retryable-shape HTTP ${searchResponse.status} (the known failure is a 200-with-ERROR-state response, not an HTTP-level error).`,
            };
        }
        const json = await searchResponse.json();
        const action = json.actions?.[0];
        if (action?.state === 'SUCCESS') {
            const rowCount = action.returnValue?.returnValue?.data?.data?.length ?? 0;
            return { source: 'ADGM_FREEZONE', status: 'UP', startedAt, detail: `Aura search succeeded, returned ${rowCount} row(s) on the probe page.` };
        }
        const errorPayload = action?.error ?? action ?? 'no action in response';
        const errorText = JSON.stringify(errorPayload);
        const isKnownFailure = errorText.includes(KNOWN_ADGM_FAILURE.exceptionType) && errorText.includes(KNOWN_ADGM_FAILURE.stackFrame);
        return {
            source: 'ADGM_FREEZONE',
            status: isKnownFailure ? 'DOWN_KNOWN' : 'DOWN_UNKNOWN',
            startedAt,
            detail: isKnownFailure
                ? `Known, previously-documented failure reproduced: ${errorText}`
                : `Aura action did not succeed with an error payload that does NOT match the known NullPointerException signature - this may be a NEW or DIFFERENT failure: ${errorText}`,
        };
    } catch (error) {
        const isTimeout = error?.name === 'AbortError';
        return {
            source: 'ADGM_FREEZONE',
            status: 'DOWN_UNKNOWN',
            startedAt,
            detail: isTimeout ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms.` : `Network-level error: ${error?.message ?? String(error)}`,
        };
    }
}

async function probeDifc() {
    const startedAt = new Date().toISOString();
    try {
        const requestBody = JSON.stringify({ name: '', licenseType: '', licenseNo: '', status: '', offset: 0, slug: '/CRM/public-register', method: 'POST' });
        const response = await fetchWithTimeout(DIFC_HANDLE_REQUEST_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
            body: requestBody,
        });
        if (!response.ok) {
            const isKnownFailure = response.status === KNOWN_DIFC_FAILURE_STATUS;
            return {
                source: 'DIFC_FREEZONE',
                status: isKnownFailure ? 'DOWN_KNOWN' : 'DOWN_UNKNOWN',
                startedAt,
                detail: isKnownFailure
                    ? `Known, previously-documented failure reproduced: HTTP ${response.status}.`
                    : `HTTP ${response.status} - this does NOT match the previously-documented HTTP 500 signature and may be a NEW or DIFFERENT failure.`,
            };
        }
        const json = await response.json();
        if (json.IsSuccess) {
            const rowCount = json.Data?.companyList?.length ?? 0;
            return { source: 'DIFC_FREEZONE', status: 'UP', startedAt, detail: `handleRequest succeeded, returned ${rowCount} row(s) on the probe page.` };
        }
        return {
            source: 'DIFC_FREEZONE',
            status: 'DOWN_UNKNOWN',
            startedAt,
            detail: `HTTP 200 but IsSuccess:false (${json.Message ?? 'no message'}) - this is a DIFFERENT failure mode than the known HTTP 500 and needs investigation.`,
        };
    } catch (error) {
        const isTimeout = error?.name === 'AbortError';
        return {
            source: 'DIFC_FREEZONE',
            status: 'DOWN_UNKNOWN',
            startedAt,
            detail: isTimeout ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms.` : `Network-level error: ${error?.message ?? String(error)}`,
        };
    }
}

function loadPriorState(stateFilePath) {
    if (!stateFilePath || !existsSync(stateFilePath)) return null;
    try {
        return JSON.parse(readFileSync(stateFilePath, 'utf8'));
    } catch {
        return null;
    }
}

function saveState(stateFilePath, state) {
    if (!stateFilePath) return;
    writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

async function main() {
    const args = process.argv.slice(2);
    const jsonOutput = args.includes('--json');
    const stateFileIndex = args.indexOf('--state-file');
    const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : null;

    const priorState = loadPriorState(stateFilePath);
    const [adgmResult, difcResult] = await Promise.all([probeAdgm(), probeDifc()]);

    for (const result of [adgmResult, difcResult]) {
        const priorForSource = priorState?.[result.source];
        const wasDown = priorForSource === 'DOWN_KNOWN' || priorForSource === 'DOWN_UNKNOWN';
        if (result.status === 'UP' && wasDown) {
            result.status = 'RESOLVED';
            result.detail = `RECOVERY DETECTED: was ${priorForSource} on the previous probe, now UP. ${result.detail}`;
        }
    }

    saveState(stateFilePath, {
        ADGM_FREEZONE: adgmResult.status === 'RESOLVED' ? 'UP' : adgmResult.status,
        DIFC_FREEZONE: difcResult.status === 'RESOLVED' ? 'UP' : difcResult.status,
        lastProbeAt: new Date().toISOString(),
    });

    const results = [adgmResult, difcResult];
    if (jsonOutput) {
        process.stdout.write(`${JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2)}\n`);
    } else {
        for (const r of results) {
            console.log(`[${r.status}] ${r.source} — ${r.detail}`);
        }
        const resolved = results.filter((r) => r.status === 'RESOLVED');
        if (resolved.length > 0) {
            console.log(`\n>>> ACTION NEEDED: ${resolved.map((r) => r.source).join(', ')} recovered. See docs/monitoring/UAE_OUTAGE_PLAYBOOK.md "Re-enabling a recovered source".`);
        }
    }

    const anyDown = results.some((r) => r.status === 'DOWN_KNOWN' || r.status === 'DOWN_UNKNOWN');
    process.exit(anyDown ? 1 : 0);
}

main().catch((error) => {
    console.error('uae_probe.js itself failed to run (this is a bug in the probe, not a finding about ADGM/DIFC):', error);
    process.exit(2);
});
