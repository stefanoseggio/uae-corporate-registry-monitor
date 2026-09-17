import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeArabicText, normalizeEnglishText, splitActivityList } from '../src/bilingualNormalizer.js';

describe('normalizeArabicText - unit', () => {
    it('returns null for null input, never a fabricated empty string', () => {
        expect(normalizeArabicText(null)).toBeNull();
    });

    it('strips Arabic diacritics (tashkeel) while preserving the base letters', () => {
        // "مُحَمَّد" = Muhammad with full diacritics; base letters (no tashkeel) = "محمد"
        const withDiacritics = 'مُحَمَّد';
        const bareLetters = 'محمد';
        expect(normalizeArabicText(withDiacritics)).toBe(bareLetters);
    });

    it('strips the tatweel/kashida elongation character', () => {
        // "الـــسم" (name with kashida stretching) normalizes to "السم"
        expect(normalizeArabicText('الـــسم')).toBe('السم');
    });

    it('normalizes all four hamza-bearing/plain alef variants to bare alef', () => {
        const bareAlefWord = 'احمد'; // "Ahmad" spelled with bare alef
        expect(normalizeArabicText('أحمد')).toBe(bareAlefWord); // alef with hamza above
        expect(normalizeArabicText('إحمد')).toBe(bareAlefWord); // alef with hamza below
        expect(normalizeArabicText('آحمد')).toBe(bareAlefWord); // alef with madda above
        expect(normalizeArabicText('ٱحمد')).toBe(bareAlefWord); // alef wasla
    });

    it('normalizes alef maksura to yeh', () => {
        // "مصطفى" (Mustafa ending in alef maksura) -> ends in yeh
        expect(normalizeArabicText('مصطفى')).toBe('مصطفي');
    });

    it('converts Arabic-Indic digits to Western digits', () => {
        // "١٢٣" = Arabic-Indic "123"
        expect(normalizeArabicText('١٢٣')).toBe('123');
    });

    it('strips invisible bidi control characters (LRM, RLM)', () => {
        const withBidi = `‎abc‏def`;
        expect(normalizeArabicText(withBidi)).toBe('abcdef');
    });

    it('collapses multiple whitespace characters (including NBSP) into a single space and trims', () => {
        expect(normalizeArabicText('  محمد  دبي  ')).toBe('محمد دبي');
    });

    it('is idempotent: normalizing an already-normalized string returns the same string', () => {
        const raw = 'أحمد محمد';
        const once = normalizeArabicText(raw);
        const twice = normalizeArabicText(once);
        expect(twice).toBe(once);
    });
});

describe('normalizeArabicText - property-based', () => {
    it('never throws and always returns a string for any non-null input, including adversarial fuzz strings', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
                expect(() => normalizeArabicText(input)).not.toThrow();
                expect(typeof normalizeArabicText(input)).toBe('string');
            }),
        );
    });

    it('never produces a leading or trailing space', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
                const result = normalizeArabicText(input) ?? '';
                expect(result.startsWith(' ')).toBe(false);
                expect(result.endsWith(' ')).toBe(false);
            }),
        );
    });

    it('never contains a double space (whitespace is fully collapsed)', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
                const result = normalizeArabicText(input) ?? '';
                expect(result.includes('  ')).toBe(false);
            }),
        );
    });
});

describe('normalizeEnglishText - unit', () => {
    it('returns null for null input', () => {
        expect(normalizeEnglishText(null)).toBeNull();
    });

    it('canonicalizes real LLC punctuation/spacing variants to a single form', () => {
        expect(normalizeEnglishText('Acme Trading LLC')).toBe('Acme Trading LLC');
        expect(normalizeEnglishText('Acme Trading L.L.C.')).toBe('Acme Trading LLC');
        expect(normalizeEnglishText('Acme Trading l.l.c')).toBe('Acme Trading LLC');
    });

    it('strips parentheses tightly wrapping the legal form, matching this module\'s own documented "( LLC )" example - a real bug found by adversarial review (the parens were previously left untouched)', () => {
        expect(normalizeEnglishText('Acme Trading (LLC)')).toBe('Acme Trading LLC');
        expect(normalizeEnglishText('Acme Trading ( LLC )')).toBe('Acme Trading LLC');
    });

    it('does not swallow the ordinary separator space before an unparenthesized legal form - a real regression caught while fixing the parentheses case above (an earlier fix attempt fused "Trading" and "LLC" together)', () => {
        expect(normalizeEnglishText('Acme Trading LLC')).toBe('Acme Trading LLC');
        expect(normalizeEnglishText('Acme Trading Ltd')).toBe('Acme Trading Ltd');
    });

    it('leaves parentheses elsewhere in the name untouched, only stripping the pair immediately hugging the legal-form token', () => {
        expect(normalizeEnglishText('Acme (Middle East) LLC')).toBe('Acme (Middle East) LLC');
    });

    it('canonicalizes FZ-LLC variants without being partially matched by the bare LLC rule', () => {
        expect(normalizeEnglishText('Acme FZ-LLC')).toBe('Acme FZ-LLC');
        expect(normalizeEnglishText('Acme FZ LLC')).toBe('Acme FZ-LLC');
        expect(normalizeEnglishText('Acme F.Z.-L.L.C.')).toBe('Acme FZ-LLC');
    });

    it('canonicalizes PJSC and PSC variants', () => {
        expect(normalizeEnglishText('Gulf Holdings P.J.S.C.')).toBe('Gulf Holdings PJSC');
        expect(normalizeEnglishText('Gulf Holdings PSC')).toBe('Gulf Holdings PSC');
    });

    it('canonicalizes Sole Establishment / Sole Proprietorship to one form', () => {
        expect(normalizeEnglishText('Al Futtaim Sole Proprietorship')).toBe('Al Futtaim Sole Establishment');
        expect(normalizeEnglishText('Al Futtaim Sole Establishment')).toBe('Al Futtaim Sole Establishment');
    });

    it('does not merge two genuinely different company names that happen to share a legal form', () => {
        const a = normalizeEnglishText('Acme Trading L.L.C.');
        const b = normalizeEnglishText('Zenith Trading L.L.C.');
        expect(a).not.toBe(b);
    });

    it('collapses whitespace and trims', () => {
        expect(normalizeEnglishText('  Acme   Trading   LLC  ')).toBe('Acme Trading LLC');
    });

    it('is idempotent', () => {
        const once = normalizeEnglishText('ACME   TRADING   L.L.C.');
        const twice = normalizeEnglishText(once);
        expect(twice).toBe(once);
    });
});

describe('normalizeEnglishText - property-based', () => {
    it('never throws for any fuzz input', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
                expect(() => normalizeEnglishText(input)).not.toThrow();
            }),
        );
    });

    it('is idempotent for any fuzz input (a second normalization pass never changes the result further)', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
                const once = normalizeEnglishText(input);
                const twice = normalizeEnglishText(once);
                expect(twice).toBe(once);
            }),
        );
    });
});

describe('splitActivityList', () => {
    it('returns an empty array for null', () => {
        expect(splitActivityList(null)).toEqual([]);
    });

    it('splits a real semicolon-delimited activity string', () => {
        expect(splitActivityList('Holding Company;Managing Office;')).toEqual(['Holding Company', 'Managing Office']);
    });

    it('drops empty segments from a trailing delimiter', () => {
        expect(splitActivityList('Restaurant;')).toEqual(['Restaurant']);
    });

    it('trims whitespace around each activity', () => {
        expect(splitActivityList('  Restaurant  ; Cafeteria ')).toEqual(['Restaurant', 'Cafeteria']);
    });

    it('returns an empty array for an empty or whitespace-only string', () => {
        expect(splitActivityList('')).toEqual([]);
        expect(splitActivityList('   ')).toEqual([]);
    });
});
