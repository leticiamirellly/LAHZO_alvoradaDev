import cors from "@fastify/cors";
import formBody from "@fastify/formbody";
import {
  sendOutboundSmsRequestSchema,
  twilioMessageStatusCallbackSchema,
  twilioSmsWebhookSchema
} from "@repo/contracts";
import type { SmsRepository } from "@repo/db";
import type { SmsEventPublisher, SmsEventSubscriber } from "@repo/events";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { IncomingSmsService } from "./incoming-sms-service.js";
import type { OutboundSmsService } from "./outbound-sms-service.js";

const conversationParamsSchema = z.object({
  id: z.string().min(1)
});

export type ApiServerDependencies = {
  repository: Pick<
    SmsRepository,
    | "listConversations"
    | "getConversationMessages"
    | "updateOutboundMessageStatus"
  >;
  incomingSmsService: IncomingSmsService;
  outboundSmsService: OutboundSmsService;
  eventPublisher?: Pick<SmsEventPublisher, "publishConversationChanged">;
  eventSubscriber?: Pick<SmsEventSubscriber, "subscribe">;
};

export function createApiServer(
  dependencies: ApiServerDependencies,
  options: { logger?: boolean } = {}
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true
  });

  void app.register(cors, {
    origin: true
  });
  void app.register(formBody);

  app.get("/health", async () => ({
    ok: true
  }));

  app.post("/webhooks/twilio/sms", async (request, reply) => {
    const payload = twilioSmsWebhookSchema.safeParse(
      normalizeRequestBody(request.body)
    );

    if (!payload.success) {
      return reply.code(400).send({
        error: "invalid_twilio_payload",
        details: payload.error.flatten()
      });
    }

    const result = await dependencies.incomingSmsService.receive({
      twilioMessageSid: payload.data.MessageSid,
      fromPhone: payload.data.From,
      toPhone: payload.data.To,
      body: payload.data.Body
    });
    await publishConversationChanged(result.conversationId);

    return reply.code(202).send({
      accepted: true,
      duplicate: result.duplicate,
      enqueued: result.enqueued,
      conversationId: result.conversationId,
      inboundMessageId: result.inboundMessageId
    });
  });

  app.get("/api/conversations", async () => {
    const conversations = await dependencies.repository.listConversations();

    return {
      conversations
    };
  });

  app.post("/api/messages/send", async (request, reply) => {
    const payload = sendOutboundSmsRequestSchema.safeParse(request.body);

    if (!payload.success) {
      return reply.code(400).send({
        error: "invalid_send_sms_payload",
        details: payload.error.flatten()
      });
    }

    const result = await dependencies.outboundSmsService.send(payload.data);
    await publishConversationChanged(result.conversationId);

    return reply.code(result.status === "failed" ? 502 : 202).send(result);
  });

  app.post("/webhooks/twilio/message-status", async (request, reply) => {
    const payload = twilioMessageStatusCallbackSchema.safeParse(
      normalizeRequestBody(request.body)
    );

    if (!payload.success) {
      return reply.code(400).send({
        error: "invalid_twilio_status_payload",
        details: payload.error.flatten()
      });
    }

    const status = mapTwilioMessageStatus(
      payload.data.MessageStatus ?? payload.data.SmsStatus
    );

    if (!status) {
      return reply.code(202).send({
        accepted: true,
        updated: false,
        ignored: true
      });
    }

    const updated = await dependencies.repository.updateOutboundMessageStatus({
      providerMessageId: payload.data.MessageSid,
      status
    });

    if (updated?.changed) {
      await publishConversationChanged(updated.conversationId);
    }

    return reply.code(202).send({
      accepted: true,
      updated: Boolean(updated?.changed),
      conversationId: updated?.conversationId ?? null,
      outboundMessageId: updated?.outboundMessageId ?? null,
      status
    });
  });

  app.get("/api/events", async (request, reply) => {
    if (!dependencies.eventSubscriber) {
      return reply.code(503).send({
        error: "event_stream_unavailable"
      });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": getCorsOrigin(request.headers.origin),
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(
      `event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`
    );

    const unsubscribe = await dependencies.eventSubscriber.subscribe((event) => {
      reply.raw.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      );
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 25_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/conversations/:id/messages", async (request, reply) => {
    const params = conversationParamsSchema.parse(request.params);
    const conversation = await dependencies.repository.getConversationMessages(
      params.id
    );

    if (!conversation) {
      return reply.code(404).send({
        error: "conversation_not_found"
      });
    }

    return conversation;
  });

  async function publishConversationChanged(conversationId: string | null) {
    try {
      await dependencies.eventPublisher?.publishConversationChanged(conversationId);
    } catch (error) {
      app.log.warn({ error, conversationId }, "sms_event_publish_failed");
    }
  }

  return app;
}

function normalizeRequestBody(body: unknown) {
  if (body && typeof body === "object") {
    return body;
  }

  return {};
}

function getCorsOrigin(origin: unknown) {
  return typeof origin === "string" && origin.length > 0 ? origin : "*";
}

function mapTwilioMessageStatus(status: string | undefined) {
  switch (status?.toLowerCase()) {
    case "accepted":
    case "queued":
    case "scheduled":
    case "sending":
      return "processing";
    case "sent":
    case "delivered":
      return "sent";
    case "canceled":
    case "failed":
    case "undelivered":
      return "failed";
    default:
      return null;
  }
}
