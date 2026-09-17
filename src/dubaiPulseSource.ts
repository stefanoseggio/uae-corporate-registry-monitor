import { log } from 'apify';

import type { DubaiLicenseRow, DubaiTradeNameRow } from './types.js';
import { NonRetryableFetchError } from './types.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; DeltaRegistryComplianceMonitor/1.0; +https://apify.com)';
const MAX_RETRY_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;
const PAGE_LIMIT = 1000;

/**
 * !!! CONFIDENCE TIER, READ BEFORE MODIFYING !!!
 *
 * Unlike every other data source in this actor (and unlike every source in Actors #1-3 of this
 * fleet), this integration could NOT be verified against a single byte of live Dubai Pulse traffic
 * during development - dubaipulse.gov.ae rejected every direct connection attempt made from this
 * development environment (WebFetch, browser navigation, and two independent third-party proxy
 * services all failed at the network level; see ARCHITECTURE.md section 0.2 for the full record).
 * What IS reasonably well corroborated, from a real archived snapshot of the dataset's own
 * documentation page and from a real (different-dataset) curl example surfaced by web search:
 *   - The DED license-master dataset's column schema (field names below) - HIGH confidence,
 *     sourced from an actual archived column-definition table, not a guess.
 *   - Access requires a "Request Permission" approval step with the dataset owner (DED), taking up
 *     to 14 days, BEFORE any credential is issued - this is not a same-day self-serve API signup.
 *   - The query API is a custom REST path (`https://api.dubaipulse.gov.ae/{tier}/{org}/{slug}-open-api`),
 *     authenticated via a single opaque key sent as the literal `Authorization` header value (NOT
 *     an OAuth "Bearer " prefix or a client_credentials token exchange - a real, different-dataset
 *     curl example showed `--header "Authorization: <rawKey>"` with no token endpoint involved).
 *   - The exact JSON response envelope shape (array vs. `{result:{records:[...]}}` vs. something
 *     else) is UNCONFIRMED. This module defends against several plausible shapes (see
 *     extractRecords below) and throws a loud, specific error if none match, rather than silently
 *     returning nothing.
 *   - The real enumerated values of license_status_code are UNCONFIRMED - this module never
 *     interprets that field into an assumed enum; it is treated as an opaque string and compared
 *     for equality only (see deltaEngine.ts's normalizeDubaiEntity).
 *
 * This module requires the ACTOR'S OWN USER to have already completed Dubai Pulse's Request
 * Permission approval themselves and supply the resulting key via `dubaiPulseApiKey` input - this
 * actor cannot provision that credential itself. If Dubai Pulse's real API differs from the
 * best-effort shape implemented here, this module is designed to fail loudly (a clear thrown
 * error identifying which assumption broke) rather than silently misparse - test thoroughly
 * against your own approved credentials before relying on this in production.
 */
const DED_LICENSE_MASTER_API_URL = 'https://api.dubaipulse.gov.ae/open/ded/ded_license_master-open-api';
const DED_TRADE_NAME_API_URL = 'https://api.dubaipulse.gov.ae/open/ded/ded_trade_name-open-api';

function extractRecords<T>(json: unknown, datasetLabel: string): T[] {
    if (Array.isArray(json)) return json as T[];
    if (json && typeof json === 'object') {
        const obj = json as Record<string, unknown>;
        if (Array.isArray(obj.data)) return obj.data as T[];
        if (Array.isArray(obj.records)) return obj.records as T[];
        const { result } = obj;
        if (result && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).records)) {
            return (result as Record<string, unknown>).records as T[];
        }
    }
    throw new NonRetryableFetchError(
        `Dubai Pulse's ${datasetLabel} response did not match any expected envelope shape (plain array, {data:[]}, {records:[]}, or CKAN-style {result:{records:[]}}). ` +
            'This is the one integration in this actor that could not be verified against live traffic during development - the real API may use a different envelope. ' +
            `Raw response keys observed: ${json && typeof json === 'object' ? Object.keys(json as object).join(', ') : typeof json}`,
    );
}

async function fetchDubaiPulsePage<T>(url: string, apiKey: string, offset: number, datasetLabel: string): Promise<T[]> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            await new Promise((resolve) => {
                setTimeout(resolve, Math.min(1000 * 2 ** attempt, 30_000));
            });
        }
        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
        try {
            const requestUrl = `${url}?limit=${PAGE_LIMIT}&offset=${offset}`;
            const response = await fetch(requestUrl, {
                headers: {
                    Authorization: apiKey,
                    'User-Agent': USER_AGENT,
                    Accept: 'application/json',
                },
                signal: timeoutController.signal,
            });
            if (response.status === 401 || response.status === 403) {
                throw new NonRetryableFetchError(
                    `Dubai Pulse rejected the supplied API key with HTTP ${response.status} while fetching ${datasetLabel}. Confirm your Dubai Pulse "Request Permission" approval has completed and the key was copied correctly.`,
                );
            }
            if (!response.ok) {
                if (response.status >= 500 || response.status === 429) {
                    lastError = new Error(`Dubai Pulse ${datasetLabel} returned HTTP ${response.status}`);
                    continue;
                }
                throw new NonRetryableFetchError(`Dubai Pulse ${datasetLabel} returned non-retryable HTTP ${response.status}`);
            }
            const json = await response.json();
            return extractRecords<T>(json, datasetLabel);
        } catch (error) {
            if (error instanceof NonRetryableFetchError) throw error;
            lastError = error instanceof Error ? error : new Error(String(error));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw lastError ?? new Error(`Dubai Pulse ${datasetLabel} exhausted all retry attempts.`);
}

async function fetchAllPages<T>(url: string, apiKey: string, datasetLabel: string): Promise<T[]> {
    const allRows: T[] = [];
    let offset = 0;
    const MAX_PAGES = 1000;
    let pagesFetched = 0;
    while (pagesFetched < MAX_PAGES) {
        const rows = await fetchDubaiPulsePage<T>(url, apiKey, offset, datasetLabel);
        allRows.push(...rows);
        pagesFetched += 1;
        if (rows.length < PAGE_LIMIT) break;
        offset += PAGE_LIMIT;
    }
    return allRows;
}

export async function fetchAllDubaiLicenses(apiKey: string): Promise<DubaiLicenseRow[]> {
    log.info('Fetching Dubai Pulse DED license master dataset - this integration is best-effort and unverified against live traffic; see dubaiPulseSource.ts header comment.');
    return fetchAllPages<DubaiLicenseRow>(DED_LICENSE_MASTER_API_URL, apiKey, 'ded_license_master-open-api');
}

export async function fetchAllDubaiTradeNames(apiKey: string): Promise<DubaiTradeNameRow[]> {
    return fetchAllPages<DubaiTradeNameRow>(DED_TRADE_NAME_API_URL, apiKey, 'ded_trade_name-open-api');
}
