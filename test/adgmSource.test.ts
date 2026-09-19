import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAllAdgmEntities } from '../src/adgmSource.js';
import type { AdgmEntityRow } from '../src/types.js';

const SEARCH_PAGE_URL = 'https://newreg.adgm.com/s/search-results';
const AURA_ENDPOINT_PREFIX = 'https://newreg.adgm.com/s/sfsites/aura';

function bootstrapHtml(fwuid = 'TESTFWUID123'): string {
    const bootstrapConfig = {
        mode: 'PROD',
        dfs: '21',
        app: 'siteforce:communityApp',
        fwuid,
        loaded: { 'APPLICATION@markup://siteforce:communityApp': 'testAppMarker' },
        apce: 1,
        apck: 'x',
        mlr: 1,
        pathPrefix: '',
        dns: 'c',
        ls: 1,
        lrmc: '1',
    };
    const encoded = encodeURIComponent(JSON.stringify(bootstrapConfig));
    return `<html><head><script src="/s/sfsites/l/${encoded}/bootstrap.js?aura.attributes=x"></script></head><body>Search Results</body></html>`;
}

function auraSuccessResponse(rows: AdgmEntityRow[]): object {
    return { actions: [{ id: '1;a', state: 'SUCCESS', returnValue: { returnValue: { data: { data: rows } } } }] };
}

function row(overrides: Partial<AdgmEntityRow> = {}): AdgmEntityRow {
    return {
        Id: '001',
        Name: 'TEST ENTITY LIMITED',
        Entity_Type__c: 'Private Company Limited By Shares',
        Is_continued__c: false,
        Incorporation_Date__c: '2024-01-01',
        Registration_Number__c: '1000',
        Entity_Status__c: 'Registered',
        Category__c: 'Non-Financial (Category B)',
        Entity_Sub_Type__c: null,
        License_Status__c: 'Licensed',
        Addresses__r: null,
        Trade_Names__r: null,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

async function withFakeRetryTimers<T>(work: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    const resultPromise = work();
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- suppress unhandled-rejection warning during the advance window
    resultPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    return resultPromise;
}

describe('fetchAllAdgmEntities', () => {
    it('bootstraps the fwuid from the real page HTML, then submits a blank-name search and returns the rows from a single short page', async () => {
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => auraSuccessResponse([row(), row({ Id: '002', Registration_Number__c: '1001' })]) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllAdgmEntities();
        expect(rows).toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(2); // one bootstrap GET, one aura POST (page short of PAGE_SIZE, stops)
    });

    it('paginates until a page returns fewer rows than the page size', async () => {
        const fullPage = Array.from({ length: 50 }, (_, i) => row({ Id: `page1-${i}`, Registration_Number__c: `p1-${i}` }));
        const shortPage = [row({ Id: 'page2-0', Registration_Number__c: 'p2-0' })];
        let auraCallCount = 0;
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                auraCallCount += 1;
                return { ok: true, status: 200, json: async () => auraSuccessResponse(auraCallCount === 1 ? fullPage : shortPage) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllAdgmEntities();
        expect(rows).toHaveLength(51);
        expect(auraCallCount).toBe(2);
    });

    it('throws a descriptive error if the bootstrap config cannot be located in the page HTML - a real site-structure-change signal', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => '<html><body>nothing resembling a bootstrap script</body></html>' };
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/bootstrap config/);
    });

    it('throws when the Aura action does not report SUCCESS', async () => {
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ actions: [{ id: '1;a', state: 'ERROR', error: ['Something broke'] }] }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/did not succeed/);
    });

    it('retries on a 5xx from the Aura endpoint and succeeds once it recovers', async () => {
        let auraAttempts = 0;
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                auraAttempts += 1;
                if (auraAttempts === 1) return { ok: false, status: 503 };
                return { ok: true, status: 200, json: async () => auraSuccessResponse([row()]) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await withFakeRetryTimers(async () => fetchAllAdgmEntities());
        expect(rows).toHaveLength(1);
        expect(auraAttempts).toBe(2);
    });

    it('throws (does NOT silently return an empty array) when the Aura action reports SUCCESS but the expected returnValue.returnValue.data.data path is missing - a shifted/broken response shape, not a real empty page', async () => {
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                // SUCCESS, but the nested data.data path a real response always has is entirely
                // absent - e.g. ADGM reshaping its Salesforce Aura envelope, or a bot-check/
                // interstitial page that still happens to parse as this JSON shape.
                return { ok: true, status: 200, json: async () => ({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue: { returnValue: {} } }] }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/did not contain the expected/);
    });

    it('throws when the Aura action reports SUCCESS but data.data is present and not an array (e.g. a renamed/reshaped field)', async () => {
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue: { returnValue: { data: { data: 'not-an-array' } } } }] }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/did not contain the expected/);
    });

    it('still returns a real, well-formed empty page as an empty array (not an error) - a genuine last/short page must not be mistaken for a broken response', async () => {
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => auraSuccessResponse([]) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllAdgmEntities();
        expect(rows).toEqual([]);
    });

    it('does not retry a non-retryable 4xx from the Aura endpoint - fails immediately, likely indicating a stale fwuid', async () => {
        const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: false, status: 400 };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/stale fwuid|400/);
    });
});
