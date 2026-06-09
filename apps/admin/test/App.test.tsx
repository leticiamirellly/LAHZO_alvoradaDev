import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

const conversationsPayload = {
  conversations: [
    {
      id: "conversation-1",
      fromPhone: "+15551234567",
      toPhone: "+15550000000",
      lastMessageBody: "Hello",
      lastMessageAt: "2026-06-08T12:00:00.000Z",
      lastMessageDirection: "inbound",
      lastMessageStatus: "received",
      messageCount: 2,
      updatedAt: "2026-06-08T12:00:00.000Z"
    }
  ]
};

const messagesPayload = {
  conversation: {
    id: "conversation-1",
    fromPhone: "+15551234567",
    toPhone: "+15550000000",
    createdAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:01:00.000Z"
  },
  messages: [
    {
      id: "message-1",
      conversationId: "conversation-1",
      direction: "inbound",
      status: "received",
      body: "Hello",
      processingJob: {
        status: "completed",
        attempts: 1,
        maxAttempts: 3,
        lastError: null
      },
      providerMessageId: null,
      twilioMessageSid: "SM123",
      createdAt: "2026-06-08T12:00:00.000Z",
      updatedAt: "2026-06-08T12:00:00.000Z",
      sentAt: "2026-06-08T12:01:00.000Z",
      failedAt: null
    },
    {
      id: "message-2",
      conversationId: "conversation-1",
      direction: "outbound",
      status: "sent",
      body: "Thanks for your message. We received: \"Hello\"",
      processingJob: null,
      providerMessageId: "SMabc",
      twilioMessageSid: null,
      createdAt: "2026-06-08T12:01:00.000Z",
      updatedAt: "2026-06-08T12:01:00.000Z",
      sentAt: "2026-06-08T12:01:00.000Z",
      failedAt: null
    }
  ]
};

describe("App", () => {
  beforeEach(() => {
    TestEventSource.instances = [];
    vi.stubEnv("VITE_API_BASE_URL", "http://api.test");
    vi.stubGlobal("fetch", createFetchHandler());
    vi.stubGlobal("EventSource", TestEventSource);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders conversations and opens a conversation detail", async () => {
    renderApp("/");

    expect(await screen.findByText("+15551234567 -> +15550000000")).toBeVisible();

    await userEvent.click(screen.getByText("+15551234567 -> +15550000000"));

    await waitFor(() => {
      expect(screen.getByText("2 messages")).toBeVisible();
    });

    expect(within(screen.getByLabelText("Conversation detail")).getByText("Hello")).toBeVisible();
    expect(
      screen.getByText('Thanks for your message. We received: "Hello"')
    ).toBeVisible();
  });

  it("redirects stale conversation URLs before loading messages", async () => {
    const fetchSpy = vi.mocked(fetch);

    renderApp("/conversations/missing-conversation");

    expect(await screen.findByText("+15551234567 -> +15550000000")).toBeVisible();

    await waitFor(() => {
      expect(screen.getByText("Select a conversation")).toBeVisible();
    });

    expect(
      fetchSpy.mock.calls.some(([url]) =>
        String(url).endsWith("/api/conversations/missing-conversation/messages")
      )
    ).toBe(false);
  });

  it("shows a refresh loading row while conversations are reloading", async () => {
    let releaseRefresh: (() => void) | null = null;
    let conversationRequests = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/conversations")) {
          conversationRequests += 1;

          if (conversationRequests > 1) {
            await new Promise<void>((resolve) => {
              releaseRefresh = resolve;
            });
          }

          return jsonResponse(conversationsPayload);
        }

        if (url.endsWith("/api/conversations/conversation-1/messages")) {
          return jsonResponse(messagesPayload);
        }

        return new Response(null, {
          status: 404
        });
      })
    );

    renderApp("/");

    expect(await screen.findByText("+15551234567 -> +15550000000")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Refresh conversations"
      })
    );

    expect(await screen.findByText("Refreshing conversations")).toBeVisible();

    releaseRefresh?.();

    await waitFor(() => {
      expect(screen.queryByText("Refreshing conversations")).toBeNull();
    });
  });

  it("refreshes conversations from the SSE event stream", async () => {
    const fetchSpy = vi.mocked(fetch);

    renderApp("/conversations/conversation-1");

    expect(await screen.findByText("+15551234567 -> +15550000000")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByText("2 messages")).toBeVisible();
    });

    expect(TestEventSource.instances[0]?.url).toBe(
      "http://localhost:3000/api/events"
    );

    TestEventSource.instances[0]?.emit(
      "conversation.changed",
      JSON.stringify({
        type: "conversation.changed",
        conversationId: "conversation-1",
        occurredAt: "2026-06-09T12:00:00.000Z"
      })
    );

    await waitFor(() => {
      expect(countFetches(fetchSpy, "/api/conversations")).toBeGreaterThan(1);
      expect(
        countFetches(fetchSpy, "/api/conversations/conversation-1/messages")
      ).toBeGreaterThan(1);
    });
  });

  it("opens the endpoint test console and submits both test flows", async () => {
    const fetchSpy = vi.mocked(fetch);

    renderApp("/");

    await userEvent.click(await screen.findByText("Test Twilio endpoints"));

    expect(screen.getByText("Endpoint Test Console")).toBeVisible();
    expect(
      screen.getByText("http://localhost:3000/webhooks/twilio/sms")
    ).toBeVisible();
    expect(
      screen.getByText("http://localhost:3000/api/messages/send")
    ).toBeVisible();

    const inboundForm = screen.getByLabelText("Inbound webhook test");
    await userEvent.click(
      within(inboundForm).getByRole("button", {
        name: "Send inbound webhook"
      })
    );

    expect(await screen.findByText(/"accepted": true/)).toBeVisible();

    const outboundForm = screen.getByLabelText("Outbound API test");
    await userEvent.type(within(outboundForm).getByLabelText("To"), "+5511999999999");
    await userEvent.click(
      within(outboundForm).getByRole("button", {
        name: "Send outbound SMS"
      })
    );

    expect(await screen.findByText(/"providerMessageId": "SM456"/)).toBeVisible();
    expect(
      fetchSpy.mock.calls.some(
        ([url, init]) =>
          String(url) === "http://localhost:3000/webhooks/twilio/sms" &&
          init?.method === "POST"
      )
    ).toBe(true);
    expect(
      fetchSpy.mock.calls.some(
        ([url, init]) =>
          String(url) === "http://localhost:3000/api/messages/send" &&
          init?.method === "POST"
      )
    ).toBe(true);
  });
});

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchInterval: false
      }
    }
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

function createFetchHandler() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/conversations")) {
      return jsonResponse(conversationsPayload);
    }

    if (url.endsWith("/api/conversations/conversation-1/messages")) {
      return jsonResponse(messagesPayload);
    }

    if (url.endsWith("/webhooks/twilio/sms") && init?.method === "POST") {
      return jsonResponse({
        accepted: true,
        duplicate: false,
        enqueued: true,
        conversationId: "conversation-1",
        inboundMessageId: "message-1"
      });
    }

    if (url.endsWith("/api/messages/send") && init?.method === "POST") {
      return jsonResponse({
        status: "processing",
        conversationId: "conversation-1",
        outboundMessageId: "message-2",
        providerMessageId: "SM456",
        error: null
      });
    }

    return new Response(null, {
      status: 404
    });
  });
}

class TestEventSource {
  static instances: TestEventSource[] = [];

  readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.listeners.clear();
  }

  emit(type: string, data: string) {
    const event = new MessageEvent(type, {
      data
    });

    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function countFetches(fetchSpy: ReturnType<typeof vi.mocked<typeof fetch>>, path: string) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith(path)).length;
}
