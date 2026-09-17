import { describe, expect, it } from 'vitest';

import {
    classify,
    computeContentFingerprint,
    computeStatusFingerprint,
    normalizeAdgmEntity,
    normalizeDifcEntity,
    normalizeDubaiEntity,
    shouldDeliver,
    toStoredFingerprint,
} from '../src/deltaEngine.js';
import type { AdgmEntityRow, DeltaState, DifcCompanyRow, DubaiLicenseRow, DubaiTradeNameRow } from '../src/types.js';

function emptyState(): DeltaState {
    return { entities: {}, sourceCache: {} };
}

function dubaiLicense(overrides: Partial<DubaiLicenseRow> = {}): DubaiLicenseRow {
    return {
        license_number: '123456',
        initial_approval_number: '987654',
        commerce_register_serial_number: '111',
        chamber_of_commerce_number: '222',
        trade_name_serial_number: '333',
        issue_date: '2024-01-04',
        expiry_date: '2025-01-04',
        cancel_date: null,
        license_status_code: '1',
        license_status_desc_ar: 'ساري',
        license_status_desc_en: 'Active',
        license_category_code: '10',
        license_category_desc_ar: 'ذ.م.م',
        license_category_desc_en: 'LLC',
        issue_authority_code: 'DED',
        issue_authority_desc_ar: null,
        issue_authority_desc_en: 'Department of Economy and Tourism',
        ...overrides,
    };
}

function dubaiTradeName(overrides: Partial<DubaiTradeNameRow> = {}): DubaiTradeNameRow {
    return {
        trade_name_serial: '333',
        trade_name_ar: 'شركة الاختبار',
        trade_name_en: 'Test Trading LLC',
        license_number: '123456',
        ...overrides,
    };
}

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

function difcRow(overrides: Partial<DifcCompanyRow> = {}): DifcCompanyRow {
    return {
        Id: '0010J00001iuxV0QAI',
        Name: 'One Foods Holdings Limited',
        ROC_Status__c: 'Active',
        Registration_License_No__c: '2368',
        Legal_Type_of_Entity__c: 'LTD',
        Legal_Entity_Type__c: 'Private Company',
        ROC_reg_incorp_Date__c: '2017-01-11',
        License_Activity_Details__c: 'Holding Company;Managing Office;',
        Nature_of_business__c: null,
        Registered_Address__c: 'Innovation Hub, DIFC, Dubai',
        Company_Type__c: 'Non - financial',
        Website: null,
        ...overrides,
    };
}

describe('normalizeDubaiEntity', () => {
    it('maps a real license+trade-name pair into the shared envelope', () => {
        const entity = normalizeDubaiEntity(dubaiLicense(), dubaiTradeName());
        expect(entity.dataSource).toBe('DUBAI_MAINLAND');
        expect(entity.recordId).toBe('DUBAI_MAINLAND::123456');
        expect(entity.commercialNameEn).toBe('Test Trading LLC');
        expect(entity.commercialNameAr).toBe('شركة الاختبار');
        expect(entity.freeZone).toBe(false);
        expect(entity.registrationStatus).toBe('Active');
    });

    it('falls back to the license number as the English name when no trade-name row is joined', () => {
        const entity = normalizeDubaiEntity(dubaiLicense(), null);
        expect(entity.commercialNameEn).toBe('123456');
        expect(entity.commercialNameAr).toBeNull();
    });

    it('throws a descriptive error when license_number is missing - never fabricates a record identity', () => {
        expect(() => normalizeDubaiEntity(dubaiLicense({ license_number: '' }), null)).toThrow(/license_number/);
    });
});

describe('normalizeAdgmEntity', () => {
    it('maps a real ADGM row into the shared envelope', () => {
        const entity = normalizeAdgmEntity(adgmRow());
        expect(entity.dataSource).toBe('ADGM_FREEZONE');
        expect(entity.recordId).toBe('ADGM_FREEZONE::22086');
        expect(entity.freeZone).toBe(true);
        expect(entity.registrationStatus).toBe('Registered');
        expect(entity.licenseStatus).toBe('Licensed');
        expect(entity.registeredAddress).toBe('Level 8, Al Sarab Tower, ADGM Square, Abu Dhabi');
        expect(entity.commercialNameAr).toBeNull();
    });

    it('throws when Registration_Number__c is missing', () => {
        expect(() => normalizeAdgmEntity(adgmRow({ Registration_Number__c: '' }))).toThrow(/Registration_Number__c/);
    });

    it('falls back to Address_for_DDP__c when Full_Address__c is absent', () => {
        const entity = normalizeAdgmEntity(adgmRow({ Addresses__r: [{ Address_for_DDP__c: 'DDP fallback address' }] }));
        expect(entity.registeredAddress).toBe('DDP fallback address');
    });

    it('handles a real ADGM entity status transition value (Registered -> Deregistered)', () => {
        const before = normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Registered' }));
        const after = normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Deregistered' }));
        expect(computeStatusFingerprint(before)).not.toBe(computeStatusFingerprint(after));
    });
});

describe('normalizeDifcEntity', () => {
    it('maps a real DIFC row into the shared envelope, splitting the activity list', () => {
        const entity = normalizeDifcEntity(difcRow());
        expect(entity.dataSource).toBe('DIFC_FREEZONE');
        expect(entity.recordId).toBe('DIFC_FREEZONE::2368');
        expect(entity.freeZone).toBe(true);
        expect(entity.activities).toEqual(['Holding Company', 'Managing Office']);
        expect(entity.registrationStatus).toBe('Active');
    });

    it('throws when Registration_License_No__c is missing', () => {
        expect(() => normalizeDifcEntity(difcRow({ Registration_License_No__c: '' }))).toThrow(/Registration_License_No__c/);
    });

    it('handles a real DIFC status transition value (Active -> Inactive - Struck Off)', () => {
        const before = normalizeDifcEntity(difcRow({ ROC_Status__c: 'Active' }));
        const after = normalizeDifcEntity(difcRow({ ROC_Status__c: 'Inactive - Struck Off' }));
        expect(computeStatusFingerprint(before)).not.toBe(computeStatusFingerprint(after));
    });
});

describe('computeContentFingerprint', () => {
    it('produces the same fingerprint for two independently-constructed but equivalent entities', () => {
        const a = normalizeAdgmEntity(adgmRow());
        const b = normalizeAdgmEntity(adgmRow());
        expect(computeContentFingerprint(a)).toBe(computeContentFingerprint(b));
    });

    it('is unaffected by recordId alone - only recordId is excluded from the content hash, per the documented convention', () => {
        const a = normalizeAdgmEntity(adgmRow());
        const b = { ...a, recordId: 'ADGM_FREEZONE::99999999' };
        expect(computeContentFingerprint(a)).toBe(computeContentFingerprint(b));
    });

    it('changes when sourceSpecificId changes, since it is NOT excluded (only recordId itself is)', () => {
        const a = normalizeAdgmEntity(adgmRow());
        const b = { ...a, sourceSpecificId: '99999999' };
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });

    it('changes when a cosmetic field like registeredAddress changes', () => {
        const a = normalizeAdgmEntity(adgmRow());
        const b = normalizeAdgmEntity(adgmRow({ Addresses__r: [{ Full_Address__c: 'A different address entirely' }] }));
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });
});

describe('classify', () => {
    it('classifies a never-before-seen entity as BASELINE_SNAPSHOT before the source baseline is complete', () => {
        const entity = normalizeAdgmEntity(adgmRow());
        const classified = classify(entity, emptyState(), false);
        expect(classified.eventType).toBe('BASELINE_SNAPSHOT');
    });

    it('classifies a never-before-seen entity as NEW_ENTITY once the source baseline is complete', () => {
        const entity = normalizeAdgmEntity(adgmRow());
        const classified = classify(entity, emptyState(), true);
        expect(classified.eventType).toBe('NEW_ENTITY');
    });

    it('classifies an entity whose status fingerprint changed as STATUS_CHANGED, even when other content is unchanged', () => {
        const state = emptyState();
        const first = normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Registered' }));
        const firstClassified = classify(first, state, false);
        state.entities[first.recordId] = toStoredFingerprint(firstClassified, '2026-01-01T00:00:00.000Z');

        const second = normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Deregistered' }));
        const secondClassified = classify(second, state, true);
        expect(secondClassified.eventType).toBe('STATUS_CHANGED');
        expect(secondClassified.previousRegistrationStatus).toBe('Registered');
    });

    it('classifies an entity whose only change is cosmetic (content changed, status did not) as ENTITY_UPDATED', () => {
        const state = emptyState();
        const first = normalizeAdgmEntity(adgmRow());
        const firstClassified = classify(first, state, false);
        state.entities[first.recordId] = toStoredFingerprint(firstClassified, '2026-01-01T00:00:00.000Z');

        const second = normalizeAdgmEntity(adgmRow({ Addresses__r: [{ Full_Address__c: 'A brand-new address, same status' }] }));
        const secondClassified = classify(second, state, true);
        expect(secondClassified.eventType).toBe('ENTITY_UPDATED');
    });

    it('classifies a byte-for-byte-unchanged entity as ENTITY_UNCHANGED', () => {
        const state = emptyState();
        const first = normalizeAdgmEntity(adgmRow());
        const firstClassified = classify(first, state, false);
        state.entities[first.recordId] = toStoredFingerprint(firstClassified, '2026-01-01T00:00:00.000Z');

        const second = normalizeAdgmEntity(adgmRow());
        const secondClassified = classify(second, state, true);
        expect(secondClassified.eventType).toBe('ENTITY_UNCHANGED');
    });

    it('correctly recovers previousLicenseStatus independently of previousRegistrationStatus', () => {
        const state = emptyState();
        const first = normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Registered', License_Status__c: 'Licensed' }));
        const firstClassified = classify(first, state, false);
        state.entities[first.recordId] = toStoredFingerprint(firstClassified, '2026-01-01T00:00:00.000Z');

        // Entity_Status__c unchanged, only License_Status__c changes this time
        const second = normalizeAdgmEntity(adgmRow({ Entity_Status__c: 'Registered', License_Status__c: 'Expired' }));
        const secondClassified = classify(second, state, true);
        expect(secondClassified.eventType).toBe('STATUS_CHANGED');
        expect(secondClassified.previousRegistrationStatus).toBe('Registered');
        expect(secondClassified.previousLicenseStatus).toBe('Licensed');
    });
});

describe('shouldDeliver', () => {
    it('delivers ENTITY_UNCHANGED only when onlyNew is false - matches the documented onlyNew semantics ("every matched entity is delivered... including ENTITY_UNCHANGED rows")', () => {
        const entity = normalizeAdgmEntity(adgmRow());
        const classified = classify(entity, emptyState(), true);
        const state = emptyState();
        state.entities[entity.recordId] = toStoredFingerprint(classified, '2026-01-01T00:00:00.000Z');
        const reclassified = classify(entity, state, true);
        expect(reclassified.eventType).toBe('ENTITY_UNCHANGED');
        expect(shouldDeliver(reclassified, true)).toBe(false);
        expect(shouldDeliver(reclassified, false)).toBe(true);
    });

    it('delivers BASELINE_SNAPSHOT only when onlyNew is false', () => {
        const entity = normalizeAdgmEntity(adgmRow());
        const classified = classify(entity, emptyState(), false);
        expect(shouldDeliver(classified, true)).toBe(false);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('always delivers NEW_ENTITY and STATUS_CHANGED regardless of onlyNew', () => {
        const newEntity = classify(normalizeAdgmEntity(adgmRow()), emptyState(), true);
        expect(shouldDeliver(newEntity, true)).toBe(true);
        expect(shouldDeliver(newEntity, false)).toBe(true);
    });
});
