/**
 * Three independently-verified data sources feed this actor - see AGENTS.md section 0 for
 * the live verification record. Each has a genuinely different wire protocol and field vocabulary,
 * so raw row shapes are kept separate per source and mapped into the shared `NormalizedEntity`
 * envelope by deltaEngine.ts's per-source normalize functions.
 */
export type DataSourceId = 'DUBAI_MAINLAND' | 'ADGM_FREEZONE' | 'DIFC_FREEZONE';

/** Thrown by a data-source fetcher for a failure that retrying would never fix (a non-retryable HTTP status, a rejected/failed application-level response, or an unrecognized response shape) - distinguishes "give up immediately" from "retry with backoff" without sniffing error message text. */
export class NonRetryableFetchError extends Error {}

export const ALL_DATA_SOURCES: DataSourceId[] = ['DUBAI_MAINLAND', 'ADGM_FREEZONE', 'DIFC_FREEZONE'];

/** The single, federally-recognized Dubai Pulse dataset for DED (mainland Dubai) trade licenses - schema confirmed from the dataset's own published column documentation, NOT from a live-fetched row (see AGENTS.md section 0.2: dubaipulse.gov.ae rejected every direct connection attempted in this development environment). Field names/order match the archived dataset page exactly. */
export interface DubaiLicenseRow {
    license_number: string;
    initial_approval_number: string | null;
    commerce_register_serial_number: string | null;
    chamber_of_commerce_number: string | null;
    trade_name_serial_number: string | null;
    issue_date: string | null;
    expiry_date: string | null;
    cancel_date: string | null;
    license_status_code: string | null;
    license_status_desc_ar: string | null;
    license_status_desc_en: string | null;
    license_category_code: string | null;
    license_category_desc_ar: string | null;
    license_category_desc_en: string | null;
    issue_authority_code: string | null;
    issue_authority_desc_ar: string | null;
    issue_authority_desc_en: string | null;
}

/** The companion Dubai Pulse dataset carrying bilingual trade names, joined to DubaiLicenseRow by license_number. */
export interface DubaiTradeNameRow {
    trade_name_serial: string;
    trade_name_ar: string | null;
    trade_name_en: string | null;
    license_number: string;
}

/**
 * ADGM's public register, live-verified via its real guest-accessible (aura.token=null) Salesforce
 * Aura RPC endpoint (RASearchUtil.getSearchResponseForPR) - see AGENTS.md section 0.3. Field
 * names are the exact `Account`-object API names observed in a real response this session.
 */
export interface AdgmEntityRow {
    Id: string;
    Name: string;
    Entity_Type__c: string | null;
    Is_continued__c: boolean;
    Incorporation_Date__c: string | null;
    Registration_Number__c: string;
    Entity_Status__c: string | null;
    Category__c: string | null;
    Entity_Sub_Type__c: string | null;
    License_Status__c: string | null;
    Addresses__r: { Full_Address__c?: string; Address_for_DDP__c?: string }[] | null;
    Trade_Names__r: { Name_in_English__c: string; Status__c: string }[] | null;
}

/**
 * DIFC's public register, live-verified via its real anonymous Next.js API proxy
 * (`POST /api/handleRequest`, `slug: "/CRM/public-register"`) - see AGENTS.md section 0.4.
 * Field names are the exact API field names observed in a real response this session.
 * `Type_for_PR__c` (present on every real row) is deliberately left unmodeled/unread here - observed always `null` on real live data as of 2026-09-19, and its actual significance is unconfirmed, so it is intentionally omitted rather than guessed at.
 */
export interface DifcCompanyRow {
    Id: string;
    Name: string;
    ROC_Status__c: string | null;
    Registration_License_No__c: string;
    Legal_Type_of_Entity__c: string | null;
    Legal_Entity_Type__c: string | null;
    ROC_reg_incorp_Date__c: string | null;
    License_Activity_Details__c: string | null;
    Nature_of_business__c: string | null;
    Registered_Address__c: string | null;
    Company_Type__c: string | null;
    Website: string | null;
}

/**
 * The unified shape every source's raw rows are normalized into before the delta engine sees them.
 * Officer/manager/beneficial-owner data is deliberately NOT modeled here - none of the three
 * verified public sources expose officer-level detail in their list/search views (only entity-level
 * status, name, activity and address fields). The original mandate's "officer/manager updates"
 * detection target was corrected out for this reason; see AGENTS.md section 3.
 */
export interface NormalizedEntity {
    dataSource: DataSourceId;
    recordId: string;
    sourceSpecificId: string;
    commercialNameEn: string;
    commercialNameEnNormalized: string;
    commercialNameAr: string | null;
    commercialNameArNormalized: string | null;
    legalForm: string | null;
    registrationStatus: string | null;
    licenseStatus: string | null;
    /** The primary registered trade name's own status (e.g. ADGM's Trade_Names__r[0].Status__c: "Active"/"Inactive") - distinct from the entity-level registrationStatus/licenseStatus. Only ADGM's real captured response exposes this as a separate field; null for sources with no equivalent concept. Found missing entirely by adversarial review - previously silently dropped, making a real trade-name status change invisible to the delta engine. */
    tradeNameStatus: string | null;
    activities: string[];
    issueDate: string | null;
    expiryDate: string | null;
    cancelDate: string | null;
    registeredAddress: string | null;
    freeZone: boolean;
}

export type EventType = 'BASELINE_SNAPSHOT' | 'NEW_ENTITY' | 'STATUS_CHANGED' | 'ENTITY_UPDATED' | 'ENTITY_UNCHANGED';

export interface StoredFingerprint {
    statusFingerprint: string;
    contentFingerprint: string;
    registrationStatus: string | null;
    licenseStatus: string | null;
    tradeNameStatus: string | null;
    lastSeen: string;
}

export interface SourceCacheEntry {
    lastChecked: string;
    baselineComplete: boolean;
}

export interface DeltaState {
    entities: Record<string, StoredFingerprint>;
    sourceCache: Partial<Record<DataSourceId, SourceCacheEntry>>;
}

export interface ClassifiedEvent {
    entity: NormalizedEntity;
    eventType: EventType;
    statusFingerprint: string;
    contentFingerprint: string;
    previousRegistrationStatus: string | null;
    previousLicenseStatus: string | null;
    previousTradeNameStatus: string | null;
}

export interface ActorInput {
    dataSources?: DataSourceId[];
    onlyNew?: boolean;
    maxItems?: number;
    resetState?: boolean;
    deltaStateName?: string;
    webhookUrl?: string;
    slackWebhookUrl?: string;
    teamsWebhookUrl?: string;
    dubaiPulseApiKey?: string;
}

export interface OutputRecord {
    '@type': 'schema:Corporation';
    event_id: string;
    event_type: EventType;
    record_id: string;
    data_source: DataSourceId;
    free_zone: boolean;
    commercial_name_en: string;
    commercial_name_ar: string | null;
    legal_form: string | null;
    registration_status: string | null;
    license_status: string | null;
    trade_name_status: string | null;
    previous_registration_status: string | null;
    previous_license_status: string | null;
    previous_trade_name_status: string | null;
    activities: string[];
    issue_date: string | null;
    expiry_date: string | null;
    cancel_date: string | null;
    registered_address: string | null;
    status_fingerprint: string;
    content_fingerprint: string;
    is_new: boolean;
    scraped_at: string;
}

export const DEFAULT_DATA_SOURCES: DataSourceId[] = ['ADGM_FREEZONE', 'DIFC_FREEZONE'];
