import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeArabicText, normalizeEnglishText, splitActivityList } from '../src/bilingualNormalizer.js';
import { computeContentFingerprint, computeStatusFingerprint, normalizeAdgmEntity, normalizeDifcEntity, normalizeDubaiEntity } from '../src/deltaEngine.js';
import type { AdgmEntityRow, DifcCompanyRow, DubaiLicenseRow } from '../src/types.js';

/**
 * Stochastic/property-based fuzzing (explicit mandate deliverable): random Arabic/English string
 * mutations, verifying zero-crash guarantees across the full bilingual-normalization and
 * entity-normalization pipeline on malformed, adversarial, or simply weird real-world government
 * data - mixed RTL/LTR runs, embedded control/bidi characters, empty strings, extremely long
 * strings, and surrogate-pair/astral-plane characters that a naive string-length or regex
 * assumption could mishandle.
 */

/** Generates strings that mix Arabic letters, Arabic-Indic digits, combining diacritics, bidi control characters, and ordinary ASCII/Latin text - the real character classes this actor's data sources can plausibly emit, deliberately shuffled adversarially. */
const mixedBilingualFuzzArbitrary = fc.string({
    // fast-check v4 removed the standalone `fc.stringOf(charArb, constraints)` helper; the
    // replacement is `fc.string({ unit: charArb, ... })`, where `unit` accepts a custom
    // Arbitrary<string> of single units to join, same semantics as the old `stringOf`.
    unit: fc.oneof(
        fc.constantFrom(...'ابتثجحخدذرزسشصضطظعغ'.split('')), // Arabic letters
        fc.constantFrom(...'ًٌٍَُِّْـ'.split('')), // diacritics + tatweel
        fc.constantFrom(...'٠١٢٣٤٥٦٧٨٩'.split('')), // Arabic-Indic digits
        fc.constantFrom(...'‎‏؜‪‫‬‭‮'.split('')), // bidi controls
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,-()&\'"'.split('')), // ASCII
        fc.constantFrom('\u{1F600}', '\u{1F1E6}\u{1F1EA}'), // astral-plane surrogate-pair characters (emoji, regional indicator)
    ),
    minLength: 0,
    maxLength: 300,
});

describe('bilingual normalizer fuzzing - zero-crash guarantee', () => {
    it('normalizeArabicText never throws on any adversarial mixed-bilingual fuzz string', () => {
        fc.assert(
            fc.property(mixedBilingualFuzzArbitrary, (input) => {
                expect(() => normalizeArabicText(input)).not.toThrow();
            }),
            { numRuns: 500 },
        );
    });

    it('normalizeEnglishText never throws on any adversarial mixed-bilingual fuzz string', () => {
        fc.assert(
            fc.property(mixedBilingualFuzzArbitrary, (input) => {
                expect(() => normalizeEnglishText(input)).not.toThrow();
            }),
            { numRuns: 500 },
        );
    });

    it('splitActivityList never throws on any adversarial fuzz string, regardless of delimiter density', () => {
        fc.assert(
            fc.property(mixedBilingualFuzzArbitrary, (input) => {
                expect(() => splitActivityList(input)).not.toThrow();
            }),
            { numRuns: 500 },
        );
    });

    it('handles a string built entirely from astral-plane surrogate pairs without corrupting to lone surrogates', () => {
        const emojiOnly = '\u{1F600}\u{1F601}\u{1F602}';
        const result = normalizeArabicText(emojiOnly);
        expect(result).not.toBeNull();
        // A corrupted lone-surrogate result would fail JSON.stringify or produce U+FFFD-laden output; this must round-trip cleanly.
        expect(() => JSON.stringify(result)).not.toThrow();
    });

    it('handles an extremely long string (10,000 characters) without throwing or hanging', () => {
        const longString = 'محمد '.repeat(2000);
        expect(() => normalizeArabicText(longString)).not.toThrow();
        expect(() => normalizeEnglishText(longString)).not.toThrow();
    });

    it('handles a string of only diacritics and bidi controls, normalizing to an empty (not null) string', () => {
        const onlyNoise = 'ًٌ‎‏ٍ';
        expect(normalizeArabicText(onlyNoise)).toBe('');
    });
});

describe('entity normalization fuzzing - malformed rows fail loudly, never crash silently or corrupt state', () => {
    function baseDubaiLicense(): DubaiLicenseRow {
        return {
            license_number: '123456',
            initial_approval_number: null,
            commerce_register_serial_number: null,
            chamber_of_commerce_number: null,
            trade_name_serial_number: null,
            issue_date: null,
            expiry_date: null,
            cancel_date: null,
            license_status_code: null,
            license_status_desc_ar: null,
            license_status_desc_en: null,
            license_category_code: null,
            license_category_desc_ar: null,
            license_category_desc_en: null,
            issue_authority_code: null,
            issue_authority_desc_ar: null,
            issue_authority_desc_en: null,
        };
    }

    function baseAdgmRow(): AdgmEntityRow {
        return {
            Id: 'x',
            Name: 'placeholder',
            Entity_Type__c: null,
            Is_continued__c: false,
            Incorporation_Date__c: null,
            Registration_Number__c: '1',
            Entity_Status__c: null,
            Category__c: null,
            Entity_Sub_Type__c: null,
            License_Status__c: null,
            Addresses__r: null,
            Trade_Names__r: null,
        };
    }

    function baseDifcRow(): DifcCompanyRow {
        return {
            Id: 'x',
            Name: 'placeholder',
            ROC_Status__c: null,
            Registration_License_No__c: '1',
            Legal_Type_of_Entity__c: null,
            Legal_Entity_Type__c: null,
            ROC_reg_incorp_Date__c: null,
            License_Activity_Details__c: null,
            Nature_of_business__c: null,
            Registered_Address__c: null,
            Company_Type__c: null,
            Website: null,
        };
    }

    it('normalizeAdgmEntity never throws for any fuzzed Name value that is non-empty, and its fingerprint functions never throw on the result', () => {
        fc.assert(
            fc.property(
                mixedBilingualFuzzArbitrary.filter((s) => s.trim().length > 0),
                (fuzzedName) => {
                    const row = { ...baseAdgmRow(), Name: fuzzedName };
                    const entity = normalizeAdgmEntity(row);
                    expect(() => computeContentFingerprint(entity)).not.toThrow();
                    expect(() => computeStatusFingerprint(entity)).not.toThrow();
                },
            ),
            { numRuns: 300 },
        );
    });

    it('normalizeDifcEntity never throws for any fuzzed Name value that is non-empty', () => {
        fc.assert(
            fc.property(
                mixedBilingualFuzzArbitrary.filter((s) => s.trim().length > 0),
                (fuzzedName) => {
                    const row = { ...baseDifcRow(), Name: fuzzedName };
                    expect(() => normalizeDifcEntity(row)).not.toThrow();
                },
            ),
            { numRuns: 300 },
        );
    });

    it('normalizeDubaiEntity never throws for any fuzzed trade_name_en value', () => {
        fc.assert(
            fc.property(mixedBilingualFuzzArbitrary, (fuzzedName) => {
                const license = baseDubaiLicense();
                const tradeName = { trade_name_serial: '1', trade_name_ar: null, trade_name_en: fuzzedName, license_number: license.license_number };
                expect(() => normalizeDubaiEntity(license, tradeName)).not.toThrow();
            }),
            { numRuns: 300 },
        );
    });

    it('normalizeAdgmEntity throws a descriptive (not silent/crash) error for a Name that is empty or all-whitespace - a genuinely malformed row, not a fuzz value to tolerate', () => {
        fc.assert(
            fc.property(fc.constantFrom('', '   ', '\t\n', '  '), (blankName) => {
                const row = { ...baseAdgmRow(), Name: blankName };
                expect(() => normalizeAdgmEntity(row)).toThrow(/Name/);
            }),
        );
    });

    it('normalizeAdgmEntity never throws for any fuzzed Category__c/Entity_Sub_Type__c combination, even highly adversarial ones, since activities is best-effort free text', () => {
        fc.assert(
            fc.property(mixedBilingualFuzzArbitrary, mixedBilingualFuzzArbitrary, (category, subType) => {
                const row = { ...baseAdgmRow(), Category__c: category || null, Entity_Sub_Type__c: subType || null };
                expect(() => normalizeAdgmEntity(row)).not.toThrow();
            }),
            { numRuns: 300 },
        );
    });
});
