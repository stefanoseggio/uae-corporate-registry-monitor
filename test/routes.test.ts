import { describe, expect, it, vi } from 'vitest';

import { classify, normalizeAdgmEntity } from '../src/deltaEngine.js';
import { computeEventId, eventNameFor, isHighValueChange, toOutputRecord } from '../src/routes.js';
import type { AdgmEntityRow, DeltaState } from '../src/types.js';

vi.mock('apify', () => ({
    Actor: { pushData: vi.fn(async () => ({})) },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function adgmRow(overrides: Partial<AdgmEntityRow> = {}): AdgmEntityRow {
    return {
        Id: '001J8000008RHkvIAG',
        Name: '0727 HOLDING LIMITED',
        Entity_Type__c: 'Private Company Limited By Shares',
        Is_continued__c: false,
        Incorporation_Date__c: '2024-11-07',
        Registration_Number__c: '22086',
        Entity_Status__c: 'Registered',
        Category__c: 'Non-Financial (Category B)',
        Entity_Sub_Type__c: 'Special Purpose Vehicle',
        License_Status__c: 'Licensed',
        Addresses__r: [{ Full_Address__c: 'Level 8, Al Sarab Tower, ADGM Square, Abu Dhabi' }],
        Trade_Names__r: [{ Name_in_English__c: '0727 HOLDING LIMITED', Status__c: 'Active' }],
        ...overrides,
    };
}

function emptyState(): DeltaState {
    return { entities: {}, sourceCache: {} };
}

describe('eventNameFor', () => {
    it('maps NEW_ENTITY and STATUS_CHANGED and ENTITY_UPDATED to distinct, separately-priceable pay-per-event names', () => {
        expect(eventNameFor('NEW_ENTITY')).toBe('new-entity');
        expect(eventNameFor('STATUS_CHANGED')).toBe('status-changed');
        expect(eventNameFor('ENTITY_UPDATED')).toBe('entity-updated');
        const names = new Set([eventNameFor('NEW_ENTITY'), eventNameFor('STATUS_CHANGED'), eventNameFor('ENTITY_UPDATED')]);
        expect(names.size).toBe(3);
    });

    it('returns undefined (uncharged) for BASELINE_SNAPSHOT and ENTITY_UNCHANGED', () => {
        expect(eventNameFor('BASELINE_SNAPSHOT')).toBeUndefined();
        expect(eventNameFor('ENTITY_UNCHANGED')).toBeUndefined();
    });
});

describe('isHighValueChange', () => {
    it('is true for NEW_ENTITY and STATUS_CHANGED', () => {
        const newEntity = classify(normalizeAdgmEntity(adgmRow()), emptyState(), true);
        expect(newEntity.eventType).toBe('NEW_ENTITY');
        expect(isHighValueChange(newEntity)).toBe(true);

        const state = emptyState();
        const first = classify(normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Registered' })), state, false);
        state.entities[first.entity.recordId] = {
            statusFingerprint: first.statusFingerprint,
            contentFingerprint: first.contentFingerprint,
            registrationStatus: 'Registered',
            licenseStatus: 'Licensed',
            tradeNameStatus: null,
            lastSeen: '2026-01-01T00:00:00.000Z',
        };
        const changed = classify(normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Deregistered' })), state, true);
        expect(changed.eventType).toBe('STATUS_CHANGED');
        expect(isHighValueChange(changed)).toBe(true);
    });

    it('is false for ENTITY_UPDATED (cosmetic content change, not a status transition)', () => {
        const state = emptyState();
        const first = classify(normalizeAdgmEntity(adgmRow()), state, false);
        state.entities[first.entity.recordId] = {
            statusFingerprint: first.statusFingerprint,
            contentFingerprint: first.contentFingerprint,
            registrationStatus: 'Registered',
            licenseStatus: 'Licensed',
            tradeNameStatus: null,
            lastSeen: '2026-01-01T00:00:00.000Z',
        };
        const updated = classify(normalizeAdgmEntity(adgmRow({ Addresses__r: [{ Full_Address__c: 'A different address' }] })), state, true);
        expect(updated.eventType).toBe('ENTITY_UPDATED');
        expect(isHighValueChange(updated)).toBe(false);
    });

    it('is false for BASELINE_SNAPSHOT and ENTITY_UNCHANGED', () => {
        const baseline = classify(normalizeAdgmEntity(adgmRow()), emptyState(), false);
        expect(isHighValueChange(baseline)).toBe(false);

        const state = emptyState();
        state.entities[baseline.entity.recordId] = {
            statusFingerprint: baseline.statusFingerprint,
            contentFingerprint: baseline.contentFingerprint,
            registrationStatus: 'Registered',
            licenseStatus: 'Licensed',
            tradeNameStatus: null,
            lastSeen: '2026-01-01T00:00:00.000Z',
        };
        const unchanged = classify(normalizeAdgmEntity(adgmRow()), state, true);
        expect(unchanged.eventType).toBe('ENTITY_UNCHANGED');
        expect(isHighValueChange(unchanged)).toBe(false);
    });
});

describe('toOutputRecord / computeEventId', () => {
    it('produces a stable idempotency key across two INDEPENDENTLY-constructed classifications of equivalent data', () => {
        const classifiedA = classify(normalizeAdgmEntity(adgmRow()), emptyState(), true);
        const classifiedB = classify(normalizeAdgmEntity(adgmRow()), emptyState(), true);
        expect(computeEventId(classifiedA)).toBe(computeEventId(classifiedB));
    });

    it('produces a DIFFERENT idempotency key when the underlying classification genuinely differs', () => {
        const classifiedA = classify(normalizeAdgmEntity(adgmRow()), emptyState(), true);
        const classifiedB = classify(normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Deregistered' })), emptyState(), true);
        expect(computeEventId(classifiedA)).not.toBe(computeEventId(classifiedB));
    });

    it('carries the previous-status fields on a STATUS_CHANGED record', () => {
        const state = emptyState();
        const first = classify(normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Registered' })), state, false);
        state.entities[first.entity.recordId] = {
            statusFingerprint: first.statusFingerprint,
            contentFingerprint: first.contentFingerprint,
            registrationStatus: 'Registered',
            licenseStatus: 'Licensed',
            tradeNameStatus: null,
            lastSeen: '2026-01-01T00:00:00.000Z',
        };
        const changed = classify(normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Deregistered' })), state, true);
        const record = toOutputRecord(changed, '2026-01-01T00:00:00.000Z');
        expect(record.previous_registration_status).toBe('Registered');
        expect(record.registration_status).toBe('Deregistered');
        expect(record.data_source).toBe('ADGM_FREEZONE');
        expect(record.free_zone).toBe(true);
    });
});
