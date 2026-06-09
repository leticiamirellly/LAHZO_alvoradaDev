import { JobStatus, MessageStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaSmsRepository } from "../src/index.js";

describe("PrismaSmsRepository status transitions", () => {
  it("does not change inbound message status when processing starts", async () => {
    const prisma = {
      processingJob: {
        update: vi.fn(async () => undefined)
      }
    };
    const repository = new PrismaSmsRepository(prisma as never);

    await repository.markJobProcessing("inbound-1");

    expect(prisma.processingJob.update).toHaveBeenCalledWith({
      where: {
        inboundMessageId: "inbound-1"
      },
      data: {
        status: JobStatus.PROCESSING,
        attempts: {
          increment: 1
        },
        lastError: null
      }
    });
  });

  it("keeps inbound received when the outbound reply is accepted by Twilio", async () => {
    const tx = createTransaction();
    const repository = createRepository(tx);

    await repository.markOutboundReplyAccepted({
      inboundMessageId: "inbound-1",
      outboundMessageId: "outbound-1",
      providerMessageId: "SM123"
    });

    expect(tx.message.update).toHaveBeenNthCalledWith(1, {
      where: {
        id: "outbound-1"
      },
      data: {
        status: MessageStatus.PROCESSING,
        providerMessageId: "SM123",
        sentAt: null,
        failedAt: null
      }
    });
    expect(tx.message.update).toHaveBeenNthCalledWith(2, {
      where: {
        id: "inbound-1"
      },
      data: {
        status: MessageStatus.RECEIVED,
        sentAt: null,
        failedAt: null
      }
    });
  });

  it("keeps inbound received when the outbound reply fails finally", async () => {
    const tx = createTransaction();
    const repository = createRepository(tx);

    await repository.markJobFailure({
      inboundMessageId: "inbound-1",
      errorMessage: "twilio rejected message",
      final: true
    });

    expect(tx.message.update).toHaveBeenCalledWith({
      where: {
        id: "inbound-1"
      },
      data: {
        status: MessageStatus.RECEIVED,
        failedAt: null
      }
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "reply:inbound-1",
        status: MessageStatus.PROCESSING
      },
      data: {
        status: MessageStatus.FAILED,
        failedAt: expect.any(Date)
      }
    });
  });

  it("keeps outbound processing when a retry is still pending", async () => {
    const tx = createTransaction();
    const repository = createRepository(tx);

    await repository.markJobFailure({
      inboundMessageId: "inbound-1",
      errorMessage: "twilio temporarily unavailable",
      final: false
    });

    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "reply:inbound-1",
        status: MessageStatus.PROCESSING
      },
      data: {
        status: MessageStatus.PROCESSING,
        failedAt: null
      }
    });
  });

  it("updates outbound status from Twilio callbacks", async () => {
    const prisma = {
      message: {
        findFirst: vi.fn(async () => ({
          id: "outbound-1",
          conversationId: "conversation-1",
          status: MessageStatus.PROCESSING
        })),
        update: vi.fn(async () => undefined)
      }
    };
    const repository = new PrismaSmsRepository(prisma as never);

    const result = await repository.updateOutboundMessageStatus({
      providerMessageId: "SM123",
      status: "sent"
    });

    expect(prisma.message.update).toHaveBeenCalledWith({
      where: {
        id: "outbound-1"
      },
      data: {
        status: MessageStatus.SENT,
        sentAt: expect.any(Date),
        failedAt: null
      }
    });
    expect(result).toMatchObject({
      conversationId: "conversation-1",
      outboundMessageId: "outbound-1",
      status: "sent",
      changed: true
    });
  });

  it("does not downgrade terminal outbound status to processing", async () => {
    const prisma = {
      message: {
        findFirst: vi.fn(async () => ({
          id: "outbound-1",
          conversationId: "conversation-1",
          status: MessageStatus.SENT
        })),
        update: vi.fn(async () => undefined)
      }
    };
    const repository = new PrismaSmsRepository(prisma as never);

    const result = await repository.updateOutboundMessageStatus({
      providerMessageId: "SM123",
      status: "processing"
    });

    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      conversationId: "conversation-1",
      outboundMessageId: "outbound-1",
      status: "sent",
      changed: false
    });
  });
});

function createTransaction() {
  return {
    message: {
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => undefined)
    },
    processingJob: {
      update: vi.fn(async () => undefined)
    }
  };
}

function createRepository(tx: ReturnType<typeof createTransaction>) {
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx))
  };

  return new PrismaSmsRepository(prisma as never);
}
