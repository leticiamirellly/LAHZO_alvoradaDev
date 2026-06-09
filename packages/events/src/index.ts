import { Redis } from "ioredis";

export const smsEventsChannel = "sms-events";

export type SmsEvent = {
  type: "conversation.changed";
  conversationId: string | null;
  occurredAt: string;
};

export interface SmsEventPublisher {
  publishConversationChanged(conversationId: string | null): Promise<void>;
  close(): Promise<void>;
}

export interface SmsEventSubscriber {
  subscribe(handler: (event: SmsEvent) => void): Promise<() => void>;
  close(): Promise<void>;
}

export class RedisSmsEventPublisher implements SmsEventPublisher {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async publishConversationChanged(conversationId: string | null) {
    const event: SmsEvent = {
      type: "conversation.changed",
      conversationId,
      occurredAt: new Date().toISOString()
    };

    await this.redis.publish(smsEventsChannel, JSON.stringify(event));
  }

  async close() {
    this.redis.disconnect();
  }
}

export class RedisSmsEventSubscriber implements SmsEventSubscriber {
  private readonly redis: Redis;
  private readonly handlers = new Set<(event: SmsEvent) => void>();
  private subscribed = false;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.redis.on("message", (_channel: string, payload: string) => {
      const event = parseSmsEvent(payload);

      if (!event) {
        return;
      }

      for (const handler of this.handlers) {
        handler(event);
      }
    });
  }

  async subscribe(handler: (event: SmsEvent) => void) {
    this.handlers.add(handler);

    if (!this.subscribed) {
      await this.redis.subscribe(smsEventsChannel);
      this.subscribed = true;
    }

    return () => {
      this.handlers.delete(handler);
    };
  }

  async close() {
    this.redis.disconnect();
  }
}

export class NoopSmsEventPublisher implements SmsEventPublisher {
  async publishConversationChanged() {
    return undefined;
  }

  async close() {
    return undefined;
  }
}

function parseSmsEvent(payload: string): SmsEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const event = parsed as Partial<SmsEvent>;

    if (event.type !== "conversation.changed") {
      return null;
    }

    if (
      typeof event.conversationId !== "string" &&
      event.conversationId !== null
    ) {
      return null;
    }

    if (typeof event.occurredAt !== "string") {
      return null;
    }

    return {
      type: event.type,
      conversationId: event.conversationId,
      occurredAt: event.occurredAt
    };
  } catch {
    return null;
  }
}
