# Conversational SMS System

Full-stack TypeScript implementation of a Twilio-style conversational SMS system. The API accepts inbound SMS webhooks, persists messages durably, queues asynchronous processing, and exposes an admin UI for conversation history.

## Stack

- TypeScript strict mode
- Fastify API
- Prisma + PostgreSQL
- BullMQ + Redis
- Redis pub/sub + Server-Sent Events
- React + Vite + TanStack Query
- Vitest, Supertest, React Testing Library
- Docker Compose for local infrastructure

## Local Setup

```bash
cp .env.example .env
npm install
npm run db:generate
docker compose up -d postgres redis
npm run db:migrate
npm run dev
```

Admin UI: http://localhost:5173  
Twilio test console: http://localhost:5173/test  
API health: http://localhost:3000/health

When running the full Docker Compose stack, the admin and API are exposed on
alternate host ports to avoid conflicts with local development servers:

```bash
npm run docker:up
open http://localhost:5174
open http://localhost:5174/test
curl http://localhost:3001/health
```

Use `npm run docker:down` to stop the stack. `npm run docker:up` wraps
`docker compose up --build --remove-orphans` and cleans up partially started
services if Docker fails while binding a port.

## Test the SMS Flow

This project is not using a Twilio mock. The configured Twilio phone number is:

```text
+15862044115
```

The admin includes a test page at `/test` with forms for both integration
points:

- `POST /webhooks/twilio/sms` for inbound webhook testing.
- `POST /api/messages/send` for direct outbound SMS sends through Twilio.
- `POST /webhooks/twilio/message-status` for Twilio delivery status callbacks.

For direct webhook testing, post a Twilio-shaped payload to the API:

```bash
curl -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "content-type: application/json" \
  -d '{
    "MessageSid": "SM123",
    "From": "+15551234567",
    "To": "+15862044115",
    "Body": "Hello"
  }'
```

The webhook returns `202 Accepted` after the inbound message is persisted. The
worker picks up the job and creates an outbound response after the configured
delay.

## Twilio Delivery

Outbound delivery uses Twilio's Messages API. Set:

```bash
TWILIO_FROM_PHONE="+15862044115"
TWILIO_ACCOUNT_SID="AC..."
TWILIO_AUTH_TOKEN=""
TWILIO_API_KEY_SID="SK..."
TWILIO_API_KEY_SECRET="..."
TWILIO_MESSAGING_SERVICE_SID=""
TWILIO_STATUS_CALLBACK_URL="https://<public-api-host>/webhooks/twilio/message-status"
```

`TWILIO_AUTH_TOKEN` is optional when a valid API Key SID and Secret are present.
When filled, the provider uses Account SID and Auth Token authentication, which
matches the Twilio API Explorer.

`TWILIO_MESSAGING_SERVICE_SID` is optional. When present, outbound messages are
sent through that Messaging Service. Otherwise the worker sends from
`TWILIO_FROM_PHONE`.

`TWILIO_STATUS_CALLBACK_URL` is optional for local-only API testing, but should be
set when exercising the real Twilio flow. Outbound messages are stored as
`processing` after Twilio accepts the send request, then move to `sent` or
`failed` when Twilio calls the status callback.

For local inbound testing with Twilio, expose the API and configure the
`+15862044115` number's Messaging webhook:

```bash
ngrok http 3001
```

```text
POST https://<ngrok-host>/webhooks/twilio/sms
```

Set the callback env var to the same public API host:

```text
TWILIO_STATUS_CALLBACK_URL=https://<ngrok-host>/webhooks/twilio/message-status
```

## API Requirement Coverage

| Requirement | API behavior |
| --- | --- |
| Receives SMS webhook events | `POST /webhooks/twilio/sms` accepts Twilio form payloads and JSON test payloads. |
| Stores conversations and messages | The webhook persists `Conversation`, inbound `Message`, and durable `ProcessingJob` before returning `202 Accepted`. |
| Processes the message | Processing is asynchronous through BullMQ. The API exposes the inbound message's `processingJob.status` as `queued`, `processing`, `completed`, or `failed`. |
| Sends outbound SMS responses | The worker creates an outbound `Message` and sends it through Twilio's Messages API. `POST /api/messages/send` also supports direct outbound test sends. |
| Tracks message status | Inbound messages remain `received`. Outbound messages stay `processing` after Twilio accepts the send request, then `POST /webhooks/twilio/message-status` maps Twilio callbacks to `sent` or `failed`. The admin receives updates via `GET /api/events` SSE instead of fixed polling. |

Inbound messages from non-E.164 senders, such as short codes like `22395`, are
stored and marked received, but the worker does not auto-reply to them. This
avoids failed outbound attempts for OTP providers, banks, Discord-style codes,
and other sender IDs that are not replyable phone numbers.

## Useful Commands

```bash
npm run lint
npm run typecheck
npm test
npm run db:studio
```

## Project Structure

- `apps/api`: webhook and admin API
- `apps/worker`: background message processing
- `apps/admin`: conversation browser
- `packages/contracts`: shared DTOs and validation
- `packages/db`: Prisma schema and repositories
- `packages/events`: Redis pub/sub event bridge for admin SSE updates
- `packages/queue`: BullMQ queue integration
- `packages/twilio`: Twilio provider interface and REST implementation
- `packages/config`: environment parsing

See `ARCHITECTURE.md` for the design rationale and production notes.
