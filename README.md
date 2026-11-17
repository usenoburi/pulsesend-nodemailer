# @noburi/nodemailer

[Nodemailer](https://nodemailer.com) transport for the [PulseSend](https://pulse-send.jiordiviera.me) transactional email API. Keep your Nodemailer code, send through the API: you get PulseSend ids, tags, scheduling, templates and idempotency, with no SMTP connection to manage.

## Install

```bash
npm install nodemailer @noburi/nodemailer
```

Requires Node 20 or later and Nodemailer 6.9 or later.

## Send an email

```js
import nodemailer from 'nodemailer';
import pulsesend from '@noburi/nodemailer';

const transporter = nodemailer.createTransport(
    pulsesend({ apiKey: process.env.PULSESEND_API_KEY }),
);

const info = await transporter.sendMail({
    from: 'Acme <hello@acme.com>',
    to: 'jane@example.com',
    subject: 'Your login code',
    html: '<p>Your code is <strong>482913</strong></p>',
    text: 'Your code is 482913',
});

console.log(info.messageId); // em_...
```

The `from` address must be on a [verified domain](https://docs.pulse-send.jiordiviera.me/add-a-domain). With a `ps_test_` key nothing is delivered, which is handy in development and tests.

CommonJS works too: `const { PulseSendTransport } = require('@noburi/nodemailer')`, then `nodemailer.createTransport(new PulseSendTransport({ apiKey }))`.

## Options

| Option       | Default                                                        | Role                                                                   |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apiKey`     | `PULSESEND_API_KEY`                                            | `ps_live_…` or `ps_test_…`                                             |
| `baseUrl`    | `PULSESEND_BASE_URL`, then `https://pulse-send.jiordiviera.me` | The transport adds `/api/v1`                                           |
| `timeout`    | `30000`                                                        | Milliseconds before a request is abandoned                             |
| `maxRetries` | `2`                                                            | Retries after a 429 (honoring `Retry-After`), a 5xx or a network error |
| `fetch`      | global `fetch`                                                 | Your own implementation, for tests or a proxy                          |

Every send carries an `Idempotency-Key`, generated when you don't give one, so a retry never sends the email twice.

## PulseSend options

Add a `pulsesend` object to the message:

```js
await transporter.sendMail({
    from: 'Acme <hello@acme.com>',
    to: 'jane@example.com',
    subject: 'Your login code',
    pulsesend: {
        template: 'tpl_01J...', // its content replaces html and text
        data: { code: '482913' }, // template variables
        tags: ['otp', 'signup'],
        scheduledAt: new Date(Date.now() + 3600_000), // up to 30 days ahead
        trackOpens: false,
        trackClicks: false,
        idempotencyKey: `otp-${userId}-${code}`, // same key within 24 h: no second send
    },
});
```

## What is sent

| Nodemailer                                   | PulseSend                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `from`                                       | `from`, with its name                                                                    |
| `to`, `cc`, `bcc`                            | Addresses (display names and groups are flattened to addresses)                          |
| `replyTo`                                    | `reply_to` (the first address)                                                           |
| `subject`, `html`, `text`                    | Same, including content read from a `path` or a stream                                   |
| `attachments`                                | Base64 with `filename` and `content_type`; `cid` becomes `content_id` for inline images  |
| `headers`, `references`, `inReplyTo`, `list` | Custom headers. Headers PulseSend sets itself (`Return-Path`, `Message-ID`…) are dropped |

Refused before any call, because the API can't carry them: `raw`, `icalEvent` (attach the `.ics` file instead) and `alternatives`. An `envelope` option is ignored: recipients come from `to`, `cc` and `bcc`.

## Result and errors

`sendMail` resolves with `messageId` and `id` (the PulseSend id, `em_…`), `status` (`queued` or `scheduled`), `accepted`, `envelope` and `email`, the email as the API returned it. Follow delivery with [webhooks](https://docs.pulse-send.jiordiviera.me/webhooks/introduction).

On failure it rejects with a `PulseSendError`:

```js
import { PulseSendError } from '@noburi/nodemailer';

try {
    await transporter.sendMail(message);
} catch (error) {
    if (error instanceof PulseSendError) {
        error.code; // "domain_not_verified", "rate_limited", "connection_error"…
        error.statusCode; // 422, 429…, 0 when PulseSend was not reached
        error.param; // the field at fault, for a validation error
        error.retryAfter; // seconds, for a 429
        error.requestId; // to quote when asking for help
    }
}
```

The codes are listed in [Errors](https://docs.pulse-send.jiordiviera.me/errors).

## SMTP instead?

PulseSend also has an SMTP relay (`smtp.pulse-send.jiordiviera.me`, ports 587 and 465). Nodemailer's built-in SMTP transport works with it and needs no package; this transport adds PulseSend ids, tags, scheduling, templates and idempotency.

## Develop

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
```

A release: set `version` in `package.json` and `VERSION` in `src/transport.ts`, add the `CHANGELOG.md` entry, then push the tag `vX.Y.Z` on the mirror: `.github/workflows/publish.yml`, the trusted publisher declared on npm, checks the types, tests, builds and publishes with provenance.

## License

MIT
