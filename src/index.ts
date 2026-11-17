import { PulseSendTransport } from './transport.js';
import type { PulseSendTransportOptions } from './transport.js';

export { PulseSendTransport, VERSION } from './transport.js';
export type {
    PulseSendSentMessageInfo,
    PulseSendTransportOptions,
} from './transport.js';
export { PulseSendError } from './errors.js';
export type { PulseSendMailOptions } from './payload.js';

/** Shortcut for `new PulseSendTransport(options)`: `nodemailer.createTransport(pulsesend({ apiKey }))`. */
export default function pulsesend(
    options?: PulseSendTransportOptions,
): PulseSendTransport {
    return new PulseSendTransport(options);
}
