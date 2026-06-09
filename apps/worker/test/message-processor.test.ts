import type { ProcessingItem } from "@repo/db";
import { describe, expect, it, vi } from "vitest";
import {
  DeterministicResponseGenerator,
  processIncomingSmsJob,
  type ProcessingRepository
} from "../src/message-processor.js";

const processingItem: ProcessingItem = {
  inboundMessageId: "message-1",
  conversationId: "conversation-1",
  body: "Hello",
  fromPhone: "+15551234567",
  toPhone: "+15550000000",
  job: {
    id: "job-1",
    status: "queued",
    attempts: 0,
    maxAttempts: 3
  }
};

describe("processIncomingSmsJob", () => {
  it("processes an inbound message and marks the outbound reply sent", async () => {
    const repository = createRepository();
    const smsProvider = {
      sendSms: vi.fn(async () => ({
        providerMessageId: "SM123"
      }))
    };

    const result = await processIncomingSmsJob({
      inboundMessageId: "message-1",
      repository,
      smsProvider,
      responseGenerator: new DeterministicResponseGenerator(),
      waitForProcessing: async () => undefined
    });

    expect(result).toEqual({
      status: "completed",
      outboundMessageId: "outbound-1"
    });
    expect(repository.markJobProcessing).toHaveBeenCalledWith("message-1");
    expect(smsProvider.sendSms).toHaveBeenCalledWith({
      from: "+15550000000",
      to: "+15551234567",
      body: 'Thanks for your message. We received: "Hello"',
      idempotencyKey: "reply:message-1"
    });
    expect(repository.markOutboundReplyAccepted).toHaveBeenCalledWith({
      inboundMessageId: "message-1",
      outboundMessageId: "outbound-1",
      providerMessageId: "SM123"
    });
  });

  it("does not resend an already sent reserved reply", async () => {
    const repository = createRepository({
      reserveOutboundReply: vi.fn(async () => ({
        id: "outbound-1",
        idempotencyKey: "reply:message-1",
        status: "sent",
        created: false
      }))
    });
    const smsProvider = {
      sendSms: vi.fn()
    };

    const result = await processIncomingSmsJob({
      inboundMessageId: "message-1",
      repository,
      smsProvider,
      responseGenerator: new DeterministicResponseGenerator(),
      waitForProcessing: async () => undefined
    });

    expect(result.status).toBe("already_completed");
    expect(smsProvider.sendSms).not.toHaveBeenCalled();
    expect(repository.markJobCompleted).toHaveBeenCalledWith("message-1");
  });

  it("does not create an outbound reply for non-E.164 senders", async () => {
    const repository = createRepository({
      getProcessingItem: vi.fn(async () => ({
        ...processingItem,
        fromPhone: "22395"
      }))
    });
    const smsProvider = {
      sendSms: vi.fn()
    };

    const result = await processIncomingSmsJob({
      inboundMessageId: "message-1",
      repository,
      smsProvider,
      responseGenerator: new DeterministicResponseGenerator(),
      waitForProcessing: async () => undefined
    });

    expect(result).toEqual({
      status: "skipped_non_replyable_sender"
    });
    expect(repository.markJobProcessing).toHaveBeenCalledWith("message-1");
    expect(repository.reserveOutboundReply).not.toHaveBeenCalled();
    expect(smsProvider.sendSms).not.toHaveBeenCalled();
    expect(repository.markJobCompleted).toHaveBeenCalledWith("message-1");
  });

  it("throws on non-final provider failures so BullMQ can retry", async () => {
    const repository = createRepository();
    const smsProvider = {
      sendSms: vi.fn(async () => {
        throw new Error("twilio unavailable");
      })
    };

    await expect(
      processIncomingSmsJob({
        inboundMessageId: "message-1",
        repository,
        smsProvider,
        responseGenerator: new DeterministicResponseGenerator(),
        waitForProcessing: async () => undefined
      })
    ).rejects.toThrow("twilio unavailable");

    expect(repository.markJobFailure).toHaveBeenCalledWith({
      inboundMessageId: "message-1",
      errorMessage: "twilio unavailable",
      final: false
    });
  });

  it("does not publish repeated UI events for retry attempts", async () => {
    const repository = createRepository({
      getProcessingItem: vi.fn(async () => ({
        ...processingItem,
        job: {
          ...processingItem.job,
          attempts: 1
        }
      })),
      reserveOutboundReply: vi.fn(async () => ({
        id: "outbound-1",
        idempotencyKey: "reply:message-1",
        status: "processing",
        created: false
      }))
    });
    const smsProvider = {
      sendSms: vi.fn(async () => {
        throw new Error("twilio unavailable");
      })
    };
    const eventPublisher = {
      publishConversationChanged: vi.fn(async () => undefined)
    };

    await expect(
      processIncomingSmsJob({
        inboundMessageId: "message-1",
        repository,
        smsProvider,
        eventPublisher,
        responseGenerator: new DeterministicResponseGenerator(),
        waitForProcessing: async () => undefined
      })
    ).rejects.toThrow("twilio unavailable");

    expect(eventPublisher.publishConversationChanged).not.toHaveBeenCalled();
  });


  it("marks the job failed on the final attempt", async () => {
    const repository = createRepository({
      getProcessingItem: vi.fn(async () => ({
        ...processingItem,
        job: {
          ...processingItem.job,
          attempts: 2
        }
      }))
    });
    const smsProvider = {
      sendSms: vi.fn(async () => {
        throw new Error("twilio unavailable");
      })
    };

    const result = await processIncomingSmsJob({
      inboundMessageId: "message-1",
      repository,
      smsProvider,
      responseGenerator: new DeterministicResponseGenerator(),
      waitForProcessing: async () => undefined
    });

    expect(result.status).toBe("failed");
    expect(repository.markJobFailure).toHaveBeenCalledWith({
      inboundMessageId: "message-1",
      errorMessage: "twilio unavailable",
      final: true
    });
  });
});

function createRepository(
  overrides: Partial<ProcessingRepository> = {}
): ProcessingRepository {
  return {
    getProcessingItem: vi.fn(async () => processingItem),
    markJobProcessing: vi.fn(async () => undefined),
    reserveOutboundReply: vi.fn(async () => ({
      id: "outbound-1",
      idempotencyKey: "reply:message-1",
      status: "processing",
      created: true
    })),
    markOutboundReplyAccepted: vi.fn(async () => undefined),
    markJobFailure: vi.fn(async () => undefined),
    markJobCompleted: vi.fn(async () => undefined),
    ...overrides
  };
}
