import {
  JobStatus,
  MessageDirection,
  MessageStatus,
  PrismaClient,
  type Prisma
} from "@prisma/client";
import type {
  ConversationListItem,
  ConversationMessagesResponse,
  MessageDto,
  MessageProcessingJob,
  ProcessingJobStatus
} from "@repo/contracts";

export { PrismaClient };

export type IncomingSmsRecord = {
  twilioMessageSid: string;
  fromPhone: string;
  toPhone: string;
  body: string;
};

export type AcceptedIncomingMessage = {
  conversationId: string;
  inboundMessageId: string;
  processingJobId: string;
  duplicate: boolean;
};

export type ProcessingItem = {
  inboundMessageId: string;
  conversationId: string;
  body: string;
  fromPhone: string;
  toPhone: string;
  job: {
    id: string;
    status: ProcessingJobStatus;
    attempts: number;
    maxAttempts: number;
  };
};

export type ReservedOutboundReply = {
  id: string;
  idempotencyKey: string;
  status: "processing" | "sent";
  created: boolean;
};

export type CreatedOutboundMessage = {
  conversationId: string;
  outboundMessageId: string;
  idempotencyKey: string;
};

export type OutboundDeliveryStatus = "processing" | "sent" | "failed";

export type UpdatedOutboundMessageStatus = {
  conversationId: string;
  outboundMessageId: string;
  status: OutboundDeliveryStatus;
  changed: boolean;
};

export type JobsNeedingEnqueue = Array<{
  processingJobId: string;
  inboundMessageId: string;
}>;

export interface SmsRepository {
  acceptIncomingSms(input: IncomingSmsRecord): Promise<AcceptedIncomingMessage>;
  markJobEnqueued(processingJobId: string, bullJobId: string): Promise<void>;
  listConversations(): Promise<ConversationListItem[]>;
  getConversationMessages(
    conversationId: string
  ): Promise<ConversationMessagesResponse | null>;
  getProcessingItem(inboundMessageId: string): Promise<ProcessingItem | null>;
  markJobProcessing(inboundMessageId: string): Promise<void>;
  reserveOutboundReply(input: {
    inboundMessageId: string;
    body: string;
  }): Promise<ReservedOutboundReply>;
  createOutboundMessage(input: {
    fromPhone: string;
    toPhone: string;
    body: string;
    idempotencyKey: string;
  }): Promise<CreatedOutboundMessage>;
  markOutboundMessageAccepted(input: {
    outboundMessageId: string;
    providerMessageId: string;
  }): Promise<void>;
  markOutboundMessageFailed(outboundMessageId: string): Promise<void>;
  markOutboundReplyAccepted(input: {
    inboundMessageId: string;
    outboundMessageId: string;
    providerMessageId: string;
  }): Promise<void>;
  updateOutboundMessageStatus(input: {
    providerMessageId: string;
    status: OutboundDeliveryStatus;
  }): Promise<UpdatedOutboundMessageStatus | null>;
  markJobFailure(input: {
    inboundMessageId: string;
    errorMessage: string;
    final: boolean;
  }): Promise<void>;
  markJobCompleted(inboundMessageId: string): Promise<void>;
  findJobsNeedingEnqueue(input: {
    limit: number;
    staleProcessingBefore: Date;
  }): Promise<JobsNeedingEnqueue>;
}

type PrismaTransaction = Prisma.TransactionClient;

export class PrismaSmsRepository implements SmsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async acceptIncomingSms(
    input: IncomingSmsRecord
  ): Promise<AcceptedIncomingMessage> {
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.upsert({
        where: {
          fromPhone_toPhone: {
            fromPhone: input.fromPhone,
            toPhone: input.toPhone
          }
        },
        update: {
          updatedAt: new Date()
        },
        create: {
          fromPhone: input.fromPhone,
          toPhone: input.toPhone
        }
      });

      const existingMessage = await tx.message.findUnique({
        where: {
          twilioMessageSid: input.twilioMessageSid
        },
        include: {
          jobs: true
        }
      });

      if (existingMessage) {
        const job = await tx.processingJob.upsert({
          where: {
            inboundMessageId: existingMessage.id
          },
          update: {},
          create: {
            inboundMessageId: existingMessage.id
          }
        });

        return {
          conversationId: existingMessage.conversationId,
          inboundMessageId: existingMessage.id,
          processingJobId: job.id,
          duplicate: true
        };
      }

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          direction: MessageDirection.INBOUND,
          status: MessageStatus.RECEIVED,
          body: input.body,
          twilioMessageSid: input.twilioMessageSid
        }
      });

      const job = await tx.processingJob.create({
        data: {
          inboundMessageId: message.id
        }
      });

      return {
        conversationId: conversation.id,
        inboundMessageId: message.id,
        processingJobId: job.id,
        duplicate: false
      };
    });
  }

  async markJobEnqueued(
    processingJobId: string,
    bullJobId: string
  ): Promise<void> {
    await this.prisma.processingJob.update({
      where: {
        id: processingJobId
      },
      data: {
        bullJobId,
        status: JobStatus.QUEUED
      }
    });
  }

  async listConversations(): Promise<ConversationListItem[]> {
    const conversations = await this.prisma.conversation.findMany({
      orderBy: {
        updatedAt: "desc"
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "desc"
          },
          take: 1
        },
        _count: {
          select: {
            messages: true
          }
        }
      }
    });

    return conversations.map((conversation) => {
      const lastMessage = conversation.messages[0] ?? null;

      return {
        id: conversation.id,
        fromPhone: conversation.fromPhone,
        toPhone: conversation.toPhone,
        lastMessageBody: lastMessage?.body ?? null,
        lastMessageAt: lastMessage?.createdAt.toISOString() ?? null,
        lastMessageDirection: lastMessage
          ? mapMessageDirection(lastMessage.direction)
          : null,
        lastMessageStatus: lastMessage
          ? mapMessageStatusForDirection(lastMessage.direction, lastMessage.status)
          : null,
        messageCount: conversation._count.messages,
        updatedAt: conversation.updatedAt.toISOString()
      };
    });
  }

  async getConversationMessages(
    conversationId: string
  ): Promise<ConversationMessagesResponse | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        id: conversationId
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc"
          },
          include: {
            jobs: {
              orderBy: {
                createdAt: "desc"
              },
              take: 1
            }
          }
        }
      }
    });

    if (!conversation) {
      return null;
    }

    return {
      conversation: {
        id: conversation.id,
        fromPhone: conversation.fromPhone,
        toPhone: conversation.toPhone,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString()
      },
      messages: conversation.messages.map(mapMessageDto)
    };
  }

  async getProcessingItem(
    inboundMessageId: string
  ): Promise<ProcessingItem | null> {
    const message = await this.prisma.message.findUnique({
      where: {
        id: inboundMessageId
      },
      include: {
        conversation: true,
        jobs: true
      }
    });

    if (!message || message.direction !== MessageDirection.INBOUND) {
      return null;
    }

    const job = message.jobs[0];

    if (!job) {
      return null;
    }

    return {
      inboundMessageId: message.id,
      conversationId: message.conversationId,
      body: message.body,
      fromPhone: message.conversation.fromPhone,
      toPhone: message.conversation.toPhone,
      job: {
        id: job.id,
        status: mapJobStatus(job.status),
        attempts: job.attempts,
        maxAttempts: job.maxAttempts
      }
    };
  }

  async markJobProcessing(inboundMessageId: string): Promise<void> {
    await this.prisma.processingJob.update({
      where: {
        inboundMessageId
      },
      data: {
        status: JobStatus.PROCESSING,
        attempts: {
          increment: 1
        },
        lastError: null
      }
    });
  }

  async reserveOutboundReply(input: {
    inboundMessageId: string;
    body: string;
  }): Promise<ReservedOutboundReply> {
    return this.prisma.$transaction(async (tx) => {
      const inbound = await this.requireInboundMessage(tx, input.inboundMessageId);
      const idempotencyKey = `reply:${input.inboundMessageId}`;
      const existing = await tx.message.findUnique({
        where: {
          idempotencyKey
        }
      });

      if (existing?.status === MessageStatus.SENT) {
        return {
          id: existing.id,
          idempotencyKey,
          status: "sent",
          created: false
        };
      }

      if (existing) {
        const updated = await tx.message.update({
          where: {
            id: existing.id
          },
          data: {
            body: input.body,
            status: MessageStatus.PROCESSING,
            failedAt: null
          }
        });

        return {
          id: updated.id,
          idempotencyKey,
          status: "processing",
          created: false
        };
      }

      const outbound = await tx.message.create({
        data: {
          conversationId: inbound.conversationId,
          direction: MessageDirection.OUTBOUND,
          status: MessageStatus.PROCESSING,
          body: input.body,
          idempotencyKey
        }
      });

      return {
        id: outbound.id,
        idempotencyKey,
        status: "processing",
        created: true
      };
    });
  }

  async createOutboundMessage(input: {
    fromPhone: string;
    toPhone: string;
    body: string;
    idempotencyKey: string;
  }): Promise<CreatedOutboundMessage> {
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.upsert({
        where: {
          fromPhone_toPhone: {
            fromPhone: input.toPhone,
            toPhone: input.fromPhone
          }
        },
        update: {
          updatedAt: new Date()
        },
        create: {
          fromPhone: input.toPhone,
          toPhone: input.fromPhone
        }
      });

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          status: MessageStatus.PROCESSING,
          body: input.body,
          idempotencyKey: input.idempotencyKey
        }
      });

      return {
        conversationId: conversation.id,
        outboundMessageId: message.id,
        idempotencyKey: input.idempotencyKey
      };
    });
  }

  async markOutboundMessageAccepted(input: {
    outboundMessageId: string;
    providerMessageId: string;
  }): Promise<void> {
    await this.prisma.message.update({
      where: {
        id: input.outboundMessageId
      },
      data: {
        status: MessageStatus.PROCESSING,
        providerMessageId: input.providerMessageId,
        sentAt: null,
        failedAt: null
      }
    });
  }

  async markOutboundMessageFailed(outboundMessageId: string): Promise<void> {
    await this.prisma.message.update({
      where: {
        id: outboundMessageId
      },
      data: {
        status: MessageStatus.FAILED,
        failedAt: new Date()
      }
    });
  }

  async markOutboundReplyAccepted(input: {
    inboundMessageId: string;
    outboundMessageId: string;
    providerMessageId: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.message.update({
        where: {
          id: input.outboundMessageId
        },
        data: {
          status: MessageStatus.PROCESSING,
          providerMessageId: input.providerMessageId,
          sentAt: null,
          failedAt: null
        }
      });

      await tx.message.update({
        where: {
          id: input.inboundMessageId
        },
        data: {
          status: MessageStatus.RECEIVED,
          sentAt: null,
          failedAt: null
        }
      });

      await tx.processingJob.update({
        where: {
          inboundMessageId: input.inboundMessageId
        },
        data: {
          status: JobStatus.COMPLETED,
          lastError: null
        }
      });
    });
  }

  async updateOutboundMessageStatus(input: {
    providerMessageId: string;
    status: OutboundDeliveryStatus;
  }): Promise<UpdatedOutboundMessageStatus | null> {
    const message = await this.prisma.message.findFirst({
      where: {
        providerMessageId: input.providerMessageId,
        direction: MessageDirection.OUTBOUND
      },
      select: {
        id: true,
        conversationId: true,
        status: true
      }
    });

    if (!message) {
      return null;
    }

    if (shouldIgnoreOutboundStatusUpdate(message.status, input.status)) {
      return {
        conversationId: message.conversationId,
        outboundMessageId: message.id,
        status: mapOutboundDeliveryStatus(message.status),
        changed: false
      };
    }

    const now = new Date();

    await this.prisma.message.update({
      where: {
        id: message.id
      },
      data: {
        status: mapPrismaOutboundDeliveryStatus(input.status),
        sentAt: input.status === "sent" ? now : null,
        failedAt: input.status === "failed" ? now : null
      }
    });

    return {
      conversationId: message.conversationId,
      outboundMessageId: message.id,
      status: input.status,
      changed: true
    };
  }

  async markJobFailure(input: {
    inboundMessageId: string;
    errorMessage: string;
    final: boolean;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const status = input.final ? JobStatus.FAILED : JobStatus.QUEUED;
      const failedAt = input.final ? new Date() : null;

      await tx.processingJob.update({
        where: {
          inboundMessageId: input.inboundMessageId
        },
        data: {
          status,
          lastError: input.errorMessage
        }
      });

      await tx.message.update({
        where: {
          id: input.inboundMessageId
        },
        data: {
          status: MessageStatus.RECEIVED,
          failedAt: null
        }
      });

      await tx.message.updateMany({
        where: {
          idempotencyKey: `reply:${input.inboundMessageId}`,
          status: MessageStatus.PROCESSING
        },
        data: {
          status: input.final ? MessageStatus.FAILED : MessageStatus.PROCESSING,
          failedAt
        }
      });
    });
  }

  async markJobCompleted(inboundMessageId: string): Promise<void> {
    await this.prisma.processingJob.update({
      where: {
        inboundMessageId
      },
      data: {
        status: JobStatus.COMPLETED,
        lastError: null
      }
    });
  }

  async findJobsNeedingEnqueue(input: {
    limit: number;
    staleProcessingBefore: Date;
  }): Promise<JobsNeedingEnqueue> {
    const jobs = await this.prisma.processingJob.findMany({
      where: {
        OR: [
          {
            status: JobStatus.QUEUED
          },
          {
            status: JobStatus.PROCESSING,
            updatedAt: {
              lt: input.staleProcessingBefore
            }
          }
        ]
      },
      orderBy: {
        createdAt: "asc"
      },
      take: input.limit,
      select: {
        id: true,
        inboundMessageId: true
      }
    });

    return jobs.map((job) => ({
      processingJobId: job.id,
      inboundMessageId: job.inboundMessageId
    }));
  }

  private async requireInboundMessage(
    tx: PrismaTransaction,
    inboundMessageId: string
  ) {
    const inbound = await tx.message.findUnique({
      where: {
        id: inboundMessageId
      }
    });

    if (!inbound || inbound.direction !== MessageDirection.INBOUND) {
      throw new Error(`Inbound message ${inboundMessageId} was not found`);
    }

    return inbound;
  }
}

function mapMessageStatus(status: MessageStatus) {
  switch (status) {
    case MessageStatus.RECEIVED:
      return "received";
    case MessageStatus.PROCESSING:
      return "processing";
    case MessageStatus.SENT:
      return "sent";
    case MessageStatus.FAILED:
      return "failed";
  }
}

function mapMessageStatusForDirection(
  direction: MessageDirection,
  status: MessageStatus
) {
  if (direction === MessageDirection.INBOUND) {
    return "received";
  }

  return mapMessageStatus(status);
}

function mapPrismaOutboundDeliveryStatus(status: OutboundDeliveryStatus) {
  switch (status) {
    case "processing":
      return MessageStatus.PROCESSING;
    case "sent":
      return MessageStatus.SENT;
    case "failed":
      return MessageStatus.FAILED;
  }
}

function mapOutboundDeliveryStatus(status: MessageStatus): OutboundDeliveryStatus {
  switch (status) {
    case MessageStatus.SENT:
      return "sent";
    case MessageStatus.FAILED:
      return "failed";
    case MessageStatus.RECEIVED:
    case MessageStatus.PROCESSING:
      return "processing";
  }
}

function shouldIgnoreOutboundStatusUpdate(
  current: MessageStatus,
  next: OutboundDeliveryStatus
) {
  if (current === MessageStatus.FAILED && next !== "failed") {
    return true;
  }

  if (
    current === MessageStatus.SENT &&
    next === "processing"
  ) {
    return true;
  }

  return false;
}

function mapJobStatus(status: JobStatus): ProcessingJobStatus {
  switch (status) {
    case JobStatus.QUEUED:
      return "queued";
    case JobStatus.PROCESSING:
      return "processing";
    case JobStatus.COMPLETED:
      return "completed";
    case JobStatus.FAILED:
      return "failed";
  }
}

function mapMessageDirection(direction: MessageDirection) {
  switch (direction) {
    case MessageDirection.INBOUND:
      return "inbound";
    case MessageDirection.OUTBOUND:
      return "outbound";
  }
}

function mapMessageDto(message: {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  status: MessageStatus;
  body: string;
  jobs?: Array<{
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
  }>;
  providerMessageId: string | null;
  twilioMessageSid: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
}): MessageDto {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: mapMessageDirection(message.direction),
    status: mapMessageStatusForDirection(message.direction, message.status),
    body: message.body,
    processingJob: mapMessageProcessingJob(message.direction, message.jobs),
    providerMessageId: message.providerMessageId,
    twilioMessageSid: message.twilioMessageSid,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    sentAt: message.sentAt?.toISOString() ?? null,
    failedAt: message.failedAt?.toISOString() ?? null
  };
}

function mapMessageProcessingJob(
  direction: MessageDirection,
  jobs: Array<{
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
  }> | undefined
): MessageProcessingJob | null {
  if (direction !== MessageDirection.INBOUND) {
    return null;
  }

  const job = jobs?.[0] ?? null;

  if (!job) {
    return null;
  }

  return {
    status: mapJobStatus(job.status),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError
  };
}
