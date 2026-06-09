# Architecture

## System Overview

The system is split into three runtime processes:

- API: receives Twilio webhooks and serves the admin API.
- Worker: processes inbound messages asynchronously and sends outbound SMS responses.
- Admin: React UI for conversation history and message status.

PostgreSQL is the durable ledger for conversations, messages, and processing jobs. Redis and BullMQ provide operational queueing, retries, backoff, and worker concurrency. Redis pub/sub is also used as a lightweight event bridge from API/worker processes to the admin SSE stream.

## Webhook Timeout

Twilio can time out after 5 seconds while message processing can take 3-15 seconds. The webhook therefore does only the minimum synchronous work:

1. Validate the payload.
2. Persist the conversation, inbound message, and processing job in PostgreSQL.
3. Try to enqueue a BullMQ job.
4. Return `202 Accepted`.

The durable database write happens before the HTTP acknowledgement. If Redis is temporarily unavailable, the job remains in PostgreSQL as `queued`, and the worker requeues pending jobs when Redis is available again.

## Decoupling

Processing is handled by the worker, not the webhook request. The queue payload only contains the inbound message ID. The worker loads the current database state before doing work, which keeps the queue payload small and allows retries to be idempotent.

## Idempotency

Twilio may deliver duplicate webhooks. The database enforces idempotency with unique constraints:

- One inbound message per `twilioMessageSid`.
- One processing job per inbound message.
- One outbound reply per deterministic `idempotencyKey`.

BullMQ jobs use the inbound message ID as the job ID, so duplicate enqueue attempts collapse into the same work item.

## Message Loss Prevention

The source of truth is PostgreSQL, not Redis. A message is considered accepted only after the inbound message and its processing job are committed. The worker periodically requeues durable jobs that are still `queued` or stale `processing`, which covers worker restarts and transient Redis loss. Final failures are retained with `failed` status and error details instead of disappearing.

## Twilio Provider

Outbound delivery is isolated behind `SmsProvider` and implemented by
`TwilioRestSmsProvider`. The provider uses Twilio's Messages API with API Key
credentials or Account SID plus Auth Token credentials, keeps credentials out of
source control, and lets the database own message idempotency before provider
acknowledgement.

The assessment flow uses the purchased Twilio number `+15862044115`. No Twilio
mock is used. Inbound testing is performed through the Twilio webhook endpoint
or through the admin `/test` page, and outbound testing is performed through
`POST /api/messages/send`.

The provider sends `StatusCallback` when `TWILIO_STATUS_CALLBACK_URL` is
configured. Twilio then calls `POST /webhooks/twilio/message-status`, where
provider statuses such as `queued`, `sending`, `sent`, `delivered`,
`undelivered`, and `failed` are mapped back to the system's public status model.

For operator testing, the API also exposes `POST /api/messages/send`, which
creates an outbound message record and sends it through the same Twilio provider.
The admin `/test` page surfaces this endpoint alongside
`POST /webhooks/twilio/sms`, so both sides of the Twilio integration can be
exercised without writing ad hoc curl commands.

## Status Monitoring

BullMQ monitors processing work, not carrier delivery. Its job state answers
whether the worker is waiting, active, retried, completed, or failed. SMS
delivery state is tracked through Twilio status callbacks and persisted in
PostgreSQL by provider `MessageSid`.

The admin does not poll on a fixed interval. It opens `GET /api/events` as a
Server-Sent Events stream. API and worker processes publish
`conversation.changed` to Redis after relevant database mutations. The API
subscribes to that channel and pushes events to connected browsers. The UI then
invalidates the affected TanStack Query caches. The manual refresh button remains
as an operator fallback.

## Data Model

`Conversation` is keyed by the sender and receiver phone numbers. `Message` stores inbound and outbound SMS records with direction, status, timestamps, external provider IDs, and idempotency keys. `ProcessingJob` tracks asynchronous processing attempts and links each job to exactly one inbound message.

Message status is direction-specific. An inbound SMS is successful once it is
durably stored, so its public status remains `received`. The asynchronous work
for that inbound SMS is represented by `ProcessingJob`. The outbound reply is a
separate message whose status starts as `processing` and is finalized to `sent`
or `failed` by Twilio callbacks.

The worker only auto-replies to E.164 phone numbers. Messages from short codes
or alphanumeric sender IDs are stored and the processing job is completed
without creating an outbound reply. This keeps inbound auditability while
avoiding provider failures for non-replyable senders.

PostgreSQL is used because this workload needs transactional writes, strong uniqueness guarantees, and queryable relational history. MongoDB is intentionally not used in v1. It would be reasonable later for high-volume event archives, semi-structured message metadata, or analytics pipelines, but it is not needed for the core transactional path.

## Production Scale

On AWS, the API and worker can run on ECS/Fargate or EKS, PostgreSQL on RDS, and Redis on ElastiCache. Secrets should live in Secrets Manager or SSM Parameter Store. The worker should emit structured logs and metrics for queue latency, processing duration, retry counts, Twilio send failures, and dead-letter volume. A production version should add webhook signature validation, a dead-letter queue, replay tooling, OpenTelemetry tracing, rate limiting, and admin authentication.

## Tradeoffs

BullMQ is fast and operationally simple, but Redis is not the system of record. The durable job table adds a small amount of complexity while making the design safer under Redis outages. SSE is simpler than WebSockets for this admin because updates are server-to-browser only. A manual refresh remains available if the event stream disconnects. The admin UI is intentionally minimal because the assessment values system design and maintainable structure more than visual polish.
