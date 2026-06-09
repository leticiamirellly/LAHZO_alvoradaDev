import type { ProcessingItem, SmsRepository } from "@repo/db";
import type { SmsEventPublisher } from "@repo/events";
import type { SmsProvider } from "@repo/twilio";

export type ProcessingRepository = Pick<
  SmsRepository,
  | "getProcessingItem"
  | "markJobProcessing"
  | "reserveOutboundReply"
  | "markOutboundReplyAccepted"
  | "markJobFailure"
  | "markJobCompleted"
>;

export interface ResponseGenerator {
  createReply(item: ProcessingItem): string;
}

export type ProcessIncomingSmsJobInput = {
  inboundMessageId: string;
  repository: ProcessingRepository;
  smsProvider: SmsProvider;
  eventPublisher?: Pick<SmsEventPublisher, "publishConversationChanged">;
  responseGenerator: ResponseGenerator;
  waitForProcessing: () => Promise<void>;
};

export type ProcessIncomingSmsJobResult =
  | { status: "completed"; outboundMessageId: string }
  | { status: "already_completed" }
  | { status: "skipped_non_replyable_sender" }
  | { status: "failed" }
  | { status: "not_found" };

export class DeterministicResponseGenerator implements ResponseGenerator {
  createReply(item: ProcessingItem): string {
    const normalized = item.body.trim().replace(/\s+/g, " ");
    const preview =
      normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;

    if (!preview) {
      return "Thanks for your message. We received it and will follow up shortly.";
    }

    return `Thanks for your message. We received: "${preview}"`;
  }
}

export function createRandomProcessingDelay(minMs: number, maxMs: number) {
  return async () => {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await new Promise((resolve) => setTimeout(resolve, delay));
  };
}

export async function processIncomingSmsJob(
  input: ProcessIncomingSmsJobInput
): Promise<ProcessIncomingSmsJobResult> {
  const item = await input.repository.getProcessingItem(input.inboundMessageId);

  if (!item) {
    return {
      status: "not_found"
    };
  }

  if (item.job.status === "completed") {
    return {
      status: "already_completed"
    };
  }

  try {
    await input.repository.markJobProcessing(item.inboundMessageId);
    if (item.job.attempts === 0) {
      await publishConversationChanged(input, item.conversationId);
    }
    await input.waitForProcessing();

    if (!isReplyablePhoneNumber(item.fromPhone)) {
      await input.repository.markJobCompleted(item.inboundMessageId);
      await publishConversationChanged(input, item.conversationId);

      return {
        status: "skipped_non_replyable_sender"
      };
    }

    const replyBody = input.responseGenerator.createReply(item);
    const reservedReply = await input.repository.reserveOutboundReply({
      inboundMessageId: item.inboundMessageId,
      body: replyBody
    });

    if (reservedReply.created) {
      await publishConversationChanged(input, item.conversationId);
    }

    if (reservedReply.status === "sent") {
      await input.repository.markJobCompleted(item.inboundMessageId);
      await publishConversationChanged(input, item.conversationId);

      return {
        status: "already_completed"
      };
    }

    const sendResult = await input.smsProvider.sendSms({
      from: item.toPhone,
      to: item.fromPhone,
      body: replyBody,
      idempotencyKey: reservedReply.idempotencyKey
    });

    await input.repository.markOutboundReplyAccepted({
      inboundMessageId: item.inboundMessageId,
      outboundMessageId: reservedReply.id,
      providerMessageId: sendResult.providerMessageId
    });
    await publishConversationChanged(input, item.conversationId);

    return {
      status: "completed",
      outboundMessageId: reservedReply.id
    };
  } catch (error) {
    const final = item.job.attempts + 1 >= item.job.maxAttempts;

    await input.repository.markJobFailure({
      inboundMessageId: item.inboundMessageId,
      errorMessage: getErrorMessage(error),
      final
    });

    if (final) {
      await publishConversationChanged(input, item.conversationId);
    }

    if (!final) {
      throw error;
    }

    return {
      status: "failed"
    };
  }
}

async function publishConversationChanged(
  input: ProcessIncomingSmsJobInput,
  conversationId: string
) {
  try {
    await input.eventPublisher?.publishConversationChanged(conversationId);
  } catch {
    return undefined;
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isReplyablePhoneNumber(value: string) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}
