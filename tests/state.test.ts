import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeltaState } from '../src/types.js';

const storeData = new Map<string, unknown>();
const mockStore = {
    getValue: vi.fn(async (key: string) => storeData.get(key) ?? null),
    setValue: vi.fn(async (key: string, value: unknown) => {
        storeData.set(key, value);
    }),
};

vi.mock('apify', () => ({
    Actor: { openKeyValueStore: vi.fn(async () => mockStore) },
}));

const { loadState, recordSeen, recordSourceChecked, saveState, stateStoreName } = await import('../src/state.js');

afterEach(() => {
    storeData.clear();
    vi.clearAllMocks();
});

describe('stateStoreName', () => {
    it('scopes the KV store name by deltaStateName', () => {
        expect(stateStoreName('default')).toBe('UAE-CORPORATE-REGISTRY-DELTA-STATE-default');
        expect(stateStoreName('weekly-schedule')).toBe('UAE-CORPORATE-REGISTRY-DELTA-STATE-weekly-schedule');
    });
});

describe('loadState / saveState', () => {
    it('returns an empty state when nothing has been saved yet', async () => {
        const state = await loadState('test-store', false);
        expect(state).toEqual({ entities: {}, sourceCache: {} });
    });

    it('returns an empty state (never a stale one) when resetState is true, even if something was previously saved', async () => {
        await saveState('test-store', {
            entities: { x: { statusFingerprint: 'a', contentFingerprint: 'b', registrationStatus: 'Active', licenseStatus: null, tradeNameStatus: null, lastSeen: '2026-01-01T00:00:00.000Z' } },
            sourceCache: {},
        });
        const state = await loadState('test-store', true);
        expect(state).toEqual({ entities: {}, sourceCache: {} });
    });

    it('round-trips a real state object through save and load', async () => {
        const original: DeltaState = {
            entities: {
                'ADGM_FREEZONE::22086': { statusFingerprint: 'sf1', contentFingerprint: 'cf1', registrationStatus: 'Registered', licenseStatus: 'Licensed', tradeNameStatus: null, lastSeen: '2026-01-01T00:00:00.000Z' },
            },
            sourceCache: { ADGM_FREEZONE: { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true } },
        };
        await saveState('test-store', original);
        const loaded = await loadState('test-store', false);
        expect(loaded).toEqual(original);
    });
});

describe('recordSeen', () => {
    it('mutates the given state object in place, keyed by recordId', () => {
        const state: DeltaState = { entities: {}, sourceCache: {} };
        recordSeen(state, 'ADGM_FREEZONE::22086', {
            statusFingerprint: 'sf',
            contentFingerprint: 'cf',
            registrationStatus: 'Registered',
            licenseStatus: 'Licensed', tradeNameStatus: null,
            lastSeen: '2026-01-01T00:00:00.000Z',
        });
        expect(state.entities['ADGM_FREEZONE::22086'].statusFingerprint).toBe('sf');
    });

    it('overwrites a previous fingerprint for the same recordId rather than accumulating history', () => {
        const state: DeltaState = { entities: {}, sourceCache: {} };
        recordSeen(state, 'x', { statusFingerprint: 'v1', contentFingerprint: 'v1', registrationStatus: null, licenseStatus: null, tradeNameStatus: null, lastSeen: '2026-01-01T00:00:00.000Z' });
        recordSeen(state, 'x', { statusFingerprint: 'v2', contentFingerprint: 'v2', registrationStatus: null, licenseStatus: null, tradeNameStatus: null, lastSeen: '2026-01-02T00:00:00.000Z' });
        expect(state.entities.x.statusFingerprint).toBe('v2');
        expect(Object.keys(state.entities)).toHaveLength(1);
    });
});

describe('recordSourceChecked', () => {
    it('mutates the given state object in place, keyed by dataSource', () => {
        const state: DeltaState = { entities: {}, sourceCache: {} };
        recordSourceChecked(state, 'DIFC_FREEZONE', { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true });
        expect(state.sourceCache.DIFC_FREEZONE?.baselineComplete).toBe(true);
    });

    it('tracks each data source independently - updating one does not affect another', () => {
        const state: DeltaState = { entities: {}, sourceCache: {} };
        recordSourceChecked(state, 'ADGM_FREEZONE', { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true });
        recordSourceChecked(state, 'DIFC_FREEZONE', { lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: false });
        expect(state.sourceCache.ADGM_FREEZONE?.baselineComplete).toBe(true);
        expect(state.sourceCache.DIFC_FREEZONE?.baselineComplete).toBe(false);
    });
});
