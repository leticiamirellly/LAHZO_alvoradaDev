import { describe, expect, it, vi } from "vitest";
import { IncomingSmsService } from "../src/incoming-sms-service.js";

const acceptedMessage = {
  conversationId: "conversation-1",
  inboundMessageId: "message-1",
  processingJobId: "job-1",
  duplicate: false
};

describe("IncomingSmsService", () => {
  it("persists the inbound message and records the BullMQ job id", async () => {
    const repository = {
      acceptIncomingSms: vi.fn(async () => acceptedMessage),
      markJobEnqueued: vi.fn(async () => undefined)
    };
    const queue = {
      enqueue: vi.fn(async () => "bull-job-1")
    };
    const service = new IncomingSmsService(repository, queue, logger());

    const result = await service.receive({
      twilioMessageSid: "SM123",
      fromPhone: "+15551234567",
      toPhone: "+15550000000",
      body: "Hello"
    });

    expect(result).toEqual({
      ...acceptedMessage,
      enqueued: true
    });
    expect(repository.markJobEnqueued).toHaveBeenCalledWith(
      "job-1",
      "bull-job-1"
    );
  });

  it("keeps the message accepted when Redis enqueue fails", async () => {
    const repository = {
      acceptIncomingSms: vi.fn(async () => acceptedMessage),
      markJobEnqueued: vi.fn(async () => undefined)
    };
    const queue = {
      enqueue: vi.fn(async () => {
        throw new Error("redis unavailable");
      })
    };
    const service = new IncomingSmsService(repository, queue, logger());

    const result = await service.receive({
      twilioMessageSid: "SM123",
      fromPhone: "+15551234567",
      toPhone: "+15550000000",
      body: "Hello"
    });

    expect(result.enqueued).toBe(false);
    expect(repository.markJobEnqueued).not.toHaveBeenCalled();
  });
});

function logger() {
  return {
    warn: vi.fn()
  };
}
