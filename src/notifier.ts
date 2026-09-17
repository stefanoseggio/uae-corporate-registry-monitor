import { log } from 'apify';

import type { EventType, OutputRecord } from './types.js';

/**
 * Registry fields (commercial names, addresses, activities) are self-reported/government-published
 * free text, not vetted or escaped by the upstream source - not trusted input. Same real finding as
 * Actor #2's notifier.ts: interpolating them unescaped into Slack `mrkdwn` or a Teams Adaptive
 * Card's markdown subset lets a crafted field inject live formatting (Slack's `<!channel>`/`<!here>`
 * mention syntax, or a markdown link/emphasis breakout).
 */
function escapeSlackMrkdwn(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAdaptiveCardText(value: string): string {
    return value.replace(/[[\]()*_~`\\]/g, (char) => `\\${char}`);
}

/** Maps an event type to a visual accent color, shared across Slack (attachment bar color) and Teams (Adaptive Card container style) - the mandate's explicit "status change visual accents" requirement. STATUS_CHANGED itself is not always good or bad (e.g. a fresh license moving from "Under Processing" to "Active" is positive; "Active" to "Cancelled" is not) - since this actor cannot reliably interpret the semantic direction of an arbitrary free-text status string across three different source vocabularies without fabricating an enum, the accent below signals "this is the highest-attention event type" (STATUS_CHANGED, in red/attention) versus "informational" (everything else), rather than claiming to know whether the change is good or bad news. */
function accentForEventType(eventType: EventType): {
    slackHex: string;
    teamsStyle: 'attention' | 'good' | 'default';
} {
    switch (eventType) {
        case 'STATUS_CHANGED':
            return { slackHex: '#D93F3F', teamsStyle: 'attention' };
        case 'NEW_ENTITY':
        case 'BASELINE_SNAPSHOT':
            return { slackHex: '#2EB67D', teamsStyle: 'good' };
        default:
            return { slackHex: '#ECB22E', teamsStyle: 'default' };
    }
}

function summaryLine(record: OutputRecord): string {
    const statusText =
        record.event_type === 'STATUS_CHANGED' ? `${record.previous_registration_status ?? 'unknown'} -> ${record.registration_status ?? 'unknown'}` : (record.registration_status ?? 'status unknown');
    return `[UAE Corporate Registry - ${record.data_source}] ${record.event_type}: ${record.commercial_name_en} - ${statusText}`;
}

/**
 * A Slack-specific summary line - NOT the shared summaryLine() above. Found by adversarial review:
 * an earlier version reused summaryLine() for Slack's top-level `text` field, which is rendered
 * with mrkdwn by default, while every other Slack-bound field in this file is escaped via
 * escapeSlackMrkdwn - a commercial_name_en containing Slack's `<!channel>` special-mention syntax
 * would have fired a real channel-wide ping. The generic webhook's summaryLine() output is plain
 * JSON, not rendered as mrkdwn, so escaping it there would be incorrect (it would show a literal
 * "&amp;" to a consumer expecting the raw name) - hence a separate, Slack-only function rather
 * than escaping the shared one.
 */
function slackSummaryLine(record: OutputRecord): string {
    const statusText =
        record.event_type === 'STATUS_CHANGED'
            ? `${escapeSlackMrkdwn(record.previous_registration_status ?? 'unknown')} -> ${escapeSlackMrkdwn(record.registration_status ?? 'unknown')}`
            : escapeSlackMrkdwn(record.registration_status ?? 'status unknown');
    return `[UAE Corporate Registry - ${escapeSlackMrkdwn(record.data_source)}] ${record.event_type}: ${escapeSlackMrkdwn(record.commercial_name_en)} - ${statusText}`;
}

async function postJson(url: string, body: unknown, channelLabel: string): Promise<void> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            log.warning(`${channelLabel} notification failed with status ${response.status} - continuing (channel delivery is best-effort, not run-blocking).`);
        }
    } catch (error) {
        log.warning(`${channelLabel} notification threw an error - continuing: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function sendGenericWebhook(url: string, record: OutputRecord): Promise<void> {
    return postJson(url, { text: summaryLine(record), record }, 'Generic webhook');
}

/** Slack Block Kit via a current Slack App's Incoming Webhook, with a legacy `attachments[].color` bar for the status-change visual accent - Block Kit's `blocks` and the older `attachments.color` field are documented to compose together in one payload, so this is not a deprecated-format regression. */
async function sendSlackNotification(url: string, record: OutputRecord): Promise<void> {
    const accent = accentForEventType(record.event_type);
    const nameLine = record.commercial_name_ar
        ? `*${escapeSlackMrkdwn(record.commercial_name_en)}* (${escapeSlackMrkdwn(record.commercial_name_ar)})`
        : `*${escapeSlackMrkdwn(record.commercial_name_en)}*`;
    const transitionText =
        record.event_type === 'STATUS_CHANGED'
            ? `:rotating_light: Status changed: ${escapeSlackMrkdwn(record.previous_registration_status ?? 'unknown')} → ${escapeSlackMrkdwn(record.registration_status ?? 'unknown')}`
            : `Status: ${escapeSlackMrkdwn(record.registration_status ?? 'unknown')}`;
    const payload = {
        text: slackSummaryLine(record),
        attachments: [
            {
                color: accent.slackHex,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*${record.event_type}* · ${escapeSlackMrkdwn(record.data_source)}\n${nameLine}`,
                        },
                    },
                    { type: 'section', text: { type: 'mrkdwn', text: transitionText } },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: `Legal form: ${escapeSlackMrkdwn(record.legal_form ?? 'not published')} · Record: ${escapeSlackMrkdwn(record.record_id)}`,
                            },
                        ],
                    },
                ],
            },
        ],
    };
    return postJson(url, payload, 'Slack');
}

/**
 * Microsoft Teams via a "Workflows" webhook URL (not the retired classic connector - same finding
 * as Actor #2/#3), posting an Adaptive Card whose body `Container.style` carries the status-change
 * visual accent.
 */
async function sendTeamsNotification(url: string, record: OutputRecord): Promise<void> {
    const accent = accentForEventType(record.event_type);
    const nameEn = escapeAdaptiveCardText(record.commercial_name_en);
    const nameAr = record.commercial_name_ar ? escapeAdaptiveCardText(record.commercial_name_ar) : null;
    const facts = [
        { title: 'Data source', value: escapeAdaptiveCardText(record.data_source) },
        {
            title: 'Registration status',
            value: escapeAdaptiveCardText(record.registration_status ?? 'unknown'),
        },
        ...(record.event_type === 'STATUS_CHANGED'
            ? [
                  {
                      title: 'Previous status',
                      value: escapeAdaptiveCardText(record.previous_registration_status ?? 'unknown'),
                  },
              ]
            : []),
        {
            title: 'Legal form',
            value: escapeAdaptiveCardText(record.legal_form ?? 'not published'),
        },
        { title: 'Record ID', value: escapeAdaptiveCardText(record.record_id) },
    ];
    const payload = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'Container',
                            style: accent.teamsStyle,
                            items: [
                                {
                                    type: 'TextBlock',
                                    text: `${record.event_type}: ${nameEn}`,
                                    weight: 'Bolder',
                                    size: 'Medium',
                                    wrap: true,
                                },
                                ...(nameAr
                                    ? [
                                          {
                                              type: 'TextBlock',
                                              text: nameAr,
                                              isSubtle: true,
                                              wrap: true,
                                          },
                                      ]
                                    : []),
                            ],
                        },
                        { type: 'FactSet', facts },
                    ],
                },
            },
        ],
    };
    return postJson(url, payload, 'Microsoft Teams');
}

export interface NotifierChannels {
    webhookUrl?: string;
    slackWebhookUrl?: string;
    teamsWebhookUrl?: string;
}

export async function notifyAllChannels(channels: NotifierChannels, record: OutputRecord): Promise<void> {
    const sends: Promise<void>[] = [];
    if (channels.webhookUrl) sends.push(sendGenericWebhook(channels.webhookUrl, record));
    if (channels.slackWebhookUrl) sends.push(sendSlackNotification(channels.slackWebhookUrl, record));
    if (channels.teamsWebhookUrl) sends.push(sendTeamsNotification(channels.teamsWebhookUrl, record));
    await Promise.allSettled(sends);
}
