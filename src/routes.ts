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
        log.warning(
            `Could not download or parse Dubai Pulse mainland data: ${error instanceof Error ? error.message : String(error)}. Skipping DUBAI_MAINLAND for this run - other selected sources are unaffected.`,
        );
        return;
    }

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
        log.warning(
            `Could not download or parse ADGM_FREEZONE data: ${error instanceof Error ? error.message : String(error)}. Skipping ADGM_FREEZONE for this run - other selected sources are unaffected.`,
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
        log.warning(
            `Could not download or parse DIFC_FREEZONE data: ${error instanceof Error ? error.message : String(error)}. Skipping DIFC_FREEZONE for this run - other selected sources are unaffected.`,
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
    };
    const requestedSources = input.dataSources && input.dataSources.length > 0 ? input.dataSources : DEFAULT_DATA_SOURCES;
    const sources = requestedSources.filter((source) => ALL_DATA_SOURCES.includes(source));

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

    return stats;
}
