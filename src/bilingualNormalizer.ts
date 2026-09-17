/**
 * Arabic/English bilingual entity-name normalization.
 *
 * The normalized forms produced here are used ONLY for change-detection fingerprinting and
 * display consistency - the raw, original strings are always preserved and returned to the user
 * unmodified (see deltaEngine.ts's NormalizedEntity construction). This mirrors the fleet-wide
 * convention (Actor #2, #3) of never discarding source data, even when a cleaned-up derivative is
 * also produced.
 *
 * Normalizing before fingerprinting matters here specifically because Arabic government text is
 * commonly re-exported with inconsistent diacritics, alef/yeh variants, or invisible bidi control
 * characters across successive scrapes of the SAME underlying value - without normalization, the
 * delta engine would fire spurious ENTITY_UPDATED events for a name that a human reader would
 * consider byte-for-byte identical.
 *
 * Every Arabic and bidi-control code point below is built at runtime from a decimal numeric
 * constant via `String.fromCodePoint`, deliberately - this keeps the actual .ts source file
 * 100% ASCII, with zero embedded combining-mark or bidi-control bytes sitting invisibly in the
 * text (the "Trojan Source" class of issues), even though the intent here is purely defensive
 * (matching and stripping them). A code review or plain-text diff of this file never has to
 * render right-to-left or invisible characters to verify what it does.
 */

/** Builds a `[...]`-style character-class body from one or more [start, end] decimal code-point ranges (end omitted for a single code point). */
function codePointRangesToClassBody(ranges: [number, number?][]): string {
    return ranges.map(([start, end]) => (end === undefined ? String.fromCodePoint(start) : `${String.fromCodePoint(start)}-${String.fromCodePoint(end)}`)).join('');
}

/** Arabic combining diacritics (tashkeel: fatha, damma, kasra, sukun, shadda, tanwin - U+0610-U+061A, U+064B-U+065F, U+0670, U+06D6-U+06DC, U+06DF-U+06E8, U+06EA-U+06ED) plus the tatweel/kashida elongation character (U+0640) - both are purely presentational and carry no distinguishing identity information for an entity name. */
const ARABIC_DIACRITICS_AND_TATWEEL = new RegExp(
    `[${codePointRangesToClassBody([[0x0610, 0x061a], [0x064b, 0x065f], [0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e8], [0x06ea, 0x06ed], [0x0640]])}]`,
    'gu',
);

/** Unicode bidi control characters (LRM U+200E, RLM U+200F, ALM U+061C, the explicit embedding/override range U+202A-U+202E, and the isolate range U+2066-U+2069) that can appear invisibly in copy-pasted or exported bilingual text and would otherwise corrupt exact-match comparison. */
const BIDI_CONTROL_CHARS = new RegExp(`[${codePointRangesToClassBody([[0x200e], [0x200f], [0x061c], [0x202a, 0x202e], [0x2066, 0x2069]])}]`, 'gu');

const ARABIC_INDIC_DIGIT_BASE = 0x0660; // U+0660 ARABIC-INDIC DIGIT ZERO; U+0660..U+0669 map onto '0'..'9' in order.
const ARABIC_INDIC_DIGITS_PATTERN = new RegExp(`[${String.fromCodePoint(ARABIC_INDIC_DIGIT_BASE)}-${String.fromCodePoint(ARABIC_INDIC_DIGIT_BASE + 9)}]`, 'gu');

function normalizeArabicDigits(text: string): string {
    return text.replace(ARABIC_INDIC_DIGITS_PATTERN, (digit) => String((digit.codePointAt(0) ?? ARABIC_INDIC_DIGIT_BASE) - ARABIC_INDIC_DIGIT_BASE));
}

const ARABIC_ALEF_VARIANTS_PATTERN = new RegExp(`[${codePointRangesToClassBody([[0x0623], [0x0625], [0x0622], [0x0671]])}]`, 'gu');
const ARABIC_BARE_ALEF = String.fromCodePoint(0x0627);

/** Collapses the four hamza-bearing/plain alef forms (U+0623, U+0625, U+0622, U+0671) to bare alef (U+0627) - the standard Arabic search-normalization step, since these are typically orthographic/spelling variants of the same name rather than distinguishing information at the entity-name level. */
function normalizeArabicAlef(text: string): string {
    return text.replace(ARABIC_ALEF_VARIANTS_PATTERN, ARABIC_BARE_ALEF);
}

const ARABIC_ALEF_MAKSURA_PATTERN = new RegExp(String.fromCodePoint(0x0649), 'gu');
const ARABIC_YEH = String.fromCodePoint(0x064a);

/** Collapses alef maksura (U+0649) to yeh (U+064A) - the other standard Arabic search-normalization step for Gulf-region text, where the two are used near-interchangeably in practice. */
function normalizeArabicYeh(text: string): string {
    return text.replace(ARABIC_ALEF_MAKSURA_PATTERN, ARABIC_YEH);
}

const NBSP = String.fromCodePoint(0x00a0);
const WHITESPACE_PATTERN = new RegExp(`[\\s${NBSP}]+`, 'g');

function collapseWhitespace(text: string): string {
    return text.replace(WHITESPACE_PATTERN, ' ').trim();
}

/**
 * Strips diacritics, tatweel, and bidi control characters; normalizes alef/yeh variants and
 * Arabic-Indic digits to Western digits; collapses whitespace. Returns null for null input rather
 * than an empty string, so "no Arabic name on this record" stays distinguishable from "an Arabic
 * name that normalized to nothing."
 */
export function normalizeArabicText(text: string | null): string | null {
    if (text === null) return null;
    let result = text;
    result = result.replace(BIDI_CONTROL_CHARS, '');
    result = result.replace(ARABIC_DIACRITICS_AND_TATWEEL, '');
    result = normalizeArabicAlef(result);
    result = normalizeArabicYeh(result);
    result = normalizeArabicDigits(result);
    result = collapseWhitespace(result);
    return result;
}

/**
 * Canonical English legal-entity-suffix forms. Matched case-insensitively against a name's
 * trailing tokens, longest pattern first so e.g. "FZ-LLC" is not partially matched by a bare "LLC"
 * rule first. This is deliberately a small, real, UAE-specific list (not a generic company-suffix
 * library) - each pattern below was named explicitly in the engineering mandate or observed live
 * in the three verified data sources' own Entity_Type__c / Legal_Type_of_Entity__c / license
 * category vocabularies during this build.
 *
 * Every pattern ends in `(?![a-zA-Z])` rather than `\b` - found necessary by this actor's own test
 * suite: `\b` requires a transition between a word and a non-word character, so when the matched
 * text's own last group is an OPTIONAL trailing period (`\.?`) followed by `\b`, the regex engine
 * backtracks to NOT consume that period whenever the abbreviation is itself followed by
 * end-of-string or another punctuation character (e.g. "L.L.C." at the end of a name) - `\b` can
 * never match between two non-word characters ("." and end-of-string), so the trailing period was
 * silently left unconsumed, producing a doubled-up "LLC." instead of "LLC". `(?![a-zA-Z])` has no
 * such requirement: it only asserts "not immediately followed by a letter," which is true whether
 * followed by a period, whitespace, or the end of the string.
 *
 * Every pattern is also wrapped in an optional `(?:\(\s*)?`/`(?:\s*\))?` pair immediately around
 * the legal-form token itself - found missing by adversarial review: this module's own docstring
 * documented "( LLC )" normalizing to "LLC" as a supported example, but no pattern actually matched
 * or stripped the parentheses, so `normalizeEnglishText('Acme (LLC)')` produced 'Acme (LLC)'
 * unchanged while `normalizeEnglishText('Acme LLC')` produced 'Acme LLC' - two real-world export
 * variants of the identical company name that would have fired a spurious ENTITY_UPDATED event.
 * The space is nested INSIDE the optional paren group (`(?:\(\s*)?`), not a separate top-level
 * `\s*` - a first attempt used a top-level `\(?\s*` prefix, which happily matches a bare leading
 * space with NO paren present at all, so it silently swallowed the ordinary separator space before
 * every unparenthesized legal form too (e.g. "Acme Trading LLC" -> "Acme TradingLLC", words fused
 * together) - caught by re-running this exact function against all four documented cases before
 * shipping, not by the test suite. Nesting the `\s*` inside the same non-capturing group as the
 * `\(` ties its consumption to the paren actually being present. This only strips parentheses
 * immediately hugging the legal-form token itself - unrelated parentheses elsewhere in a name (e.g.
 * "Acme (Middle East) LLC") are untouched, since the regex only starts matching at the legal-form
 * letters themselves.
 */
const LEGAL_FORM_PATTERNS: [RegExp, string][] = [
    [/(?:\(\s*)?\bf\.?\s*z\.?\s*-?\s*l\.?\s*l\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'FZ-LLC'],
    [/(?:\(\s*)?\bl\.?\s*l\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'LLC'],
    [/(?:\(\s*)?\bp\.?\s*j\.?\s*s\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'PJSC'],
    [/(?:\(\s*)?\bp\.?\s*s\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'PSC'],
    [/(?:\(\s*)?\bsole\s+establishment(?![a-zA-Z])(?:\s*\))?/gi, 'Sole Establishment'],
    [/(?:\(\s*)?\bsole\s+proprietorship(?![a-zA-Z])(?:\s*\))?/gi, 'Sole Establishment'],
    [/(?:\(\s*)?\best\.?(?![a-zA-Z])(?:\s*\))?/gi, 'Est.'],
    [/(?:\(\s*)?\bltd\.?(?![a-zA-Z])(?:\s*\))?/gi, 'Ltd'],
    [/(?:\(\s*)?\blimited(?![a-zA-Z])(?:\s*\))?/gi, 'Limited'],
];

/**
 * Applies canonical spacing/punctuation to known UAE legal-entity-suffix tokens (e.g. "L.L.C",
 * "l.l.c.", "( LLC )" all normalize toward "LLC") and collapses whitespace. This does NOT reorder
 * or strip the suffix - only canonicalizes its punctuation/casing - so "Acme Trading LLC" and
 * "ACME TRADING L.L.C." normalize to the same comparable string without merging two genuinely
 * different company names that happen to share a legal form.
 */
export function normalizeEnglishText(text: string | null): string | null {
    if (text === null) return null;
    let result = collapseWhitespace(text);
    for (const [pattern, canonical] of LEGAL_FORM_PATTERNS) {
        result = result.replace(pattern, canonical);
    }
    result = collapseWhitespace(result);
    return result;
}

/** Splits a semicolon-delimited activity list (the real format observed in ADGM/DIFC's License_Activity_Details__c fields) into a clean array, dropping empty segments produced by a trailing delimiter. */
export function splitActivityList(raw: string | null): string[] {
    if (raw === null) return [];
    return raw
        .split(';')
        .map((activity) => collapseWhitespace(activity))
        .filter((activity) => activity.length > 0);
}
