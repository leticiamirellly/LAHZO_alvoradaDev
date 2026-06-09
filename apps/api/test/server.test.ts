import { request as httpRequest } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/server.js";

describe("API server", () => {
  const apps: Array<ReturnType<typeof createApiServer>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it("accepts a JSON Twilio webhook and returns 202", async () => {
    const incomingSmsService = {
      receive: vi.fn(async () => ({
        conversationId: "conversation-1",
        inboundMessageId: "message-1",
        processingJobId: "job-1",
        duplicate: false,
        enqueued: true
      }))
    };
    const app = createTestServer(incomingSmsService);
    apps.push(app);
    await app.ready();

    await request(app.server)
      .post("/webhooks/twilio/sms")
      .send({
        MessageSid: "SM123",
        From: "+15551234567",
        To: "+15550000000",
        Body: "Hello"
      })
      .expect(202)
      .expect((response) => {
        expect(response.body).toMatchObject({
          accepted: true,
          duplicate: false,
          enqueued: true
        });
      });

    expect(incomingSmsService.receive).toHaveBeenCalledWith({
      twilioMessageSid: "SM123",
      fromPhone: "+15551234567",
      toPhone: "+15550000000",
      body: "Hello"
    });
  });

  it("accepts a form-urlencoded Twilio webhook", async () => {
    const incomingSmsService = {
      receive: vi.fn(async () => ({
        conversationId: "conversation-1",
        inboundMessageId: "message-1",
        processingJobId: "job-1",
        duplicate: true,
        enqueued: true
      }))
    };
    const app = createTestServer(incomingSmsService);
    apps.push(app);
    await app.ready();

    await request(app.server)
      .post("/webhooks/twilio/sms")
      .type("form")
      .send({
        MessageSid: "SM123",
        From: "+15551234567",
        To: "+15550000000",
        Body: "Hello again"
      })
      .expect(202)
      .expect((response) => {
        expect(response.body.duplicate).toBe(true);
      });
  });

  it("rejects invalid Twilio payloads", async () => {
    const app = createTestServer({
      receive: vi.fn()
    });
    apps.push(app);
    await app.ready();

    await request(app.server)
      .post("/webhooks/twilio/sms")
      .send({
        From: "+15551234567"
      })
      .expect(400);
  });

  it("sends an outbound SMS through the API endpoint", async () => {
    const outboundSmsService = {
      send: vi.fn(async () => ({
        status: "processing",
        conversationId: "conversation-1",
        outboundMessageId: "message-2",
        providerMessageId: "SM456",
        error: null
      }))
    };
    const app = createApiServer(
      {
        repository: {
          listConversations: vi.fn(),
          getConversationMessages: vi.fn(),
          updateOutboundMessageStatus: vi.fn()
        },
        incomingSmsService: {
          receive: vi.fn()
        } as never,
        outboundSmsService: outboundSmsService as never
      },
      {
        logger: false
      }
    );
    apps.push(app);
    await app.ready();

    await request(app.server)
      .post("/api/messages/send")
      .send({
        to: "+15551234567",
        body: "Manual test"
      })
      .expect(202)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: "processing",
          conversationId: "conversation-1",
          outboundMessageId: "message-2",
          providerMessageId: "SM456",
          error: null
        });
      });

    expect(outboundSmsService.send).toHaveBeenCalledWith({
      to: "+15551234567",
      body: "Manual test"
    });
  });

  it("returns failed status when outbound SMS delivery fails", async () => {
    const app = createApiServer(
      {
        repository: {
          listConversations: vi.fn(),
          getConversationMessages: vi.fn(),
          updateOutboundMessageStatus: vi.fn()
        },
        incomingSmsService: {
          receive: vi.fn()
        } as never,
        outboundSmsService: {
          send: vi.fn(async () => ({
            status: "failed",
            conversationId: "conversation-1",
            outboundMessageId: "message-2",
            providerMessageId: null,
            error: "Twilio send failed with 400"
          }))
        } as never
      },
      {
        logger: false
      }
    );
    apps.push(app);
    await app.ready();

    await request(app.server)
      .post("/api/messages/send")
      .send({
        to: "+15551234567",
        body: "Manual test"
      })
      .expect(502)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: "failed",
          error: "Twilio send failed with 400"
        });
      });
  });

  it("lists conversations and messages for the admin", async () => {
    const repository = {
      listConversations: vi.fn(async () => [
        {
          id: "conversation-1",
          fromPhone: "+15551234567",
          toPhone: "+15550000000",
          lastMessageBody: "Hello",
          lastMessageAt: "2026-06-08T12:00:00.000Z",
          lastMessageDirection: "outbound",
          lastMessageStatus: "sent",
          messageCount: 2,
          updatedAt: "2026-06-08T12:01:00.000Z"
        }
      ]),
      getConversationMessages: vi.fn(async () => ({
        conversation: {
          id: "conversation-1",
          fromPhone: "+15551234567",
          toPhone: "+15550000000",
          createdAt: "2026-06-08T12:00:00.000Z",
          updatedAt: "2026-06-08T12:01:00.000Z"
        },
        messages: []
      })),
      updateOutboundMessageStatus: vi.fn()
    };
    const app = createApiServer(
      {
        repository,
        incomingSmsService: {
          receive: vi.fn()
        } as never,
        outboundSmsService: {
          send: vi.fn()
        } as never
      },
      {
        logger: false
      }
    );
    apps.push(app);
    await app.ready();

    await request(app.server).get("/api/conversations").expect(200);
    await request(app.server)
      .get("/api/conversations/conversation-1/messages")
      .expect(200)
      .expect((response) => {
        expect(response.body.conversation.id).toBe("conversation-1");
      });
  });

  it("accepts Twilio status callbacks and updates outbound message status", async () => {
    const eventPublisher = {
      publishConversationChanged: vi.fn(async () => undefined)
    };
    const repository = {
      listConversations: vi.fn(),
      getConversationMessages: vi.fn(),
      updateOutboundMessageStatus: vi.fn(async () => ({
        conversationId: "conversation-1",
        outboundMessageId: "message-2",
        status: "sent",
        changed: true
      }))
    };
    const app = createApiServer(
      {
        repository,
        incomingSmsService: {
          receive: vi.fn()
        } as never,
        outboundSmsService: {
          send: vi.fn()
        } as never,
        eventPublisher
      },
      {
        logger: false
      }
    );
    apps.push(app);
    await app.ready();

    await request(app.server)
      .post("/webhooks/twilio/message-status")
      .type("form")
      .send({
        MessageSid: "SM456",
        MessageStatus: "delivered"
      })
      .expect(202)
      .expect((response) => {
        expect(response.body).toMatchObject({
          accepted: true,
          updated: true,
          conversationId: "conversation-1",
          outboundMessageId: "message-2",
          status: "sent"
        });
      });

    expect(repository.updateOutboundMessageStatus).toHaveBeenCalledWith({
      providerMessageId: "SM456",
      status: "sent"
    });
    expect(eventPublisher.publishConversationChanged).toHaveBeenCalledWith(
      "conversation-1"
    );
  });

  it("streams conversation events over SSE", async () => {
    const eventSubscriber = {
      subscribe: vi.fn(async (handler) => {
        handler({
          type: "conversation.changed",
          conversationId: "conversation-1",
          occurredAt: "2026-06-09T12:00:00.000Z"
        });

        return vi.fn();
      })
    };
    const app = createApiServer(
      {
        repository: {
          listConversations: vi.fn(),
          getConversationMessages: vi.fn(),
          updateOutboundMessageStatus: vi.fn()
        },
        incomingSmsService: {
          receive: vi.fn()
        } as never,
        outboundSmsService: {
          send: vi.fn()
        } as never,
        eventSubscriber
      },
      {
        logger: false
      }
    );
    apps.push(app);
    await app.listen({
      host: "127.0.0.1",
      port: 0
    });
    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port");
    }

    const body = await readSseUntil(
      `http://127.0.0.1:${address.port}/api/events`,
      "event: conversation.changed",
      {
        Origin: "http://localhost:5174"
      }
    );

    expect(body).toContain("event: connected");
    expect(body).toContain("event: conversation.changed");
    expect(body).toContain('"conversationId":"conversation-1"');
  });
});

function createTestServer(incomingSmsService: { receive: unknown }) {
  return createApiServer(
    {
      repository: {
        listConversations: vi.fn(),
        getConversationMessages: vi.fn(),
        updateOutboundMessageStatus: vi.fn()
      },
      incomingSmsService: incomingSmsService as never,
      outboundSmsService: {
        send: vi.fn()
      } as never
    },
    {
      logger: false
    }
  );
}

function readSseUntil(
  url: string,
  marker: string,
  headers: Record<string, string> = {}
) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    const clientRequest = httpRequest(url, { headers }, (response) => {
      expect(response.headers["access-control-allow-origin"]).toBe(
        headers.Origin ?? "*"
      );
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;

        if (body.includes(marker)) {
          clientRequest.destroy();
          resolve(body);
        }
      });
    });

    clientRequest.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") {
        reject(error);
      }
    });
    clientRequest.setTimeout(2000, () => {
      clientRequest.destroy();
      reject(new Error("Timed out waiting for SSE event"));
    });
    clientRequest.end();
  });
}
