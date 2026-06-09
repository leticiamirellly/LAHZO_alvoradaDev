# Conversational SMS System

A full-stack TypeScript SMS conversation system. The API receives Twilio webhooks, stores messages in PostgreSQL, processes replies outside the HTTP request with BullMQ and Redis, sends outbound SMS through Twilio, and updates the admin UI in real time with SSE.

## Stack

- TypeScript in strict mode
- Fastify API
- Prisma + PostgreSQL
- BullMQ + Redis
- Redis pub/sub + Server-Sent Events
- React + Vite + TanStack Query
- Vitest, Supertest, and React Testing Library
- Docker Compose for local and EC2 infrastructure

## Test URLs

- Public web app: `https://lahzo-sms-admin.<cloudflare-subdomain>.workers.dev`
- Local web app: `http://localhost:5174`
- Local test console: `http://localhost:5174/test`
- Local API with Docker: `http://localhost:3001/health`
- EC2 API: `http://34.226.94.43/health`
- Twilio phone number used in the flow: `+15862044115`

Set `VITE_API_BASE_URL` in Cloudflare to the public API URL before deploying the frontend.

## Local Setup

```bash
cp .env.example .env
npm install
npm run db:generate
npm run docker:up
```

Open the admin at:

```text
http://localhost:5174
```

Use the test console at:

```text
http://localhost:5174/test
```

Stop the stack:

```bash
npm run docker:down
```

## SMS Flow

The project includes two test paths:

- `POST /webhooks/twilio/sms` receives inbound SMS payloads in Twilio format.
- `POST /api/messages/send` sends outbound SMS directly through the API.
- `POST /webhooks/twilio/message-status` receives Twilio delivery status callbacks.

Inbound webhook example:

```bash
curl -X POST http://localhost:3001/webhooks/twilio/sms \
  -H "content-type: application/json" \
  -d '{
    "MessageSid": "SM123",
    "From": "+15551234567",
    "To": "+15862044115",
    "Body": "Hello"
  }'
```

The API returns `202 Accepted` after the inbound message is persisted. The worker processes the message later, with a configurable delay between 3 and 15 seconds.

## Current Infrastructure

The infrastructure is intentionally simple for the assessment.

The admin runs on Cloudflare as Worker Static Assets. The Vite build creates `apps/admin/dist`, and Wrangler publishes the static files with SPA fallback.

The API runs on one EC2 instance with Docker Compose. The same instance runs:

- `api`
- `worker`
- `postgres`
- `redis`

Only the API is exposed over HTTP on port `80`. PostgreSQL and Redis are bound to localhost and should not be opened in the Security Group.

Important EC2 environment variables:

```env
API_HOST_PORT=80
TWILIO_STATUS_CALLBACK_URL=https://api.<domain>/webhooks/twilio/message-status
```

In Cloudflare, point `api.<domain>` to the EC2 Elastic IP and keep the proxy enabled. Since this version does not use Nginx, Caddy, or Tunnel, SSL mode needs to be `Flexible`.

## Production Notes

For a real production setup, PostgreSQL and Redis should not live on the same EC2 instance as the API.

A production deployment should use:

- API and worker on ECS/Fargate or EKS
- PostgreSQL on RDS
- Redis on ElastiCache
- secrets in Secrets Manager or SSM Parameter Store
- TLS with `Full strict`
- Twilio webhook signature validation
- structured logs, metrics, tracing, and DLQ
- admin authentication

The current version stays smaller to show the full flow with clear boundaries, idempotency, queueing, persistence, and real Twilio integration.

## Useful Commands

```bash
npm run lint
npm run typecheck
npm test
npm run db:studio
```

## Structure

- `apps/api`: webhook and admin API
- `apps/worker`: asynchronous processing
- `apps/admin`: conversation UI and test console
- `packages/contracts`: shared DTOs and validation
- `packages/db`: Prisma schema and repositories
- `packages/events`: Redis pub/sub bridge for SSE
- `packages/queue`: BullMQ integration
- `packages/twilio`: Twilio provider
- `packages/config`: environment parsing

See `ARCHITECTURE.md` for technical decisions and tradeoffs.
