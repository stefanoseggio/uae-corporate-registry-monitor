import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAllAdgmEntities } from '../src/adgmSource.js';
import type { AdgmEntityRow } from '../src/types.js';

// adgmSource.ts now calls impit.fetch(...) via a module-level Impit instance instead of the
// global fetch - stubbing globalThis.fetch (the old approach) would silently no-op, since impit
// never goes through it. `vi.hoisted` defines the shared mock before `vi.mock`'s factory (both
// are hoisted above these imports by vitest at runtime, regardless of source order) needs to
// reference it.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('impit', () => ({
    // eslint-disable-next-line prefer-arrow-callback -- must be a real constructible function (not an arrow function) so `new Impit(...)` in adgmSource.ts returns an object whose `fetch` is this mock
    Impit: vi.fn().mockImplementation(function ImpitMock() {
        return { fetch: fetchMock };
    }),
}));

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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // `vi.restoreAllMocks()` does not reliably clear a `vi.fn()` created via `vi.hoisted()` -
    // found on a sibling actor in this fleet; without this, call counts/implementations leak
    // across tests since `fetchMock` is one shared instance for the whole file.
    fetchMock.mockReset();
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
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => auraSuccessResponse([row(), row({ Id: '002', Registration_Number__c: '1001' })]) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const result = await fetchAllAdgmEntities();
        expect(result.rows).toHaveLength(2);
        expect(result.complete).toBe(true); // a genuine short page was reached
        expect(fetchMock).toHaveBeenCalledTimes(2); // one bootstrap GET, one aura POST (page short of PAGE_SIZE, stops)
    });

    it('paginates until a page returns fewer rows than the page size', async () => {
        const fullPage = Array.from({ length: 50 }, (_, i) => row({ Id: `page1-${i}`, Registration_Number__c: `p1-${i}` }));
        const shortPage = [row({ Id: 'page2-0', Registration_Number__c: 'p2-0' })];
        let auraCallCount = 0;
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                auraCallCount += 1;
                return { ok: true, status: 200, json: async () => auraSuccessResponse(auraCallCount === 1 ? fullPage : shortPage) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const result = await fetchAllAdgmEntities();
        expect(result.rows).toHaveLength(51);
        expect(result.complete).toBe(true);
        expect(auraCallCount).toBe(2);
    });

    it('throws a descriptive error if the bootstrap config cannot be located in the page HTML - a real site-structure-change signal', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => '<html><body>nothing resembling a bootstrap script</body></html>' };
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/bootstrap config/);
    });

    it('throws when the Aura action does not report SUCCESS', async () => {
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ actions: [{ id: '1;a', state: 'ERROR', error: ['Something broke'] }] }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/did not succeed/);
    });

    it('retries on a 5xx from the Aura endpoint and succeeds once it recovers', async () => {
        let auraAttempts = 0;
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                auraAttempts += 1;
                if (auraAttempts === 1) return { ok: false, status: 503 };
                return { ok: true, status: 200, json: async () => auraSuccessResponse([row()]) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const result = await withFakeRetryTimers(async () => fetchAllAdgmEntities());
        expect(result.rows).toHaveLength(1);
        expect(result.complete).toBe(true);
        expect(auraAttempts).toBe(2);
    });

    it('throws (does NOT silently return an empty array) when the Aura action reports SUCCESS but the expected returnValue.returnValue.data.data path is missing - a shifted/broken response shape, not a real empty page', async () => {
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                // SUCCESS, but the nested data.data path a real response always has is entirely
                // absent - e.g. ADGM reshaping its Salesforce Aura envelope, or a bot-check/
                // interstitial page that still happens to parse as this JSON shape.
                return { ok: true, status: 200, json: async () => ({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue: { returnValue: {} } }] }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/did not contain the expected/);
    });

    it('throws when the Aura action reports SUCCESS but data.data is present and not an array (e.g. a renamed/reshaped field)', async () => {
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue: { returnValue: { data: { data: 'not-an-array' } } } }] }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/did not contain the expected/);
    });

    it('still returns a real, well-formed empty page as an empty array (not an error) - a genuine last/short page must not be mistaken for a broken response', async () => {
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: true, status: 200, json: async () => auraSuccessResponse([]) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const result = await fetchAllAdgmEntities();
        expect(result.rows).toEqual([]);
        expect(result.complete).toBe(true);
    });

    it('does not retry a non-retryable 4xx from the Aura endpoint - fails immediately, likely indicating a stale fwuid', async () => {
        fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
            if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
            if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                return { ok: false, status: 400 };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await expect(fetchAllAdgmEntities()).rejects.toThrow(/stale fwuid|400/);
    });

    describe('run-level time budget guard (CONFIRMED BUG FIX)', () => {
        it('stops pagination BEFORE starting another page once the actor\'s real run deadline (Actor.getEnv().timeoutAt) is within the safety margin - keeping the pages already fetched instead of paginating until the platform hard-kills the run', async () => {
            // Real run deadline only 1s away - comfortably inside FETCH_TIME_BUDGET_SAFETY_MARGIN_MS
            // (60s), so the guard must already be expired by the time page 2 would be considered.
            vi.stubEnv('ACTOR_TIMEOUT_AT', new Date(Date.now() + 1_000).toISOString());
            const fullPage = Array.from({ length: 50 }, (_, i) => row({ Id: `p1-${i}`, Registration_Number__c: `p1-${i}` }));
            let auraCallCount = 0;
            fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
                if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
                if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                    auraCallCount += 1;
                    // Always a full page - without the guard this would paginate forever (bounded
                    // only by MAX_PAGES=2000), never returning within any real run timeout.
                    return { ok: true, status: 200, json: async () => auraSuccessResponse(fullPage) };
                }
                throw new Error(`Unexpected fetch: ${url}`);
            });

            const result = await fetchAllAdgmEntities();
            expect(auraCallCount).toBe(1); // page 1 only - page 2 was never attempted
            expect(result.rows).toHaveLength(50); // page 1's rows are still returned, not discarded
            expect(result.complete).toBe(false); // NOT a genuine full enumeration this run
        });

        it('abandons remaining retries for a page once the run-level time budget is nearly exhausted, instead of retrying through backoff that would itself blow the actor\'s own run timeout', async () => {
            vi.stubEnv('ACTOR_TIMEOUT_AT', new Date(Date.now() + 1_000).toISOString());
            let auraAttempts = 0;
            fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
                if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
                if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                    auraAttempts += 1;
                    return { ok: false, status: 503 }; // always a retryable failure
                }
                throw new Error(`Unexpected fetch: ${url}`);
            });

            await expect(fetchAllAdgmEntities()).rejects.toThrow(/abandoned.*time budget/i);
            expect(auraAttempts).toBe(1); // only the first attempt - the remaining 4 retries were skipped
        });

        it('still completes normally when no real run deadline is known (local dev/tests) - the guard never expires', async () => {
            // No ACTOR_TIMEOUT_AT/APIFY_TIMEOUT_AT stubbed at all - Actor.getEnv().timeoutAt is null.
            fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
                if (url === SEARCH_PAGE_URL) return { ok: true, status: 200, text: async () => bootstrapHtml() };
                if (url.startsWith(AURA_ENDPOINT_PREFIX) && options?.method === 'POST') {
                    return { ok: true, status: 200, json: async () => auraSuccessResponse([row()]) };
                }
                throw new Error(`Unexpected fetch: ${url}`);
            });

            const result = await fetchAllAdgmEntities();
            expect(result.complete).toBe(true);
        });
    });
});
