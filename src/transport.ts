import { randomUUID } from 'node:crypto';

import { PulseSendError } from './errors.js';
import { buildPayload } from './payload.js';
import type { NormalizedMail } from './payload.js';

export const VERSION = '0.1.1';

const DEFAULT_BASE_URL = 'https://pulse-send.jiordiviera.me';

export interface PulseSendTransportOptions {
    /** API key, `ps_live_…` or `ps_test_…`. Defaults to the PULSESEND_API_KEY environment variable. */
    apiKey?: string;
    /** Defaults to PULSESEND_BASE_URL, then https://pulse-send.jiordiviera.me. The transport adds /api/v1. */
    baseUrl?: string;
    /** Milliseconds before a request is abandoned. Default 30 000. */
    timeout?: number;
    /** Retries after a 429, a 5xx or a network error. Default 2. Every send carries an idempotency key, so a retry never sends twice. */
    maxRetries?: number;
    /** fetch implementation, for tests or a proxy. Defaults to the global fetch. */
    fetch?: typeof fetch;
}

/** What sendMail resolves with. */
export interface PulseSendSentMessageInfo {
    /** PulseSend id of the email (`em_…`). */
    messageId: string;
    /** Same as messageId. */
    id: string;
    /** Status of the email right after the call: `queued`, or `scheduled`. */
    status: string;
    envelope: { from: string | false; to: string[] };
    accepted: string[];
    rejected: string[];
    response: string;
    /** The email as the API returned it. */
    email: Record<string, unknown>;
}

/** The part of Nodemailer's MailMessage the transport uses. */
interface MailMessageLike {
    data: { envelope?: unknown };
    message: { getEnvelope(): { from: string | false; to: string[] } };
    normalize(
        callback: (err: Error | null, data?: NormalizedMail) => void,
    ): void;
}

type ApiErrorBody = {
    error?: {
        type?: string;
        code?: string;
        message?: string;
        param?: string | null;
        doc_url?: string | null;
    };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Nodemailer transport that sends through the PulseSend API.
 *
 * ```ts
 * const transporter = nodemailer.createTransport(new PulseSendTransport({ apiKey: process.env.PULSESEND_API_KEY }));
 * ```
 */
export class PulseSendTransport {
    readonly name = 'PulseSend';
    readonly version = VERSION;

    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly timeout: number;
    private readonly maxRetries: number;
    private readonly fetchImpl: typeof fetch;

    constructor(options: PulseSendTransportOptions = {}) {
        const apiKey = options.apiKey ?? process.env.PULSESEND_API_KEY;

        if (!apiKey) {
            throw new Error(
                'PulseSend: pass an apiKey or set the PULSESEND_API_KEY environment variable.',
            );
        }

        this.apiKey = apiKey;
        this.baseUrl = (
            options.baseUrl ??
            process.env.PULSESEND_BASE_URL ??
            DEFAULT_BASE_URL
        ).replace(/\/+$/, '');
        this.timeout = options.timeout ?? 30_000;
        this.maxRetries = Math.max(0, options.maxRetries ?? 2);
        this.fetchImpl = options.fetch ?? globalThis.fetch;
    }

    send(
        mail: MailMessageLike,
        callback: (err: Error | null, info?: PulseSendSentMessageInfo) => void,
    ): void {
        const envelope = mail.message.getEnvelope();

        mail.normalize((err, data) => {
            if (err || !data) {
                callback(
                    err ??
                        new Error('PulseSend: the message could not be read.'),
                );

                return;
            }

            let payload: Record<string, unknown>;

            try {
                payload = buildPayload(data);
            } catch (error) {
                callback(error as Error);

                return;
            }

            const idempotencyKey =
                data.pulsesend?.idempotencyKey ?? randomUUID();

            this.post(payload, idempotencyKey).then(
                (email) => {
                    const id = String(email.id);

                    callback(null, {
                        messageId: id,
                        id,
                        status: String(email.status),
                        envelope,
                        accepted: envelope.to,
                        rejected: [],
                        response: `202 Accepted ${id}`,
                        email,
                    });
                },
                (error: Error) => callback(error),
            );
        });
    }

    private async post(
        payload: Record<string, unknown>,
        idempotencyKey: string,
    ): Promise<Record<string, unknown>> {
        for (let attempt = 0; ; attempt++) {
            let response: Response;

            try {
                response = await this.fetchImpl(
                    `${this.baseUrl}/api/v1/emails`,
                    {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                            Accept: 'application/json',
                            'Idempotency-Key': idempotencyKey,
                            'User-Agent': `pulsesend-nodemailer/${VERSION}`,
                        },
                        body: JSON.stringify(payload),
                        signal: AbortSignal.timeout(this.timeout),
                    },
                );
            } catch (cause) {
                if (attempt < this.maxRetries) {
                    await sleep(this.backoff(attempt));
                    continue;
                }

                throw new PulseSendError(
                    `PulseSend could not be reached: ${(cause as Error).message}`,
                    {
                        code: 'connection_error',
                        type: 'connection_error',
                        statusCode: 0,
                        cause,
                    },
                );
            }

            const retryAfter =
                Number(response.headers.get('retry-after')) || null;

            if (
                (response.status === 429 || response.status >= 500) &&
                attempt < this.maxRetries
            ) {
                await sleep(
                    retryAfter !== null
                        ? retryAfter * 1000
                        : this.backoff(attempt),
                );
                continue;
            }

            const body = (await response.json().catch(() => ({}))) as Record<
                string,
                unknown
            > &
                ApiErrorBody;

            if (response.ok) {
                return body;
            }

            const error = body.error ?? {};

            throw new PulseSendError(
                error.message ?? `PulseSend answered ${response.status}.`,
                {
                    code: error.code ?? 'api_error',
                    type: error.type ?? 'api_error',
                    statusCode: response.status,
                    param: error.param ?? null,
                    docUrl: error.doc_url ?? null,
                    requestId: response.headers.get('x-request-id'),
                    retryAfter,
                },
            );
        }
    }

    private backoff(attempt: number): number {
        return Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
    }
}
