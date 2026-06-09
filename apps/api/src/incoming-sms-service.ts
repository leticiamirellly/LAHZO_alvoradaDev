import type { IncomingSmsRecord, SmsRepository } from "@repo/db";

export interface IncomingSmsQueue {
  enqueue(inboundMessageId: string): Promise<string>;
}

export interface ServiceLogger {
  warn(input: unknown, message?: string): void;
}

export type ReceiveIncomingSmsResult = {
  conversationId: string;
  inboundMessageId: string;
  processingJobId: string;
  duplicate: boolean;
  enqueued: boolean;
};

export class IncomingSmsService {
  constructor(
    private readonly repository: Pick<
      SmsRepository,
      "acceptIncomingSms" | "markJobEnqueued"
    >,
    private readonly queue: IncomingSmsQueue,
    private readonly logger: ServiceLogger
  ) {}

  async receive(input: IncomingSmsRecord): Promise<ReceiveIncomingSmsResult> {
    const accepted = await this.repository.acceptIncomingSms(input);
    let enqueued = false;

    try {
      const bullJobId = await this.queue.enqueue(accepted.inboundMessageId);
      await this.repository.markJobEnqueued(
        accepted.processingJobId,
        bullJobId
      );
      enqueued = true;
    } catch (error) {
      this.logger.warn(
        {
          error,
          inboundMessageId: accepted.inboundMessageId,
          processingJobId: accepted.processingJobId
        },
        "incoming_sms_enqueue_failed"
      );
    }

    return {
      ...accepted,
      enqueued
    };
  }
}
