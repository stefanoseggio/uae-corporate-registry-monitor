import { afterEach, describe, expect, it, vi } from 'vitest';

import { notifyAllChannels } from '../src/notifier.js';
import type { OutputRecord } from '../src/types.js';

function sampleRecord(overrides: Partial<OutputRecord> = {}): OutputRecord {
    return {
        '@type': 'schema:Corporation',
        event_id: 'abc123',
        event_type: 'STATUS_CHANGED',
        record_id: 'ADGM_FREEZONE::22086',
        data_source: 'ADGM_FREEZONE',
        free_zone: true,
        commercial_name_en: 'Acme Trading LLC',
        commercial_name_ar: null,
        legal_form: 'Private Company Limited By Shares',
        registration_status: 'Deregistered',
        license_status: 'License cancelled',
        trade_name_status: null,
        previous_registration_status: 'Registered',
        previous_license_status: 'Licensed',
        previous_trade_name_status: null,
        activities: ['Holding Company'],
        issue_date: '2024-11-07',
        expiry_date: null,
        cancel_date: null,
        registered_address: 'Al Sarab Tower, ADGM Square, Abu Dhabi',
        status_fingerprint: 'status-fp',
        content_fingerprint: 'content-fp',
        is_new: false,
        scraped_at: '2026-09-16T12:00:00.000Z',
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('notifyAllChannels', () => {
    it('sends nothing when no channels are configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({}, sampleRecord());
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts a generic JSON payload with a text summary and the full record when webhookUrl is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ webhookUrl: 'https://example.com/hook' }, sampleRecord());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        const body = JSON.parse(options.body);
        expect(body.record.event_type).toBe('STATUS_CHANGED');
        expect(body.text).toContain('Acme Trading LLC');
    });

    it('fires all three channels in parallel when all are configured', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ webhookUrl: 'https://example.com/hook', slackWebhookUrl: 'https://hooks.slack.example/x', teamsWebhookUrl: 'https://teams.example/workflow' }, sampleRecord());
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('escapes Slack mrkdwn special characters in the commercial name to prevent a mention-injection payload', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/x' }, sampleRecord({ commercial_name_en: '<!channel> Evil Corp & Co <script>' }));
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        const nameBlockText = body.attachments[0].blocks[0].text.text;
        expect(nameBlockText).not.toContain('<!channel>');
        expect(nameBlockText).toContain('&lt;!channel&gt;');
        expect(nameBlockText).toContain('&amp;');
    });

    it('includes a red/attention accent color on Slack for a STATUS_CHANGED event', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/x' }, sampleRecord({ event_type: 'STATUS_CHANGED' }));
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.attachments[0].color).toBe('#D93F3F');
    });

    it('includes a green/good accent color on Slack for a NEW_ENTITY event', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/x' }, sampleRecord({ event_type: 'NEW_ENTITY' }));
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.attachments[0].color).toBe('#2EB67D');
    });

    it('shows the previous-status transition text on Slack for a STATUS_CHANGED event', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { slackWebhookUrl: 'https://hooks.slack.example/x' },
            sampleRecord({ event_type: 'STATUS_CHANGED', previous_registration_status: 'Registered', registration_status: 'Deregistered' }),
        );
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        const transitionText = body.attachments[0].blocks[1].text.text;
        expect(transitionText).toContain('Registered');
        expect(transitionText).toContain('Deregistered');
    });

    it('includes both the English and Arabic commercial names in the Slack message when an Arabic name is present', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/x' }, sampleRecord({ commercial_name_en: 'Test Trading LLC', commercial_name_ar: 'شركة الاختبار' }));
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        const nameBlockText = body.attachments[0].blocks[0].text.text;
        expect(nameBlockText).toContain('Test Trading LLC');
        expect(nameBlockText).toContain('شركة الاختبار');
    });

    it('escapes Adaptive Card markdown special characters in the Teams payload', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ teamsWebhookUrl: 'https://teams.example/workflow' }, sampleRecord({ commercial_name_en: '[Click here](javascript:alert(1)) *Corp*' }));
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        const titleText = body.attachments[0].content.body[0].items[0].text;
        expect(titleText).not.toContain('[Click here](javascript:alert(1))');
        expect(titleText).toContain('\\[Click here\\]');
    });

    it('uses the "attention" Adaptive Card container style for STATUS_CHANGED and "good" for NEW_ENTITY', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await notifyAllChannels({ teamsWebhookUrl: 'https://teams.example/workflow' }, sampleRecord({ event_type: 'STATUS_CHANGED' }));
        const statusChangedBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(statusChangedBody.attachments[0].content.body[0].style).toBe('attention');

        fetchMock.mockClear();
        await notifyAllChannels({ teamsWebhookUrl: 'https://teams.example/workflow' }, sampleRecord({ event_type: 'NEW_ENTITY' }));
        const newEntityBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(newEntityBody.attachments[0].content.body[0].style).toBe('good');
    });

    it('includes a "Previous status" fact on Teams only for STATUS_CHANGED, not for other event types', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await notifyAllChannels({ teamsWebhookUrl: 'https://teams.example/workflow' }, sampleRecord({ event_type: 'STATUS_CHANGED' }));
        const statusChangedFacts = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content.body[1].facts;
        expect(statusChangedFacts.some((fact: { title: string }) => fact.title === 'Previous status')).toBe(true);

        fetchMock.mockClear();
        await notifyAllChannels({ teamsWebhookUrl: 'https://teams.example/workflow' }, sampleRecord({ event_type: 'NEW_ENTITY' }));
        const newEntityFacts = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content.body[1].facts;
        expect(newEntityFacts.some((fact: { title: string }) => fact.title === 'Previous status')).toBe(false);
    });

    it('never throws when a channel returns a non-ok HTTP status - delivery is best-effort', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
        vi.stubGlobal('fetch', fetchMock);
        await expect(notifyAllChannels({ webhookUrl: 'https://example.com/hook' }, sampleRecord())).resolves.toBeUndefined();
    });

    it('never throws when a channel fetch itself rejects - one broken channel must not block the others', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
        vi.stubGlobal('fetch', fetchMock);
        await expect(notifyAllChannels({ webhookUrl: 'https://example.com/hook', slackWebhookUrl: 'https://hooks.slack.example/x' }, sampleRecord())).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
