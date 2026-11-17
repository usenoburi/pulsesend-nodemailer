import { PulseSendError } from './errors.js';

/** An address as Nodemailer resolves it: a mailbox, or a named group of mailboxes. */
type ResolvedAddress = {
    name?: string;
    address?: string;
    group?: ResolvedAddress[];
};

type ResolvedContent = {
    content?: string | Uint8Array;
    encoding?: string;
    filename?: string | false;
    contentType?: string;
    cid?: string;
    contentDisposition?: string;
};

/** PulseSend options set on a message, next to Nodemailer's own (`transporter.sendMail({ …, pulsesend: {…} })`). */
export interface PulseSendMailOptions {
    /** Labels to find the email later on the dashboard, up to 10. */
    tags?: string[];
    /** Send later: a date at most 30 days ahead. */
    scheduledAt?: Date | string;
    /** Template id (`tpl_…`): its content replaces html and text. */
    template?: string;
    /** Values for the template variables. */
    data?: Record<string, unknown>;
    /** Template version to use instead of the published one. */
    version?: number;
    /** Track opens, overriding the domain setting. */
    trackOpens?: boolean;
    /** Track clicks, overriding the domain setting. */
    trackClicks?: boolean;
    /** Idempotency key: the same key within 24 hours returns the first answer instead of sending again. */
    idempotencyKey?: string;
}

/** The fields of a normalized Nodemailer message that the transport reads. */
export interface NormalizedMail {
    from?: ResolvedAddress | null;
    to?: ResolvedAddress[] | null;
    cc?: ResolvedAddress[] | null;
    bcc?: ResolvedAddress[] | null;
    replyTo?: ResolvedAddress[] | null;
    subject?: string;
    html?: string | ResolvedContent;
    text?: string | ResolvedContent;
    attachments?: ResolvedContent[];
    alternatives?: unknown[];
    icalEvent?: unknown;
    raw?: unknown;
    normalizedHeaders?: Record<string, string>;
    pulsesend?: PulseSendMailOptions;
}

/** Headers PulseSend sets itself; the API refuses them. */
const RESERVED_HEADERS = new Set([
    'from',
    'to',
    'cc',
    'bcc',
    'subject',
    'reply-to',
    'sender',
    'return-path',
    'message-id',
    'date',
    'mime-version',
    'content-type',
    'content-transfer-encoding',
    'content-disposition',
    'dkim-signature',
    'received',
    'x-mailer',
]);

function unsupported(message: string, param: string): PulseSendError {
    return new PulseSendError(message, {
        code: 'unsupported_option',
        type: 'validation_error',
        statusCode: 0,
        param,
    });
}

function mailboxes(list: ResolvedAddress[] | null | undefined): string[] {
    const out: string[] = [];

    for (const entry of list ?? []) {
        if (entry.group) {
            out.push(...mailboxes(entry.group));
        } else if (entry.address) {
            out.push(entry.address);
        }
    }

    return out;
}

function formatFrom(from: ResolvedAddress): string {
    if (!from.address) {
        throw unsupported('The from address is empty.', 'from');
    }

    if (!from.name) {
        return from.address;
    }

    const name = /[",<>@;:]/.test(from.name)
        ? `"${from.name.replace(/(["\\])/g, '\\$1')}"`
        : from.name;

    return `${name} <${from.address}>`;
}

function body(value: string | ResolvedContent | undefined): string | undefined {
    if (value === undefined || typeof value === 'string') {
        return value;
    }

    const content = value.content;

    if (content === undefined) {
        return undefined;
    }

    return typeof content === 'string'
        ? content
        : new TextDecoder().decode(content);
}

function toBase64(attachment: ResolvedContent): string {
    const { content, encoding } = attachment;

    if (content === undefined) {
        return '';
    }

    if (typeof content !== 'string') {
        return Buffer.from(content).toString('base64');
    }

    if (encoding === 'base64') {
        return content.replace(/\s+/g, '');
    }

    return Buffer.from(
        content,
        (encoding as BufferEncoding | undefined) ?? 'utf8',
    ).toString('base64');
}

/** Turns a normalized Nodemailer message into the body of `POST /api/v1/emails`. */
export function buildPayload(mail: NormalizedMail): Record<string, unknown> {
    if (mail.raw) {
        throw unsupported(
            'A raw message cannot go through the PulseSend API: pass from, to, subject and html or text.',
            'raw',
        );
    }

    if (mail.icalEvent) {
        throw unsupported(
            'Calendar events (icalEvent) are not supported by the PulseSend API: attach the .ics file instead.',
            'icalEvent',
        );
    }

    if (mail.alternatives?.length) {
        throw unsupported(
            'Alternatives are not supported by the PulseSend API: send html and text.',
            'alternatives',
        );
    }

    if (!mail.from) {
        throw unsupported('A from address is required.', 'from');
    }

    const payload: Record<string, unknown> = {
        from: formatFrom(mail.from),
        to: mailboxes(mail.to),
    };

    const cc = mailboxes(mail.cc);
    const bcc = mailboxes(mail.bcc);
    const replyTo = mailboxes(mail.replyTo);

    if (cc.length) payload.cc = cc;
    if (bcc.length) payload.bcc = bcc;
    if (replyTo.length) payload.reply_to = replyTo[0];
    if (mail.subject !== undefined) payload.subject = mail.subject;

    const html = body(mail.html);
    const text = body(mail.text);

    if (html !== undefined) payload.html = html;
    if (text !== undefined) payload.text = text;

    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(mail.normalizedHeaders ?? {})) {
        if (!RESERVED_HEADERS.has(key.toLowerCase())) {
            headers[key] = String(value);
        }
    }

    if (Object.keys(headers).length) payload.headers = headers;

    if (mail.attachments?.length) {
        payload.attachments = mail.attachments.map((attachment, i) => {
            if (!attachment.filename) {
                throw unsupported(
                    'Each attachment needs a filename with an extension.',
                    `attachments.${i}.filename`,
                );
            }

            const item: Record<string, unknown> = {
                filename: attachment.filename,
                content: toBase64(attachment),
            };

            if (attachment.contentType)
                item.content_type = attachment.contentType;
            if (attachment.cid) item.content_id = attachment.cid;

            return item;
        });
    }

    const options = mail.pulsesend ?? {};

    if (options.tags?.length) payload.tags = options.tags;
    if (options.scheduledAt !== undefined) {
        payload.scheduled_at =
            options.scheduledAt instanceof Date
                ? options.scheduledAt.toISOString()
                : options.scheduledAt;
    }
    if (options.template !== undefined) payload.template = options.template;
    if (options.data !== undefined) payload.data = options.data;
    if (options.version !== undefined) payload.version = options.version;
    if (options.trackOpens !== undefined)
        payload.track_opens = options.trackOpens;
    if (options.trackClicks !== undefined)
        payload.track_clicks = options.trackClicks;

    return payload;
}
