import { createHash } from 'node:crypto';

import { normalizeArabicText, normalizeEnglishText, splitActivityList } from './bilingualNormalizer.js';
import type { AdgmEntityRow, ClassifiedEvent, DeltaState, DifcCompanyRow, DubaiLicenseRow, DubaiTradeNameRow, EventType, NormalizedEntity, StoredFingerprint } from './types.js';

function requireNonEmpty(value: string | null | undefined, fieldLabel: string): string {
    if (value === null || value === undefined || value.trim().length === 0) {
        throw new Error(`Row is missing a required field (${fieldLabel}) - cannot normalize this record.`);
    }
    return value;
}

/**
 * Maps a raw Dubai Pulse license row (+ its joined trade-name row, if any) into the shared
 * NormalizedEntity envelope. `license_number` is the natural key DED itself uses across both
 * datasets (see types.ts's DubaiLicenseRow/DubaiTradeNameRow) - it is required and non-empty here
 * exactly like Actor #3's `bondType`/auction-date validation, to fail loudly on a genuinely
 * malformed row rather than silently fabricate a record identity.
 */
export function normalizeDubaiEntity(license: DubaiLicenseRow, tradeName: DubaiTradeNameRow | null): NormalizedEntity {
    const licenseNumber = requireNonEmpty(license.license_number, 'license_number');
    const nameEn = tradeName?.trade_name_en ?? licenseNumber;
    const nameAr = tradeName?.trade_name_ar ?? null;
    return {
        dataSource: 'DUBAI_MAINLAND',
        recordId: `DUBAI_MAINLAND::${licenseNumber}`,
        sourceSpecificId: licenseNumber,
        commercialNameEn: nameEn,
        commercialNameEnNormalized: normalizeEnglishText(nameEn) ?? nameEn,
        commercialNameAr: nameAr,
        commercialNameArNormalized: normalizeArabicText(nameAr),
        legalForm: license.license_category_desc_en,
        registrationStatus: license.license_status_desc_en,
        licenseStatus: license.license_status_desc_en,
        tradeNameStatus: null,
        activities: license.license_category_desc_en ? [license.license_category_desc_en] : [],
        issueDate: license.issue_date,
        expiryDate: license.expiry_date,
        cancelDate: license.cancel_date,
        registeredAddress: null,
        freeZone: false,
    };
}

/** Maps a raw ADGM entity row into the shared envelope. `Registration_Number__c` is ADGM's own stable per-entity identifier - required non-empty, same discipline as normalizeDubaiEntity. */
export function normalizeAdgmEntity(row: AdgmEntityRow): NormalizedEntity {
    const registrationNumber = requireNonEmpty(row.Registration_Number__c, 'Registration_Number__c');
    const nameEn = requireNonEmpty(row.Name, 'Name');
    const address = row.Addresses__r?.[0]?.Full_Address__c ?? row.Addresses__r?.[0]?.Address_for_DDP__c ?? null;
    return {
        dataSource: 'ADGM_FREEZONE',
        recordId: `ADGM_FREEZONE::${registrationNumber}`,
        sourceSpecificId: registrationNumber,
        commercialNameEn: nameEn,
        commercialNameEnNormalized: normalizeEnglishText(nameEn) ?? nameEn,
        commercialNameAr: null,
        commercialNameArNormalized: null,
        legalForm: row.Entity_Type__c,
        registrationStatus: row.Entity_Status__c,
        licenseStatus: row.License_Status__c,
        // Found missing entirely by adversarial review: ADGM's real captured response includes a
        // Trade_Names__r array (see AGENTS.md section 0.3), whose own Status__c (e.g. a trade
        // name moving from "Active" to "Inactive") is a genuine status signal distinct from
        // Entity_Status__c/License_Status__c - previously dropped entirely, making it invisible to
        // the delta engine. The primary (first-listed) trade name is used, matching how ADGM's own
        // real captured examples always list the main trading name first.
        tradeNameStatus: row.Trade_Names__r?.[0]?.Status__c ?? null,
        activities: row.Category__c ? [row.Category__c, ...(row.Entity_Sub_Type__c ? [row.Entity_Sub_Type__c] : [])] : [],
        issueDate: row.Incorporation_Date__c,
        expiryDate: null,
        cancelDate: null,
        registeredAddress: address,
        freeZone: true,
    };
}

/** Maps a raw DIFC company row into the shared envelope. `Registration_License_No__c` is DIFC's own stable per-entity identifier - required non-empty, same discipline as the other two normalizers. */
export function normalizeDifcEntity(row: DifcCompanyRow): NormalizedEntity {
    const licenseNo = requireNonEmpty(row.Registration_License_No__c, 'Registration_License_No__c');
    const nameEn = requireNonEmpty(row.Name, 'Name');
    return {
        dataSource: 'DIFC_FREEZONE',
        recordId: `DIFC_FREEZONE::${licenseNo}`,
        sourceSpecificId: licenseNo,
        commercialNameEn: nameEn,
        commercialNameEnNormalized: normalizeEnglishText(nameEn) ?? nameEn,
        commercialNameAr: null,
        commercialNameArNormalized: null,
        legalForm: row.Legal_Type_of_Entity__c ?? row.Legal_Entity_Type__c,
        registrationStatus: row.ROC_Status__c,
        licenseStatus: row.ROC_Status__c,
        tradeNameStatus: null,
        activities: splitActivityList(row.License_Activity_Details__c),
        issueDate: row.ROC_reg_incorp_Date__c,
        expiryDate: null,
        cancelDate: null,
        registeredAddress: row.Registered_Address__c,
        freeZone: true,
    };
}

/** SHA-256 over the fields that define "has the entity's STATUS changed" specifically - separate from the broader content fingerprint so a status transition can be distinguished from a cosmetic content edit (e.g. an address typo fix) even though both are real content changes. */
export function computeStatusFingerprint(entity: NormalizedEntity): string {
    return createHash('sha256')
        .update(JSON.stringify([entity.registrationStatus, entity.licenseStatus, entity.tradeNameStatus]))
        .digest('hex');
}

/**
 * SHA-256 over every field EXCEPT `recordId` itself - mirroring Actor #3's documented convention
 * (only the record's own identity key is excluded from its own content hash; every field that
 * forms part of that identity elsewhere, like sourceSpecificId, is still hashed here since it is
 * also a piece of the record's real content).
 */
export function computeContentFingerprint(entity: NormalizedEntity): string {
    const { recordId, ...hashableFields } = entity;
    void recordId;
    return createHash('sha256').update(JSON.stringify(hashableFields)).digest('hex');
}

export function toStoredFingerprint(classified: ClassifiedEvent, scrapedAt: string): StoredFingerprint {
    return {
        statusFingerprint: classified.statusFingerprint,
        contentFingerprint: classified.contentFingerprint,
        registrationStatus: classified.entity.registrationStatus,
        licenseStatus: classified.entity.licenseStatus,
        tradeNameStatus: classified.entity.tradeNameStatus,
        lastSeen: scrapedAt,
    };
}

export function classify(entity: NormalizedEntity, state: DeltaState, baselineComplete: boolean): ClassifiedEvent {
    const statusFingerprint = computeStatusFingerprint(entity);
    const contentFingerprint = computeContentFingerprint(entity);
    const previous = state.entities[entity.recordId];

    let eventType: EventType;
    if (!previous) {
        eventType = baselineComplete ? 'NEW_ENTITY' : 'BASELINE_SNAPSHOT';
    } else if (previous.statusFingerprint !== statusFingerprint) {
        eventType = 'STATUS_CHANGED';
    } else if (previous.contentFingerprint !== contentFingerprint) {
        eventType = 'ENTITY_UPDATED';
    } else {
        eventType = 'ENTITY_UNCHANGED';
    }

    return {
        entity,
        eventType,
        statusFingerprint,
        contentFingerprint,
        previousRegistrationStatus: previous?.registrationStatus ?? null,
        previousLicenseStatus: previous?.licenseStatus ?? null,
        previousTradeNameStatus: previous?.tradeNameStatus ?? null,
    };
}

/** onlyNew=true (the default) delivers only genuinely new/changed records - never re-delivers an unchanged one, mirroring the fleet-wide onlyNew convention from Actors #1-3. */
export function shouldDeliver(classified: ClassifiedEvent, onlyNew: boolean): boolean {
    if (classified.eventType === 'ENTITY_UNCHANGED' || classified.eventType === 'BASELINE_SNAPSHOT') {
        return !onlyNew;
    }
    return true;
}
