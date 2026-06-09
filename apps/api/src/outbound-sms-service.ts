import { randomUUID } from "node:crypto";
import type { SendOutboundSmsResponse } from "@repo/contracts";
import type { SmsRepository } from "@repo/db";
import type { SmsProvider } from "@repo/twilio";

export type OutboundSmsRepository = Pick<
  SmsRepository,
  | "createOutboundMessage"
  | "markOutboundMessageAccepted"
  | "markOutboundMessageFailed"
>;

export type OutboundSmsServiceInput = {
  to: string;
  body: string;
  idempotencyKey?: string | undefined;
};

export class OutboundSmsService {
  constructor(
    private readonly repository: OutboundSmsRepository,
    private readonly smsProvider: SmsProvider,
    private readonly fromPhone: string
  ) {}

  async send(input: OutboundSmsServiceInput): Promise<SendOutboundSmsResponse> {
    const idempotencyKey = input.idempotencyKey ?? `manual:${randomUUID()}`;
    const message = await this.repository.createOutboundMessage({
      fromPhone: this.fromPhone,
      toPhone: input.to,
      body: input.body,
      idempotencyKey
    });

    try {
      const result = await this.smsProvider.sendSms({
        from: this.fromPhone,
        to: input.to,
        body: input.body,
        idempotencyKey
      });

      await this.repository.markOutboundMessageAccepted({
        outboundMessageId: message.outboundMessageId,
        providerMessageId: result.providerMessageId
      });

      return {
        status: "processing",
        conversationId: message.conversationId,
        outboundMessageId: message.outboundMessageId,
        providerMessageId: result.providerMessageId,
        error: null
      };
    } catch (error) {
      await this.repository.markOutboundMessageFailed(message.outboundMessageId);

      return {
        status: "failed",
        conversationId: message.conversationId,
        outboundMessageId: message.outboundMessageId,
        providerMessageId: null,
        error: getErrorMessage(error)
      };
    }
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
