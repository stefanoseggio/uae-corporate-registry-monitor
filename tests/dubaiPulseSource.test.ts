import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAllDubaiLicenses, fetchAllDubaiTradeNames } from '../src/dubaiPulseSource.js';
import type { DubaiLicenseRow, DubaiTradeNameRow } from '../src/types.js';

function license(overrides: Partial<DubaiLicenseRow> = {}): DubaiLicenseRow {
    return {
        license_number: '123456',
        initial_approval_number: null,
        commerce_register_serial_number: null,
        chamber_of_commerce_number: null,
        trade_name_serial_number: null,
        issue_date: '2024-01-04',
        expiry_date: '2025-01-04',
        cancel_date: null,
        license_status_code: '1',
        license_status_desc_ar: null,
        license_status_desc_en: 'Active',
        license_category_code: null,
        license_category_desc_ar: null,
        license_category_desc_en: 'LLC',
        issue_authority_code: null,
        issue_authority_desc_ar: null,
        issue_authority_desc_en: null,
        ...overrides,
    };
}

function tradeName(overrides: Partial<DubaiTradeNameRow> = {}): DubaiTradeNameRow {
    return {
        trade_name_serial: '333',
        trade_name_ar: null,
        trade_name_en: 'Test Trading LLC',
        license_number: '123456',
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

describe('fetchAllDubaiLicenses - envelope-shape defense (the one integration with an unconfirmed live response shape)', () => {
    it('accepts a plain JSON array response', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [license()] }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDubaiLicenses('test-key');
        expect(rows).toHaveLength(1);
    });

    it('accepts a {data: [...]} envelope', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [license()] }) }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDubaiLicenses('test-key');
        expect(rows).toHaveLength(1);
    });

    it('accepts a {records: [...]} envelope', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [license()] }) }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDubaiLicenses('test-key');
        expect(rows).toHaveLength(1);
    });

    it('accepts a CKAN-style {result: {records: [...]}} envelope', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { records: [license()] } }) }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDubaiLicenses('test-key');
        expect(rows).toHaveLength(1);
    });

    it('throws a loud, specific error (never silently returns nothing) when the response matches none of the expected envelope shapes', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ somethingUnexpected: true }) }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDubaiLicenses('test-key')).rejects.toThrow(/did not match any expected envelope shape/);
    });

    it('sends the API key as the literal Authorization header value (not a Bearer-prefixed token)', async () => {
        const fetchMock = vi.fn(async (_url: string, options: { headers: Record<string, string> }) => {
            expect(options.headers.Authorization).toBe('my-real-api-key');
            return { ok: true, status: 200, json: async () => [license()] };
        });
        vi.stubGlobal('fetch', fetchMock);

        await fetchAllDubaiLicenses('my-real-api-key');
    });
});

describe('fetchAllDubaiLicenses - auth and retry behavior', () => {
    it('throws a clear, specific error on 401/403 rather than a generic HTTP error - this is the most likely real-world failure mode given the mandatory approval step', async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDubaiLicenses('bad-key')).rejects.toThrow(/rejected the supplied API key/);
    });

    it('retries on a 5xx and succeeds once the server recovers', async () => {
        let attempts = 0;
        const fetchMock = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) return { ok: false, status: 503 };
            return { ok: true, status: 200, json: async () => [license()] };
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await withFakeRetryTimers(async () => fetchAllDubaiLicenses('test-key'));
        expect(rows).toHaveLength(1);
        expect(attempts).toBe(2);
    });

    it('does not retry a non-retryable 4xx other than 401/403', async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDubaiLicenses('test-key')).rejects.toThrow(/400/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('paginates using limit/offset query parameters until a page returns fewer than the page limit', async () => {
        const fullPage = Array.from({ length: 1000 }, (_, i) => license({ license_number: `p1-${i}` }));
        const shortPage = [license({ license_number: 'p2-0' })];
        const seenOffsets: string[] = [];
        const fetchMock = vi.fn(async (url: string) => {
            const parsed = new URL(url);
            const offset = parsed.searchParams.get('offset') ?? '0';
            seenOffsets.push(offset);
            return { ok: true, status: 200, json: async () => (offset === '0' ? fullPage : shortPage) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDubaiLicenses('test-key');
        expect(rows).toHaveLength(1001);
        expect(seenOffsets).toEqual(['0', '1000']);
    });
});

/**
 * fetchAllDubaiTradeNames shares fetchAllDubaiLicenses's exact retry/timeout/pagination/envelope
 * machinery (fetchAllPages -> fetchDubaiPulsePage -> extractRecords), differing only in which URL
 * constant is passed - found untested by adversarial review: every prior test in this file called
 * fetchAllDubaiLicenses exclusively, so a bug isolated to the trade-name endpoint specifically
 * (e.g. a typo in DED_TRADE_NAME_API_URL) would have gone undetected by this file, and
 * tests/integration.test.ts mocks fetchAllDubaiTradeNames out entirely rather than exercising the
 * real implementation. This suite mirrors the fetchAllDubaiLicenses coverage above against the
 * real function.
 */
describe('fetchAllDubaiTradeNames - mirrors fetchAllDubaiLicenses coverage against the real trade-name endpoint', () => {
    it('accepts a plain JSON array response', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [tradeName()] }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDubaiTradeNames('test-key');
        expect(rows).toHaveLength(1);
        expect(rows[0].trade_name_en).toBe('Test Trading LLC');
    });

    it('hits the trade-name endpoint, not the license endpoint', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            expect(url).toContain('ded_trade_name-open-api');
            expect(url).not.toContain('ded_license_master-open-api');
            return { ok: true, status: 200, json: async () => [tradeName()] };
        });
        vi.stubGlobal('fetch', fetchMock);

        await fetchAllDubaiTradeNames('test-key');
    });

    it('throws a clear, specific error on 401/403', async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAllDubaiTradeNames('bad-key')).rejects.toThrow(/rejected the supplied API key/);
    });

    it('retries on a 5xx and succeeds once the server recovers', async () => {
        let attempts = 0;
        const fetchMock = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) return { ok: false, status: 503 };
            return { ok: true, status: 200, json: async () => [tradeName()] };
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await withFakeRetryTimers(async () => fetchAllDubaiTradeNames('test-key'));
        expect(rows).toHaveLength(1);
        expect(attempts).toBe(2);
    });

    it('paginates using limit/offset query parameters until a page returns fewer than the page limit', async () => {
        const fullPage = Array.from({ length: 1000 }, (_, i) => tradeName({ trade_name_serial: `p1-${i}`, license_number: `p1-${i}` }));
        const shortPage = [tradeName({ trade_name_serial: 'p2-0', license_number: 'p2-0' })];
        const fetchMock = vi.fn(async (url: string) => {
            const parsed = new URL(url);
            const offset = parsed.searchParams.get('offset') ?? '0';
            return { ok: true, status: 200, json: async () => (offset === '0' ? fullPage : shortPage) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchAllDubaiTradeNames('test-key');
        expect(rows).toHaveLength(1001);
    });
});
