import { describe, expect, it, vi } from "vitest";
import { OutboundSmsService } from "../src/outbound-sms-service.js";

describe("OutboundSmsService", () => {
  it("persists and sends outbound SMS messages", async () => {
    const repository = createRepository();
    const smsProvider = {
      sendSms: vi.fn(async () => ({
        providerMessageId: "SM456"
      }))
    };
    const service = new OutboundSmsService(
      repository,
      smsProvider,
      "+15862044115"
    );

    const result = await service.send({
      to: "+15551234567",
      body: "Manual test",
      idempotencyKey: "manual:test"
    });

    expect(repository.createOutboundMessage).toHaveBeenCalledWith({
      fromPhone: "+15862044115",
      toPhone: "+15551234567",
      body: "Manual test",
      idempotencyKey: "manual:test"
    });
    expect(smsProvider.sendSms).toHaveBeenCalledWith({
      from: "+15862044115",
      to: "+15551234567",
      body: "Manual test",
      idempotencyKey: "manual:test"
    });
    expect(repository.markOutboundMessageAccepted).toHaveBeenCalledWith({
      outboundMessageId: "message-2",
      providerMessageId: "SM456"
    });
    expect(result).toEqual({
      status: "processing",
      conversationId: "conversation-1",
      outboundMessageId: "message-2",
      providerMessageId: "SM456",
      error: null
    });
  });

  it("marks outbound SMS messages failed when Twilio rejects delivery", async () => {
    const repository = createRepository();
    const smsProvider = {
      sendSms: vi.fn(async () => {
        throw new Error("Twilio send failed with 400");
      })
    };
    const service = new OutboundSmsService(
      repository,
      smsProvider,
      "+15862044115"
    );

    const result = await service.send({
      to: "+15551234567",
      body: "Manual test",
      idempotencyKey: "manual:test"
    });

    expect(repository.markOutboundMessageFailed).toHaveBeenCalledWith(
      "message-2"
    );
    expect(result).toMatchObject({
      status: "failed",
      conversationId: "conversation-1",
      outboundMessageId: "message-2",
      providerMessageId: null,
      error: "Twilio send failed with 400"
    });
  });
});

function createRepository() {
  return {
    createOutboundMessage: vi.fn(async () => ({
      conversationId: "conversation-1",
      outboundMessageId: "message-2",
      idempotencyKey: "manual:test"
    })),
    markOutboundMessageAccepted: vi.fn(async () => undefined),
    markOutboundMessageFailed: vi.fn(async () => undefined)
  };
}
