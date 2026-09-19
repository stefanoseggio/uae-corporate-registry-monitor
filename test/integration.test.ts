import { Actor } from 'apify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdgmEntityRow, DeltaState, DifcCompanyRow } from '../src/types.js';

const pushedRecords: { record: unknown; eventName?: string }[] = [];
const notifiedRecords: unknown[] = [];

vi.mock('apify', () => ({
    Actor: {
        // Default resolves a fully-shaped ChargeResult (not a bare `{}`) - found by adversarial
        // review: a bare `{}` is not a real ChargeResult (the real apify SDK's Actor.pushData(record,
        // eventName) is typed to return Promise<ChargeResult>, requiring eventChargeLimitReached,
        // chargedCount, and chargeableWithinLimit), so most of this file's tests were exercising an
        // unrealistic return shape. Since the mock factory is untyped, TypeScript never caught this;
        // if routes.ts is ever extended to also read chargedCount/chargeableWithinLimit, every test
        // relying on the old bare-`{}` default would have masked that regression.
        pushData: vi.fn(async (record: unknown, eventName?: string) => {
            pushedRecords.push({ record, eventName });
            return { eventChargeLimitReached: false, chargedCount: eventName ? 1 : 0, chargeableWithinLimit: {} };
        }),
    },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const fetchAllAdgmEntities = vi.fn();
vi.mock('../src/adgmSource.js', () => ({ fetchAllAdgmEntities: (...args: unknown[]) => fetchAllAdgmEntities(...args) }));

const fetchAllDifcCompanies = vi.fn();
vi.mock('../src/difcSource.js', () => ({ fetchAllDifcCompanies: (...args: unknown[]) => fetchAllDifcCompanies(...args) }));

const fetchAllDubaiLicenses = vi.fn();
const fetchAllDubaiTradeNames = vi.fn();
vi.mock('../src/dubaiPulseSource.js', () => ({
    fetchAllDubaiLicenses: (...args: unknown[]) => fetchAllDubaiLicenses(...args),
    fetchAllDubaiTradeNames: (...args: unknown[]) => fetchAllDubaiTradeNames(...args),
}));

vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: { body?: string }) => {
        notifiedRecords.push(JSON.parse(options.body ?? '{}'));
        return { ok: true };
    }),
);

const { run } = await import('../src/routes.js');

function adgmRow(overrides: Partial<AdgmEntityRow> = {}): AdgmEntityRow {
    return {
        Id: '001',
        Name: 'Acme Holdings Limited',
        Entity_Type__c: 'Private Company Limited By Shares',
        Is_continued__c: false,
        Incorporation_Date__c: '2024-01-01',
        Registration_Number__c: '1000',
        Entity_Status__c: 'Registered',
        Category__c: 'Non-Financial (Category B)',
        Entity_Sub_Type__c: null,
        License_Status__c: 'Licensed',
        Addresses__r: [{ Full_Address__c: 'ADGM Square, Abu Dhabi' }],
        Trade_Names__r: null,
        ...overrides,
    };
}

function difcRow(overrides: Partial<DifcCompanyRow> = {}): DifcCompanyRow {
    return {
        Id: '0010J',
        Name: 'Zenith Trading Ltd',
        ROC_Status__c: 'Active',
        Registration_License_No__c: '2000',
        Legal_Type_of_Entity__c: 'LTD',
        Legal_Entity_Type__c: 'Private Company',
        ROC_reg_incorp_Date__c: '2020-01-01',
        License_Activity_Details__c: 'Consulting;',
        Nature_of_business__c: null,
        Registered_Address__c: 'DIFC, Dubai',
        Company_Type__c: 'Non - financial',
        Website: null,
        ...overrides,
    };
}

function emptyState(): DeltaState {
    return { entities: {}, sourceCache: {} };
}

afterEach(() => {
    pushedRecords.length = 0;
    notifiedRecords.length = 0;
    fetchAllAdgmEntities.mockReset();
    fetchAllDifcCompanies.mockReset();
    fetchAllDubaiLicenses.mockReset();
    fetchAllDubaiTradeNames.mockReset();
    vi.mocked(fetch).mockClear();
    vi.mocked(Actor.pushData).mockClear();
});

describe('Full entity lifecycle across data sources: baseline -> unchanged -> status change -> new entity', () => {
    it('walks a realistic multi-run sequence across ADGM and DIFC together and verifies every delta trigger fires correctly', async () => {
        const state = emptyState();
        const input = { dataSources: ['ADGM_FREEZONE', 'DIFC_FREEZONE'] as const, onlyNew: false, webhookUrl: 'https://example.com/hook' };

        // --- Run 1: first-ever observation. Must be BASELINE_SNAPSHOT for both, uncharged, no notification. ---
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow()], complete: true });
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow()], complete: true });
        const stats1 = await run(input as never, state);
        expect(stats1.byEventType.BASELINE_SNAPSHOT).toBe(2);
        expect(notifiedRecords).toHaveLength(0);
        pushedRecords.length = 0;

        // --- Run 2: identical data. Must be ENTITY_UNCHANGED for both, uncharged, no notification. ---
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow()], complete: true });
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow()], complete: true });
        const stats2 = await run(input as never, state);
        expect(stats2.byEventType.ENTITY_UNCHANGED).toBe(2);
        expect(notifiedRecords).toHaveLength(0);
        pushedRecords.length = 0;

        // --- Run 3: the ADGM entity's status changes (a real deregistration), the DIFC entity gets a
        // cosmetic address update only. STATUS_CHANGED must notify; the cosmetic ENTITY_UPDATED must not. ---
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow({ Entity_Status__c: 'Deregistered' })], complete: true });
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow({ Registered_Address__c: 'A new DIFC address' })], complete: true });
        const stats3 = await run(input as never, state);
        expect(stats3.byEventType.STATUS_CHANGED).toBe(1);
        expect(stats3.byEventType.ENTITY_UPDATED).toBe(1);
        expect(notifiedRecords).toHaveLength(1); // only the status change notifies
        const notifiedPayload = notifiedRecords[0] as { record: { data_source: string; previous_registration_status: string } };
        expect(notifiedPayload.record.data_source).toBe('ADGM_FREEZONE');
        expect(notifiedPayload.record.previous_registration_status).toBe('Registered');
        pushedRecords.length = 0;
        notifiedRecords.length = 0;

        // --- Run 4: a genuinely new DIFC entity appears alongside the unchanged ADGM one. NEW_ENTITY always notifies. ---
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow({ Entity_Status__c: 'Deregistered' })], complete: true });
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow({ Registered_Address__c: 'A new DIFC address' }), difcRow({ Id: '0099', Registration_License_No__c: '9999', Name: 'Brand New Co Ltd' })], complete: true });
        const stats4 = await run(input as never, state);
        expect(stats4.byEventType.NEW_ENTITY).toBe(1);
        expect(stats4.byEventType.ENTITY_UNCHANGED).toBe(2);
        expect(notifiedRecords).toHaveLength(1);
    });

    it('processes ADGM and DIFC independently in one run, each with its own baseline state', async () => {
        const state = emptyState();
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow()], complete: true });
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow()], complete: true });

        const stats = await run({ dataSources: ['ADGM_FREEZONE', 'DIFC_FREEZONE'], onlyNew: false } as never, state);
        expect(stats.sourcesChecked).toBe(2);
        expect(stats.totalPushed).toBe(2);
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBe(true);
        expect(state.sourceCache.DIFC_FREEZONE?.baselineComplete).toBe(true);
    });

    it('a transient failure fetching one data source does not abort processing of the other, independent source', async () => {
        const state = emptyState();
        fetchAllAdgmEntities.mockRejectedValueOnce(new Error('simulated transient network failure'));
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow()], complete: true });

        const stats = await run({ dataSources: ['ADGM_FREEZONE', 'DIFC_FREEZONE'], onlyNew: false } as never, state);
        expect(stats.sourcesChecked).toBe(1);
        expect(stats.totalPushed).toBe(1);
        expect(state.sourceCache.ADGM_FREEZONE).toBeUndefined();
        expect(state.sourceCache.DIFC_FREEZONE?.baselineComplete).toBe(true);
    });

    it('skips DUBAI_MAINLAND with a warning (not an error) when requested without an API key, and still processes the other requested sources', async () => {
        const state = emptyState();
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow()], complete: true });

        const stats = await run({ dataSources: ['DUBAI_MAINLAND', 'DIFC_FREEZONE'], onlyNew: false } as never, state);
        expect(stats.sourcesChecked).toBe(1);
        expect(fetchAllDubaiLicenses).not.toHaveBeenCalled();
        expect(state.sourceCache.DUBAI_MAINLAND).toBeUndefined();
        expect(state.sourceCache.DIFC_FREEZONE?.baselineComplete).toBe(true);
    });

    it('fetches and joins Dubai license + trade-name rows when an API key IS supplied', async () => {
        const state = emptyState();
        fetchAllDubaiLicenses.mockResolvedValueOnce([
            {
                license_number: '555',
                initial_approval_number: null,
                commerce_register_serial_number: null,
                chamber_of_commerce_number: null,
                trade_name_serial_number: null,
                issue_date: '2024-01-01',
                expiry_date: null,
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
            },
        ]);
        fetchAllDubaiTradeNames.mockResolvedValueOnce([{ trade_name_serial: '1', trade_name_ar: null, trade_name_en: 'Test Trading LLC', license_number: '555' }]);

        const stats = await run({ dataSources: ['DUBAI_MAINLAND'], onlyNew: false, dubaiPulseApiKey: 'test-key' } as never, state);
        expect(stats.sourcesChecked).toBe(1);
        expect(stats.totalPushed).toBe(1);
        expect((pushedRecords[0].record as { commercial_name_en: string }).commercial_name_en).toBe('Test Trading LLC');
    });

    it('stops the run immediately when Apify signals eventChargeLimitReached on a charged push, without processing further rows', async () => {
        const state = emptyState();
        state.sourceCache.ADGM_FREEZONE = { lastChecked: '2020-01-01T00:00:00.000Z', baselineComplete: true };
        vi.mocked(Actor.pushData).mockResolvedValueOnce({ eventChargeLimitReached: true, chargedCount: 1, chargeableWithinLimit: {} });
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow({ Registration_Number__c: '1001' }), adgmRow({ Registration_Number__c: '1002' })], complete: true });

        const stats = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false } as never, state);
        expect(stats.stopped).toBe(true);
        expect(stats.totalPushed).toBe(1);
        expect(Object.keys(state.entities)).toHaveLength(1);
    });

    it('does NOT cache the source baseline when maxItems truncates the pass, and correctly resumes on the next run without double-charging', async () => {
        const state = emptyState();
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow({ Registration_Number__c: '1001' }), adgmRow({ Registration_Number__c: '1002' })], complete: true });
        const stats1 = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false, maxItems: 1 } as never, state);
        expect(stats1.totalPushed).toBe(1);
        expect(state.sourceCache.ADGM_FREEZONE).toBeUndefined();

        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow({ Registration_Number__c: '1001' }), adgmRow({ Registration_Number__c: '1002' })], complete: true });
        const stats2 = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false, maxItems: 10 } as never, state);
        expect(stats2.byEventType.ENTITY_UNCHANGED).toBe(1);
        expect(stats2.byEventType.BASELINE_SNAPSHOT).toBe(1);
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBe(true);
    });

    it('CONFIRMED BUG FIX: does NOT cache the source baseline when the fetch itself was cut short (complete: false) - e.g. adgmSource.ts/difcSource.ts\'s run-level time budget guard stopping pagination early - even though every row that WAS fetched is still pushed and none of the run\'s own limits (stats.stopped) were hit', async () => {
        const state = emptyState();
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow({ Registration_Number__c: '1001' })], complete: false });

        const stats = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false } as never, state);

        expect(stats.stopped).toBe(false); // nothing hit maxItems/eventChargeLimitReached this run
        expect(stats.totalPushed).toBe(1); // the row that WAS fetched is still pushed, not discarded
        expect(stats.sourcesChecked).toBe(1);
        // The critical assertion: baselineComplete must stay unset, because the fetch never actually
        // reached the end of ADGM's real register this run. If it were wrongly set to true here, the
        // next run's still-unseen real entities would be misclassified as NEW_ENTITY (and
        // re-notified/re-charged) instead of correctly finishing the baseline first.
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBeUndefined();

        // The next run genuinely completes the enumeration (now including a second, previously
        // unreached entity) - THAT run is the one allowed to mark baselineComplete: true.
        fetchAllAdgmEntities.mockResolvedValueOnce({
            rows: [adgmRow({ Registration_Number__c: '1001' }), adgmRow({ Registration_Number__c: '1002' })],
            complete: true,
        });
        const stats2 = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false } as never, state);
        // Entity 1001 was already `recordSeen` during the first (incomplete) run above, so it is
        // correctly ENTITY_UNCHANGED here; 1002 is genuinely new to state and baselineComplete was
        // still false going into this run, so it is correctly BASELINE_SNAPSHOT - NOT NEW_ENTITY,
        // which is exactly the misclassification this fix prevents.
        expect(stats2.byEventType.ENTITY_UNCHANGED).toBe(1);
        expect(stats2.byEventType.BASELINE_SNAPSHOT).toBe(1);
        expect(stats2.byEventType.NEW_ENTITY ?? 0).toBe(0);
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBe(true);
    });

    it('CONFIRMED BUG FIX: a fetch that "succeeds" (no thrown error) but returns 0 rows while a real, large baseline is already tracked is treated as a suspected fetch failure, not a mass closure - state is left untouched and a later good run does NOT fire a false NEW_ENTITY storm', async () => {
        const state = emptyState();
        const realRows = Array.from({ length: 25 }, (_, i) => adgmRow({ Id: `row-${i}`, Registration_Number__c: String(i) }));

        // Run 1: establish a real, healthy baseline of 25 tracked ADGM entities (above the
        // suspected-fetch-failure guard's minimum-previous-count floor), exactly as a real fleet of
        // past good runs would have left behind in persisted delta state - using real computed
        // fingerprints, not stubbed ones.
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: realRows, complete: true });
        const statsBaseline = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false } as never, state);
        expect(statsBaseline.byEventType.BASELINE_SNAPSHOT).toBe(25);
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBe(true);
        const entitiesBefore = { ...state.entities };
        const lastCheckedBefore = state.sourceCache.ADGM_FREEZONE?.lastChecked;
        notifiedRecords.length = 0;

        // Run 2: this run's fetch resolves successfully (not a thrown error) with zero rows -
        // simulating a shifted/broken response that technically parsed, or a redirected/bot-check
        // page - while 25 real entities are already known-tracked for this source.
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [], complete: true });
        const statsBadRun = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false } as never, state);

        // The suspected-failure guard must fire: no source-check credit, no entities touched, and
        // crucially the baseline/state is NOT wiped or reset by this run.
        expect(statsBadRun.sourcesChecked).toBe(0);
        expect(statsBadRun.totalPushed).toBe(0);
        expect(state.entities).toEqual(entitiesBefore);
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBe(true);
        expect(state.sourceCache.ADGM_FREEZONE?.lastChecked).toBe(lastCheckedBefore); // untouched, not refreshed by the bad run

        // Run 3: the source recovers and returns the same real 25 entities unchanged. Because state
        // was never poisoned by the bad run, every one of them must be correctly reclassified as
        // ENTITY_UNCHANGED - NOT as a false NEW_ENTITY storm (which is exactly what would happen if
        // the bad run above had wrongly wiped state.entities or reset baselineComplete to false).
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: realRows, complete: true });
        const statsRecovered = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false } as never, state);

        expect(statsRecovered.sourcesChecked).toBe(1);
        expect(statsRecovered.byEventType.NEW_ENTITY ?? 0).toBe(0);
        expect(statsRecovered.byEventType.ENTITY_UNCHANGED).toBe(25);
        expect(notifiedRecords).toHaveLength(0); // no false new-entity notification storm
    });

    it('CONFIRMED BUG FIX: the same suspected-fetch-failure guard protects DIFC_FREEZONE', async () => {
        const state = emptyState();
        for (let i = 0; i < 30; i += 1) {
            state.entities[`DIFC_FREEZONE::${i}`] = {
                statusFingerprint: 'fp-status',
                contentFingerprint: 'fp-content',
                registrationStatus: 'Active',
                licenseStatus: 'Active',
                tradeNameStatus: null,
                lastSeen: '2026-01-01T00:00:00.000Z',
            };
        }
        state.sourceCache.DIFC_FREEZONE = { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true };
        const entitiesBefore = { ...state.entities };

        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [], complete: true });
        const stats = await run({ dataSources: ['DIFC_FREEZONE'], onlyNew: false } as never, state);

        expect(stats.sourcesChecked).toBe(0);
        expect(state.entities).toEqual(entitiesBefore);
        expect(state.sourceCache.DIFC_FREEZONE?.baselineComplete).toBe(true);
    });

    it('does NOT suspect a fetch failure for a small/fresh state below the minimum-previous-count floor - a genuinely small registry legitimately dropping to zero must still be trusted', async () => {
        const state = emptyState();
        state.entities['ADGM_FREEZONE::1'] = {
            statusFingerprint: 'fp',
            contentFingerprint: 'fp',
            registrationStatus: 'Registered',
            licenseStatus: 'Licensed',
            tradeNameStatus: null,
            lastSeen: '2026-01-01T00:00:00.000Z',
        };
        state.sourceCache.ADGM_FREEZONE = { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true };

        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [], complete: true });
        const stats = await run({ dataSources: ['ADGM_FREEZONE'], onlyNew: false } as never, state);

        expect(stats.sourcesChecked).toBe(1); // trusted as a real (tiny) result, not suspected
        expect(state.sourceCache.ADGM_FREEZONE?.lastChecked).not.toBe('2026-01-01T00:00:00.000Z');
    });

    it('a single malformed row (missing its required identifier field) is logged and skipped without aborting the rest of the run - found untested by adversarial review, exercising the per-row try/catch/continue in processAdgm/processDifc/processDubaiMainland through run() rather than only unit-testing normalize*Entity in isolation', async () => {
        const state = emptyState();
        fetchAllAdgmEntities.mockResolvedValueOnce({ rows: [adgmRow({ Registration_Number__c: '' }), adgmRow({ Registration_Number__c: '1002' })], complete: true });
        fetchAllDifcCompanies.mockResolvedValueOnce({ rows: [difcRow({ Registration_License_No__c: '' }), difcRow({ Registration_License_No__c: '2002' })], complete: true });

        const stats = await run({ dataSources: ['ADGM_FREEZONE', 'DIFC_FREEZONE'], onlyNew: false } as never, state);

        expect(stats.totalPushed).toBe(2); // only the one valid row per source was pushed
        expect(Object.keys(state.entities)).toEqual(['ADGM_FREEZONE::1002', 'DIFC_FREEZONE::2002']);
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBe(true); // the run still completed and baselined normally
        expect(state.sourceCache.DIFC_FREEZONE?.baselineComplete).toBe(true);
    });
});
