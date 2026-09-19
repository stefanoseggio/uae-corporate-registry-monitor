import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAllDifcCompanies } from '../src/difcSource.js';
import type { DifcCompanyRow } from '../src/types.js';

const HANDLE_REQUEST_URL = 'https://www.difc.com/api/handleRequest';

function row(overrides: Partial<DifcCompanyRow> = {}): DifcCompanyRow {
    return {
        Id: '0010J00001iuxV0QAI',
        Name: 'One Foods Holdings Limited',
        ROC_Status__c: 'Active',
        Registration_License_No__c: '2368',
        Legal_Type_of_Entity__c: 'LTD',
        Legal_Entity_Type__c: 'Private Company',
        ROC_reg_incorp_Date__c: '2017-01-11',
        License_Activity_Details__c: 'Holding Company;',
        Nature_of_business__c: null,
        Registered_Address__c: 'Innovation Hub, DIFC, Dubai',
        Company_Type__c: 'Non - financial',
        Website: null,
        ...overrides,
    };
}

function successResponse(companyList: DifcCompanyRow[]): object {
    return { Data: { companyList }, ErrorData: null, IsSuccess: true, Errors: null, Message: null, StatusCode: 200, SubStatusCode: null };
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

describe('fetchAllDifcCompanies', () => {
    it('submits an all-blank-filter request and returns the rows from a single short page', async () => {
        const fetchMock = vi.fn(async (url: string, options: { body: string }) => {
            expect(url).toBe(HANDLE_REQUEST_URL);
            const body = JSON.parse(options.body);
            expect(body).toEqual({ name: '', licenseType: '', licenseNo: '', status: '', offset: 0, slug: '/CRM/public-register', method: 'POST' });
            return { ok: true, status: 200, json: async () => successResponse([row(), row({ Id: '0010J00001iuxZ4QAI', Registration_License_No__c: '2403' })]) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDifcCompanies();
        expect(rows).toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('paginates via offset until a page returns fewer than the observed page size (10)', async () => {
        const fullPage = Array.from({ length: 10 }, (_, i) => row({ Id: `page1-${i}`, Registration_License_No__c: `p1-${i}` }));
        const shortPage = [row({ Id: 'page2-0', Registration_License_No__c: 'p2-0' })];
        const seenOffsets: number[] = [];
        const fetchMock = vi.fn(async (_url: string, options: { body: string }) => {
            const body = JSON.parse(options.body);
            seenOffsets.push(body.offset);
            return { ok: true, status: 200, json: async () => successResponse(body.offset === 0 ? fullPage : shortPage) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDifcCompanies();
        expect(rows).toHaveLength(11);
        expect(seenOffsets).toEqual([0, 10]);
    });

    it('throws when the API reports IsSuccess: false', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ Data: null, IsSuccess: false, Message: 'Something went wrong' }) }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDifcCompanies()).rejects.toThrow(/Something went wrong/);
    });

    it('throws (does NOT silently return an empty array) when IsSuccess is true but Data is missing entirely - a shifted/broken response shape, not a real empty page', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ IsSuccess: true, Message: null }) }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDifcCompanies()).rejects.toThrow(/did not contain the expected/);
    });

    it('throws when IsSuccess is true but Data.companyList is present and not an array (e.g. a renamed/reshaped field)', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ Data: { companyList: 'not-an-array' }, IsSuccess: true, Message: null }) }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDifcCompanies()).rejects.toThrow(/did not contain the expected/);
    });

    it('retries on a 5xx and succeeds once the server recovers', async () => {
        let attempts = 0;
        const fetchMock = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) return { ok: false, status: 503 };
            return { ok: true, status: 200, json: async () => successResponse([row()]) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await withFakeRetryTimers(async () => fetchAllDifcCompanies());
        expect(rows).toHaveLength(1);
        expect(attempts).toBe(2);
    });

    it('does not retry a non-retryable 4xx', async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDifcCompanies()).rejects.toThrow(/404/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns an empty array (not an error) if the very first page is already empty', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => successResponse([]) }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDifcCompanies();
        expect(rows).toEqual([]);
    });
});
