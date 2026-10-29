# SMS2Pay

> Initiate and confirm M-Pesa payments over two-way SMS. The device needs
> cellular signal, while the backend handles the internet connection.

SMS2Pay receives payment instructions through an Africa's Talking SMS
webhook, validates the message, records the request, detects duplicate
payments, and sends a confirmation SMS when Africa's Talking credentials are
configured.

## How it works

```text
Device                    Africa's Talking              SMS2Pay backend
  |                              |                             |
  |-- PAY1-... via SMS -------->|                             |
  |                              |-- HTTP webhook ------------>|
  |                              |                             | validate
  |                              |                             | record
  |                              |<-- RES1-... SMS ------------|
  |<-- confirmation SMS ---------|                             |
```

The current backend acknowledges valid `PAY1` messages and returns an `OK`
reply after requesting an M-Pesa STK Push. For Till payments, the configured
customer phone receives the M-Pesa prompt. The webhook returns immediately
after the STK Push is accepted, then checks the transaction status in the
background every second for up to one minute. The final `OK`, `FL`, or `PD`
result is sent back by SMS. If the provider remains pending after 60 checks,
the backend sends a `PD` (pending timeout) result.

## Current features

- Express server listening on port `4000`
- JSON and `application/x-www-form-urlencoded` request bodies
- `POST /` and `POST /webhook` endpoints
- `PAY1` message validation
- UUID-based duplicate detection
- Persistent audit records in `src/received.json`
- Optional Africa's Talking SMS replies
- M-Pesa STK Push initiation for Till `3018584`
- One-second M-Pesa status polling with `OK`, `FL`, or `PD` SMS results
- Invalid JSON, empty bodies, and invalid payment messages reported explicitly

## Requirements

- Node.js 20.6 or newer
- An Africa's Talking Sandbox application for real SMS callbacks

Node.js 20.6 or newer is required because the start command uses Node's
`--env-file` option.

## Quick start

Install dependencies:

```bash
npm install
```

Configure local environment variables in `.env`:

```env
AT_USERNAME=sandbox
AT_API_KEY=atsk_your_api_key_here
AT_SHORTCODE=66578
# Optional fallback recipient when the webhook does not include `from`
SYSTEM_NUM=0712345678
PORT=4000
```

Never commit `.env`. It is ignored by Git.

Start the server:

```bash
npm start
```

The server will be available at:

```text
http://localhost:4000
```

## Africa's Talking configuration

In the Africa's Talking Sandbox:

1. Open the application that owns shortcode `66578`.
2. Open the incoming SMS callback settings.
3. Set the callback URL to:

   ```text
   https://your-public-host.example/webhook
   ```

4. Save the configuration.

For local development, expose port `4000` through a tunnel such as ngrok, then
use the generated HTTPS URL as the callback URL.

## Payment protocol

### `PAY1` — device to backend

```text
PAY1-<payer>-<amount>-<uuid>
```

Example:

```text
PAY1-0712345678-500-550E8400E29B41D4A7164466
```

Validation rules:

| Field | Rules |
|---|---|
| Type | Must be `PAY1` |
| Payer | Digits only, maximum 12 characters |
| Amount | Digits only, maximum 8 characters |
| UUID | Exactly 24 hexadecimal characters |

### `RES1` — backend to device

For a valid payment, the backend builds:

```text
RES1-<uuid>-OK-<amount>
```

Example:

```text
RES1-550E8400E29B41D4A7164466-OK-500
```

HMAC signing is not enabled in this demo build. Add message authentication
before using this protocol in production.

## API

### `POST /` or `POST /webhook`

Accepts JSON or form-encoded data. The SMS text is read from `text`, then
`message`, then `body`.

Example JSON request:

```bash
curl -X POST http://localhost:4000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "from": "0712345678",
    "to": "66578",
    "text": "PAY1-0712345678-500-550E8400E29B41D4A7164466"
  }'
```

Example form-encoded request:

```bash
curl -X POST http://localhost:4000/webhook \
  -d "from=0712345678" \
  -d "to=66578" \
  -d "text=PAY1-0712345678-500-550E8400E29B41D4A7164466"
```

Successful responses use HTTP `200` and include:

```json
{
  "ok": true,
  "received": {},
  "parsed": {
    "payer": "0712345678",
    "amount": "500",
    "uuid": "550E8400E29B41D4A7164466"
  },
  "reply": {
    "status": "OK",
    "uuid": "550E8400E29B41D4A7164466",
    "amount": "500",
    "text": "RES1-550E8400E29B41D4A7164466-OK-500",
    "duplicate": false,
    "sms_sent": {
      "ok": false,
      "error": "AT_API_KEY or SYSTEM_NUM not configured"
    }
  },
  "record_count": 1
}
```

Response status codes:

| Status | Meaning |
|---:|---|
| `200` | Valid `PAY1` message |
| `400` | Empty body or invalid JSON |
| `422` | Body received, but the payment message is invalid |
| `500` | Unexpected server or storage error |

## Storage

Every request is appended to:

```text
src/received.json
```

Each record contains the timestamp, original payload, parsed payment, and
generated reply. The file and temporary/corrupt variants are ignored by Git.

This JSON file is suitable for a demo or single-process development server.
Use a database and appropriate concurrency controls for production.

## Project layout

```text
sms2pay/
├── src/
│   └── receive.js       # Express server and webhook handler
├── .env                 # Local credentials; not committed
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

## Important production work

Before deploying this beyond a demo:

- Add HMAC signing and verification to `PAY1` messages.
- Replace JSON-file storage with a durable database.
- Move M-Pesa status polling to an asynchronous worker or callback for longer
  transaction windows.
- Add authentication or allow-listing for webhook requests where supported.
- Keep secrets in a managed secret store rather than a local `.env` file.
- Add rate limiting, structured logging, monitoring, and HTTPS.
