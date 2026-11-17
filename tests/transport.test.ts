import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import { describe, expect, it } from 'vitest';

import pulsesend, { PulseSendError, PulseSendTransport } from '../src/index.js';

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeFetch(
    responses: Array<
        | { status: number; body?: unknown; headers?: Record<string, string> }
        | Error
    >,
) {
    const calls: Call[] = [];

    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: String(url),
            init: init ?? {},
            body: JSON.parse(String(init?.body ?? '{}')),
        });
        const next = responses.shift() ?? {
            status: 202,
            body: { id: 'em_default', status: 'queued' },
        };

        if (next instanceof Error) {
            throw next;
        }

        return new Response(JSON.stringify(next.body ?? {}), {
            status: next.status,
            headers: { 'Content-Type': 'application/json', ...next.headers },
        });
    }) as typeof fetch;

    return { impl, calls };
}

function transporter(
    responses: Parameters<typeof fakeFetch>[0] = [],
    maxRetries = 2,
) {
    const fake = fakeFetch(responses);
    const transport = new PulseSendTransport({
        apiKey: 'ps_test_123',
        baseUrl: 'https://api.example.test/',
        fetch: fake.impl,
        maxRetries,
    });

    return { mailer: nodemailer.createTransport(transport), calls: fake.calls };
}

describe('PulseSendTransport', () => {
    it('sends a message as one API call', async () => {
        const { mailer, calls } = transporter([
            { status: 202, body: { id: 'em_01abc', status: 'queued' } },
        ]);

        const info = await mailer.sendMail({
            from: '"Acme, Inc." <hello@acme.com>',
            to: 'Jane <jane@example.com>, tom@example.com',
            cc: ['ops@acme.com'],
            bcc: { name: 'Audit', address: 'audit@acme.com' },
            replyTo: 'support@acme.com',
            subject: 'Your code',
            html: '<p>482913</p>',
            text: '482913',
        });

        expect(calls).toHaveLength(1);
        const call = calls[0]!;
        expect(call.url).toBe('https://api.example.test/api/v1/emails');
        const headers = call.init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer ps_test_123');
        expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
        expect(headers['User-Agent']).toMatch(/^pulsesend-nodemailer\//);
        expect(call.body).toEqual({
            from: '"Acme, Inc." <hello@acme.com>',
            to: ['jane@example.com', 'tom@example.com'],
            cc: ['ops@acme.com'],
            bcc: ['audit@acme.com'],
            reply_to: 'support@acme.com',
            subject: 'Your code',
            html: '<p>482913</p>',
            text: '482913',
        });
        expect(info.messageId).toBe('em_01abc');
        expect(info.status).toBe('queued');
        expect(info.accepted).toEqual([
            'jane@example.com',
            'tom@example.com',
            'ops@acme.com',
            'audit@acme.com',
        ]);
    });

    it('sends attachments in base64, inline images with their content id', async () => {
        const { mailer, calls } = transporter();

        await mailer.sendMail({
            from: 'hello@acme.com',
            to: 'jane@example.com',
            subject: 'Receipt',
            html: '<img src="cid:logo">',
            attachments: [
                { filename: 'receipt.txt', content: 'Total: 12 USD' },
                {
                    filename: 'logo.png',
                    content: Buffer.from([137, 80, 78, 71]),
                    cid: 'logo',
                },
                {
                    filename: 'note.txt',
                    content: 'aGVsbG8=',
                    encoding: 'base64',
                },
            ],
        });

        expect(calls[0]!.body.attachments).toEqual([
            {
                filename: 'receipt.txt',
                content: Buffer.from('Total: 12 USD').toString('base64'),
                content_type: 'text/plain',
            },
            {
                filename: 'logo.png',
                content: 'iVBORw==',
                content_type: 'image/png',
                content_id: 'logo',
            },
            {
                filename: 'note.txt',
                content: 'aGVsbG8=',
                content_type: 'text/plain',
            },
        ]);
    });

    it('passes custom headers and PulseSend options, drops the headers PulseSend sets', async () => {
        const { mailer, calls } = transporter();

        await mailer.sendMail({
            from: 'hello@acme.com',
            to: 'jane@example.com',
            subject: 'Hi',
            text: 'Hi',
            headers: {
                'X-Entity-Ref-ID': 'order-8812',
                'Return-Path': 'nope@acme.com',
            },
            pulsesend: {
                tags: ['otp'],
                scheduledAt: new Date('2026-11-20T09:00:00Z'),
                template: 'tpl_01',
                data: { code: '482913' },
                trackClicks: false,
                idempotencyKey: 'otp-42',
            },
        } as SendMailOptions);

        const call = calls[0]!;
        expect(
            (call.init.headers as Record<string, string>)['Idempotency-Key'],
        ).toBe('otp-42');
        expect(call.body.headers).toEqual({ 'X-Entity-Ref-ID': 'order-8812' });
        expect(call.body).toMatchObject({
            tags: ['otp'],
            scheduled_at: '2026-11-20T09:00:00.000Z',
            template: 'tpl_01',
            data: { code: '482913' },
            track_clicks: false,
        });
    });

    it('turns an API error into a PulseSendError', async () => {
        const { mailer } = transporter([
            {
                status: 422,
                headers: { 'X-Request-Id': 'req_1' },
                body: {
                    error: {
                        type: 'validation_error',
                        code: 'domain_not_verified',
                        message: 'acme.com is not verified.',
                        param: 'from',
                        doc_url:
                            'https://docs.pulse-send.jiordiviera.me/errors',
                    },
                },
            },
        ]);

        const error = await mailer
            .sendMail({
                from: 'hello@acme.com',
                to: 'jane@example.com',
                subject: 'Hi',
                text: 'Hi',
            })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(PulseSendError);
        expect(error).toMatchObject({
            code: 'domain_not_verified',
            type: 'validation_error',
            statusCode: 422,
            responseCode: 422,
            param: 'from',
            requestId: 'req_1',
            message: 'acme.com is not verified.',
        });
    });

    it('retries a 5xx and a network error with the same idempotency key', async () => {
        const { mailer, calls } = transporter([
            {
                status: 503,
                body: {
                    error: {
                        type: 'api_error',
                        code: 'unavailable',
                        message: 'Down',
                    },
                },
            },
            new TypeError('fetch failed'),
            { status: 202, body: { id: 'em_ok', status: 'queued' } },
        ]);

        const info = await mailer.sendMail({
            from: 'hello@acme.com',
            to: 'jane@example.com',
            subject: 'Hi',
            text: 'Hi',
        });

        expect(info.messageId).toBe('em_ok');
        expect(calls).toHaveLength(3);
        const keys = calls.map(
            (c) =>
                (c.init.headers as Record<string, string>)['Idempotency-Key'],
        );
        expect(new Set(keys).size).toBe(1);
    });

    it('does not retry a 4xx', async () => {
        const { mailer, calls } = transporter([
            {
                status: 401,
                body: {
                    error: {
                        type: 'authentication_error',
                        code: 'invalid_api_key',
                        message: 'Bad key',
                    },
                },
            },
        ]);

        await expect(
            mailer.sendMail({
                from: 'a@acme.com',
                to: 'b@example.com',
                text: 'x',
            }),
        ).rejects.toThrow('Bad key');
        expect(calls).toHaveLength(1);
    });

    it('reports a connection error once retries run out', async () => {
        const { mailer, calls } = transporter(
            [new TypeError('fetch failed')],
            0,
        );

        await expect(
            mailer.sendMail({
                from: 'a@acme.com',
                to: 'b@example.com',
                text: 'x',
            }),
        ).rejects.toMatchObject({
            code: 'connection_error',
            statusCode: 0,
        });
        expect(calls).toHaveLength(1);
    });

    it('refuses what the API cannot carry, before any call', async () => {
        const { mailer, calls } = transporter();

        await expect(
            mailer.sendMail({
                from: 'a@acme.com',
                to: 'b@example.com',
                text: 'x',
                icalEvent: { content: 'BEGIN:VCALENDAR' },
            }),
        ).rejects.toMatchObject({
            code: 'unsupported_option',
            param: 'icalEvent',
        });
        await expect(
            mailer.sendMail({ raw: 'From: a@acme.com\r\n\r\nx' }),
        ).rejects.toMatchObject({ param: 'raw' });
        expect(calls).toHaveLength(0);
    });

    it('reads the key from the environment, and the default export builds the transport', () => {
        process.env.PULSESEND_API_KEY = 'ps_test_env';
        expect(pulsesend()).toBeInstanceOf(PulseSendTransport);
        delete process.env.PULSESEND_API_KEY;
        expect(() => new PulseSendTransport()).toThrow(/apiKey/);
    });
});
