import { createHash } from 'node:crypto';

import { Actor, log } from 'apify';

import { fetchAllAdgmEntities } from './adgmSource.js';
import { classify, normalizeAdgmEntity, normalizeDifcEntity, normalizeDubaiEntity, shouldDeliver, toStoredFingerprint } from './deltaEngine.js';
import { fetchAllDifcCompanies } from './difcSource.js';
import { fetchAllDubaiLicenses, fetchAllDubaiTradeNames } from './dubaiPulseSource.js';
import { notifyAllChannels } from './notifier.js';
import { recordSeen, recordSourceChecked } from './state.js';
import type { ActorInput, ClassifiedEvent, DataSourceId, DeltaState, DubaiTradeNameRow, NormalizedEntity, OutputRecord } from './types.js';
import { ALL_DATA_SOURCES, DEFAULT_DATA_SOURCES } from './types.js';

const EVENT_NEW_ENTITY = 'new-entity';
const EVENT_STATUS_CHANGED = 'status-changed';
const EVENT_ENTITY_UPDATED = 'entity-updated';

export interface RunStats {
    totalPushed: number;
    stopped: boolean;
    sourcesChecked: number;
    byEventType: Record<string, number>;
    /**
     * Real row count actually obtained from each source's fetch THIS run - 0 when the fetch threw
     * (network/parse error) or when the suspected-fetch-failure guard short-circuited it, the real
     * `rows.length` otherwise. A source only gets an entry here if it was genuinely attempted (a
     * requested source deliberately skipped for missing config, e.g. DUBAI_MAINLAND with no API
     * key, never gets one). Used by `shouldWarnAllSourcesZeroDespiteBaseline` below.
     */
    sourceRowCounts: Partial<Record<DataSourceId, number>>;
}

export function computeEventId(classified: ClassifiedEvent): string {
    return createHash('sha1').update(`${classified.entity.recordId}|${classified.eventType}|${classified.statusFingerprint}|${classified.contentFingerprint}`).digest('hex');
}

export function toOutputRecord(classified: ClassifiedEvent, scrapedAt: string): OutputRecord {
    const { entity } = classified;
    return {
        '@type': 'schema:Corporation',
        event_id: computeEventId(classified),
        event_type: classified.eventType,
        record_id: entity.recordId,
        data_source: entity.dataSource,
        free_zone: entity.freeZone,
        commercial_name_en: entity.commercialNameEn,
        commercial_name_ar: entity.commercialNameAr,
        legal_form: entity.legalForm,
        registration_status: entity.registrationStatus,
        license_status: entity.licenseStatus,
        trade_name_status: entity.tradeNameStatus,
        previous_registration_status: classified.previousRegistrationStatus,
        previous_license_status: classified.previousLicenseStatus,
        previous_trade_name_status: classified.previousTradeNameStatus,
        activities: entity.activities,
        issue_date: entity.issueDate,
        expiry_date: entity.expiryDate,
        cancel_date: entity.cancelDate,
        registered_address: entity.registeredAddress,
        status_fingerprint: classified.statusFingerprint,
        content_fingerprint: classified.contentFingerprint,
        is_new: classified.eventType === 'NEW_ENTITY' || classified.eventType === 'BASELINE_SNAPSHOT',
        scraped_at: scrapedAt,
    };
}

export function eventNameFor(eventType: ClassifiedEvent['eventType']): string | undefined {
    switch (eventType) {
        case 'NEW_ENTITY':
            return EVENT_NEW_ENTITY;
        case 'STATUS_CHANGED':
            return EVENT_STATUS_CHANGED;
        case 'ENTITY_UPDATED':
            return EVENT_ENTITY_UPDATED;
        default:
            return undefined; // BASELINE_SNAPSHOT / ENTITY_UNCHANGED - never charged, see README Pricing section
    }
}

/**
 * A status change or a brand-new entity is always worth an active notification (Slack/Teams/
 * webhook) - a cosmetic content edit (address correction, activity-list rewording) is delivered
 * and charged, but not pushed to real-time channels, since it is not the kind of event a
 * compliance buyer needs to act on immediately.
 */
export function isHighValueChange(classified: ClassifiedEvent): boolean {
    return classified.eventType === 'NEW_ENTITY' || classified.eventType === 'STATUS_CHANGED';
}

/**
 * A previously-well-established source (a real, large prior baseline) suddenly reporting far fewer
 * rows than before - with no thrown error, i.e. the fetch itself "succeeded" - is far more likely to
 * be a broken/partial fetch (a shifted response shape the source module's own structural checks
 * didn't happen to catch, a query-parameter regression, a bot-check page, a mid-outage partial
 * response) than a genuine, real-world mass deregistration event across an entire government
 * corporate registry in a single run. This is deliberately a SEPARATE, second layer of defense from
 * adgmSource.ts/difcSource.ts's own structural response-shape checks: those catch a shifted/missing
 * data *path*; this catches a structurally well-formed but implausibly small row *count*, which no
 * shape check can see. `MIN_PREVIOUS_COUNT` keeps this from ever firing on a small/fresh/test state
 * that has not yet built up a real track record.
 */
const SUSPECTED_FETCH_FAILURE_MIN_PREVIOUS_COUNT = 20;
const SUSPECTED_FETCH_FAILURE_MAX_RETAINED_RATIO = 0.5;

function countTrackedEntities(state: DeltaState, dataSource: DataSourceId): number {
    const prefix = `${dataSource}::`;
    let count = 0;
    for (const recordId of Object.keys(state.entities)) {
        if (recordId.startsWith(prefix)) count += 1;
    }
    return count;
}

/**
 * Returns the previously-tracked count when this run's row count looks like a suspected fetch
 * failure rather than a real mass closure/delisting, or `undefined` when it looks legitimate.
 */
function suspectedFetchFailure(state: DeltaState, dataSource: DataSourceId, rowCount: number): number | undefined {
    const previouslyTracked = countTrackedEntities(state, dataSource);
    if (previouslyTracked < SUSPECTED_FETCH_FAILURE_MIN_PREVIOUS_COUNT) return undefined;
    if (rowCount >= previouslyTracked * SUSPECTED_FETCH_FAILURE_MAX_RETAINED_RATIO) return undefined;
    return previouslyTracked;
}

/**
 * Confirmed live finding (see AGENTS.md section 0): ADGM's Salesforce Aura backend can throw a
 * NullPointerException and DIFC's endpoint can return a consistent HTTP 500 for non-browser HTTP
 * clients - including, very plausibly, from Apify's cloud workers - while a real browser session on
 * the identical page succeeds. Both failure modes are caught by processAdgm/processDifc's own
 * try/catch and logged as warnings, so the run still reports SUCCEEDED even though its zero-config
 * default sources (ADGM_FREEZONE, DIFC_FREEZONE) delivered zero real records. A per-source log
 * warning is easy to miss without reading full logs.
 *
 * This is a second, run-level layer of defense, separate from the per-source
 * `suspectedFetchFailure` row-count guard above: it fires only when EVERY source actually attempted
 * this run came back with zero real rows (whether from a thrown fetch error or a short-circuited
 * suspected-failure), AND at least one of those sources has a real, previously-established baseline
 * (i.e. this is not just a fresh actor's very first, legitimately-empty run). That combination is
 * far more consistent with every default source's fetch quietly breaking at once than with a
 * genuine simultaneous real-world event wiping out every tracked source's data.
 */
export function shouldWarnAllSourcesZeroDespiteBaseline(sourceRowCounts: Partial<Record<DataSourceId, number>>, hadEstablishedBaseline: Partial<Record<DataSourceId, boolean>>): boolean {
    const attemptedSources = Object.keys(sourceRowCounts) as DataSourceId[];
    if (attemptedSources.length === 0) return false;
    const allZero = attemptedSources.every((source) => (sourceRowCounts[source] ?? 0) === 0);
    if (!allZero) return false;
    return attemptedSources.some((source) => hadEstablishedBaseline[source] === true);
}

export function buildZeroRecordsDespiteBaselineMessage(attemptedSources: DataSourceId[]): string {
    return (
        `WARNING: all ${attemptedSources.length} attempted data source(s) this run (${attemptedSources.join(', ')}) returned zero records, despite at least one having ` +
        `an established baseline from a previous successful run. This strongly suggests a broken fetch (e.g. an upstream API/schema change or a non-browser-client ` +
        `block) rather than a genuine simultaneous real-world event across every source - check the run log for fetch errors before treating this as a legitimate ` +
        `all-quiet run.`
    );
}

async function processEntity(entity: NormalizedEntity, dataSource: DataSourceId, state: DeltaState, input: ActorInput, scrapedAt: string, stats: RunStats): Promise<void> {
    const onlyNew = input.onlyNew ?? true;
    const sourceCacheEntry = state.sourceCache[dataSource];
    const classified = classify(entity, state, sourceCacheEntry?.baselineComplete ?? false);
    const deliverable = shouldDeliver(classified, onlyNew);

    if (!deliverable) {
        recordSeen(state, entity.recordId, toStoredFingerprint(classified, scrapedAt));
        return;
    }

    const record = toOutputRecord(classified, scrapedAt);
    const eventName = eventNameFor(classified.eventType);
    const pushResult = eventName ? await Actor.pushData(record, eventName) : ({} as { eventChargeLimitReached?: boolean });
    if (!eventName) await Actor.pushData(record);

    // eslint-disable-next-line no-param-reassign
    stats.totalPushed += 1;
    // eslint-disable-next-line no-param-reassign
    stats.byEventType[classified.eventType] = (stats.byEventType[classified.eventType] ?? 0) + 1;

    if (isHighValueChange(classified)) {
        await notifyAllChannels(
            {
                webhookUrl: input.webhookUrl,
                slackWebhookUrl: input.slackWebhookUrl,
                teamsWebhookUrl: input.teamsWebhookUrl,
            },
            record,
        );
    }

    // Only commit the new fingerprint for a row that was successfully pushed (or filtered out
    // above, before any charge risk) - the same truncation-safety discipline as Actor #3's
    // processRow, so a record held back by a charge/item limit remains eligible to be correctly
    // reclassified next run.
    recordSeen(state, entity.recordId, toStoredFingerprint(classified, scrapedAt));

    if (pushResult.eventChargeLimitReached || (input.maxItems && stats.totalPushed >= input.maxItems)) {
        // eslint-disable-next-line no-param-reassign
        stats.stopped = true;
    }
}

/**
 * DED's trade-name dataset legitimately allows multiple rows per license_number (e.g. an old and
 * a renamed trade name DED has not purged) - found by adversarial review: a plain `new Map(rows.map
 * (...))` join silently keeps whichever row happens to be LAST in the array, with no indication a
 * collision occurred. If that array ordering ever differs between two scrapes (e.g. a different
 * page boundary), the arbitrary pick would flip, firing a spurious ENTITY_UPDATED for a license
 * whose real name never changed. Fixed with a deterministic tie-break (highest trade_name_serial
 * wins, treated as the most recently issued trade name) and a logged warning so a real collision
 * is visible rather than silent.
 */
function buildTradeNameIndex(tradeNames: DubaiTradeNameRow[]): Map<string, DubaiTradeNameRow> {
    const index = new Map<string, DubaiTradeNameRow>();
    for (const tradeName of tradeNames) {
        const existing = index.get(tradeName.license_number);
        if (!existing) {
            index.set(tradeName.license_number, tradeName);
            continue;
        }
        const existingSerial = Number(existing.trade_name_serial);
        const candidateSerial = Number(tradeName.trade_name_serial);
        const candidateWins = Number.isFinite(existingSerial) && Number.isFinite(candidateSerial) ? candidateSerial > existingSerial : tradeName.trade_name_serial > existing.trade_name_serial;
        log.warning(
            `DUBAI_MAINLAND: license_number ${tradeName.license_number} has more than one trade-name row (serials ${existing.trade_name_serial} and ${tradeName.trade_name_serial}) - keeping the one with the higher serial as the most recently issued.`,
        );
        if (candidateWins) index.set(tradeName.license_number, tradeName);
    }
    return index;
}

async function processDubaiMainland(state: DeltaState, input: ActorInput, scrapedAt: string, stats: RunStats): Promise<void> {
    if (!input.dubaiPulseApiKey) {
        log.warning(
            'DUBAI_MAINLAND was requested but no dubaiPulseApiKey was supplied - skipping. Dubai Pulse requires your own approved API key (see README "Dubai mainland setup"); this actor cannot provision one automatically.',
        );
        return;
    }
    let licenses;
    let tradeNames;
    try {
        [licenses, tradeNames] = await Promise.all([fetchAllDubaiLicenses(input.dubaiPulseApiKey), fetchAllDubaiTradeNames(input.dubaiPulseApiKey)]);
    } catch (error) {
        // eslint-disable-next-line no-param-reassign
        stats.sourceRowCounts.DUBAI_MAINLAND = 0;
        log.warning(
            `Could not download or parse Dubai Pulse mainland data: ${error instanceof Error ? error.message : String(error)}. Skipping DUBAI_MAINLAND for this run - other selected sources are unaffected.`,
        );
        return;
    }

    // eslint-disable-next-line no-param-reassign
    stats.sourceRowCounts.DUBAI_MAINLAND = licenses.length;
    // eslint-disable-next-line no-param-reassign
    stats.sourcesChecked += 1;
    const tradeNameByLicenseNumber = buildTradeNameIndex(tradeNames);
    log.info(`DUBAI_MAINLAND: parsing ${licenses.length} real license rows.`);

    for (const license of licenses) {
        if (stats.stopped) break;
        let entity: NormalizedEntity;
        try {
            entity = normalizeDubaiEntity(license, tradeNameByLicenseNumber.get(license.license_number) ?? null);
        } catch (error) {
            log.warning(`Skipping one DUBAI_MAINLAND row that could not be normalized: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        await processEntity(entity, 'DUBAI_MAINLAND', state, input, scrapedAt, stats);
    }

    if (!stats.stopped) {
        recordSourceChecked(state, 'DUBAI_MAINLAND', {
            lastChecked: scrapedAt,
            baselineComplete: true,
        });
    }
}

async function processAdgm(state: DeltaState, input: ActorInput, scrapedAt: string, stats: RunStats): Promise<void> {
    let rows;
    try {
        rows = await fetchAllAdgmEntities();
    } catch (error) {
        // eslint-disable-next-line no-param-reassign
        stats.sourceRowCounts.ADGM_FREEZONE = 0;
        log.warning(
            `Could not download or parse ADGM_FREEZONE data: ${error instanceof Error ? error.message : String(error)}. Skipping ADGM_FREEZONE for this run - other selected sources are unaffected.`,
        );
        return;
    }

    // eslint-disable-next-line no-param-reassign
    stats.sourceRowCounts.ADGM_FREEZONE = rows.length;
    const suspectedPrevCount = suspectedFetchFailure(state, 'ADGM_FREEZONE', rows.length);
    if (suspectedPrevCount !== undefined) {
        // Deliberately mirrors the catch block above: return BEFORE incrementing stats.sourcesChecked,
        // touching state.entities, or calling recordSourceChecked, so nothing is wiped/overwritten and
        // every previously-tracked ADGM record remains eligible for correct reclassification the next
        // time this source returns a plausible row count.
        log.error(
            `ADGM_FREEZONE: this run returned only ${rows.length} row(s), down from ${suspectedPrevCount} previously-tracked entities - this looks like a broken or partial fetch, not a real mass deregistration across ADGM's entire register. Skipping ADGM_FREEZONE processing for this run and leaving all previously-tracked records untouched so a future good run can re-evaluate them correctly.`,
        );
        return;
    }

    // eslint-disable-next-line no-param-reassign
    stats.sourcesChecked += 1;
    log.info(`ADGM_FREEZONE: parsing ${rows.length} real entity rows.`);

    for (const row of rows) {
        if (stats.stopped) break;
        let entity: NormalizedEntity;
        try {
            entity = normalizeAdgmEntity(row);
        } catch (error) {
            log.warning(`Skipping one ADGM_FREEZONE row that could not be normalized: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        await processEntity(entity, 'ADGM_FREEZONE', state, input, scrapedAt, stats);
    }

    if (!stats.stopped) {
        recordSourceChecked(state, 'ADGM_FREEZONE', {
            lastChecked: scrapedAt,
            baselineComplete: true,
        });
    }
}

async function processDifc(state: DeltaState, input: ActorInput, scrapedAt: string, stats: RunStats): Promise<void> {
    let rows;
    try {
        rows = await fetchAllDifcCompanies();
    } catch (error) {
        // eslint-disable-next-line no-param-reassign
        stats.sourceRowCounts.DIFC_FREEZONE = 0;
        log.warning(
            `Could not download or parse DIFC_FREEZONE data: ${error instanceof Error ? error.message : String(error)}. Skipping DIFC_FREEZONE for this run - other selected sources are unaffected.`,
        );
        return;
    }

    // eslint-disable-next-line no-param-reassign
    stats.sourceRowCounts.DIFC_FREEZONE = rows.length;
    const suspectedPrevCount = suspectedFetchFailure(state, 'DIFC_FREEZONE', rows.length);
    if (suspectedPrevCount !== undefined) {
        // Deliberately mirrors the catch block above: return BEFORE incrementing stats.sourcesChecked,
        // touching state.entities, or calling recordSourceChecked, so nothing is wiped/overwritten and
        // every previously-tracked DIFC record remains eligible for correct reclassification the next
        // time this source returns a plausible row count.
        log.error(
            `DIFC_FREEZONE: this run returned only ${rows.length} row(s), down from ${suspectedPrevCount} previously-tracked entities - this looks like a broken or partial fetch, not a real mass deregistration across DIFC's entire register. Skipping DIFC_FREEZONE processing for this run and leaving all previously-tracked records untouched so a future good run can re-evaluate them correctly.`,
        );
        return;
    }

    // eslint-disable-next-line no-param-reassign
    stats.sourcesChecked += 1;
    log.info(`DIFC_FREEZONE: parsing ${rows.length} real company rows.`);

    for (const row of rows) {
        if (stats.stopped) break;
        let entity: NormalizedEntity;
        try {
            entity = normalizeDifcEntity(row);
        } catch (error) {
            log.warning(`Skipping one DIFC_FREEZONE row that could not be normalized: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        await processEntity(entity, 'DIFC_FREEZONE', state, input, scrapedAt, stats);
    }

    if (!stats.stopped) {
        recordSourceChecked(state, 'DIFC_FREEZONE', {
            lastChecked: scrapedAt,
            baselineComplete: true,
        });
    }
}

export async function run(input: ActorInput, state: DeltaState): Promise<RunStats> {
    const scrapedAt = new Date().toISOString();
    const stats: RunStats = {
        totalPushed: 0,
        stopped: false,
        sourcesChecked: 0,
        byEventType: {},
        sourceRowCounts: {},
    };
    const requestedSources = input.dataSources && input.dataSources.length > 0 ? input.dataSources : DEFAULT_DATA_SOURCES;
    const sources = requestedSources.filter((source) => ALL_DATA_SOURCES.includes(source));

    // Snapshot each source's established-baseline flag BEFORE this run touches state.sourceCache,
    // so the zero-records-despite-baseline check below reflects a real track record this run
    // inherited, not one this same (possibly broken) run just created.
    const hadEstablishedBaseline: Partial<Record<DataSourceId, boolean>> = {};
    for (const source of ALL_DATA_SOURCES) {
        hadEstablishedBaseline[source] = state.sourceCache[source]?.baselineComplete === true;
    }

    for (const source of sources) {
        if (stats.stopped) break;
        if (source === 'DUBAI_MAINLAND') {
            await processDubaiMainland(state, input, scrapedAt, stats);
        } else if (source === 'ADGM_FREEZONE') {
            await processAdgm(state, input, scrapedAt, stats);
        } else if (source === 'DIFC_FREEZONE') {
            await processDifc(state, input, scrapedAt, stats);
        }
    }

    if (shouldWarnAllSourcesZeroDespiteBaseline(stats.sourceRowCounts, hadEstablishedBaseline)) {
        const attemptedSources = Object.keys(stats.sourceRowCounts) as DataSourceId[];
        const message = buildZeroRecordsDespiteBaselineMessage(attemptedSources);
        log.error(message);
        await Actor.setStatusMessage(message, { level: 'WARNING' });
    }

    return stats;
}
