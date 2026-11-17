/**
 * Error raised when PulseSend refuses a message or cannot be reached. Nodemailer hands it to
 * the sendMail callback or rejects the promise with it.
 */
export class PulseSendError extends Error {
    /** Error code from the API, such as `validation_error` or `domain_not_verified`. */
    readonly code: string;
    /** Error type from the API (`validation_error`, `rate_limit_error`…), `connection_error` when the API was not reached. */
    readonly type: string;
    /** HTTP status, or 0 when the API was not reached. */
    readonly statusCode: number;
    /** Same as statusCode, under the name Nodemailer's SMTP errors use. */
    readonly responseCode: number;
    /** The request field at fault, for a validation error. */
    readonly param: string | null;
    /** Page of the documentation about this error. */
    readonly docUrl: string | null;
    /** Value of the X-Request-Id header, to quote when asking for help. */
    readonly requestId: string | null;
    /** Seconds to wait before retrying, for a 429. */
    readonly retryAfter: number | null;

    constructor(
        message: string,
        details: {
            code: string;
            type: string;
            statusCode: number;
            param?: string | null;
            docUrl?: string | null;
            requestId?: string | null;
            retryAfter?: number | null;
            cause?: unknown;
        },
    ) {
        super(message, { cause: details.cause });
        this.name = 'PulseSendError';
        this.code = details.code;
        this.type = details.type;
        this.statusCode = details.statusCode;
        this.responseCode = details.statusCode;
        this.param = details.param ?? null;
        this.docUrl = details.docUrl ?? null;
        this.requestId = details.requestId ?? null;
        this.retryAfter = details.retryAfter ?? null;
    }
}
