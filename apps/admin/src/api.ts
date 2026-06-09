import { getAdminConfig } from "@repo/config";
import {
  conversationListItemSchema,
  conversationMessagesResponseSchema,
  sendOutboundSmsResponseSchema,
  type ConversationListItem,
  type ConversationMessagesResponse,
  type SendOutboundSmsResponse
} from "@repo/contracts";
import { z } from "zod";

const config = getAdminConfig(import.meta.env);

export async function listConversations(): Promise<ConversationListItem[]> {
  const payload = await getJson("/api/conversations");
  const parsed = z
    .object({
      conversations: z.array(conversationListItemSchema)
    })
    .parse(payload);

  return parsed.conversations;
}

export async function getConversationMessages(
  conversationId: string
): Promise<ConversationMessagesResponse> {
  const payload = await getJson(`/api/conversations/${conversationId}/messages`);
  return conversationMessagesResponseSchema.parse(payload);
}

export type InboundWebhookTestInput = {
  messageSid: string;
  from: string;
  to: string;
  body: string;
};

export type InboundWebhookTestResponse = {
  accepted: boolean;
  duplicate: boolean;
  enqueued: boolean;
  conversationId: string;
  inboundMessageId: string;
};

export async function sendInboundWebhookTest(
  input: InboundWebhookTestInput
): Promise<InboundWebhookTestResponse> {
  const body = new URLSearchParams({
    MessageSid: input.messageSid,
    From: input.from,
    To: input.to,
    Body: input.body
  });

  const payload = await postForm("/webhooks/twilio/sms", body);

  return z
    .object({
      accepted: z.boolean(),
      duplicate: z.boolean(),
      enqueued: z.boolean(),
      conversationId: z.string(),
      inboundMessageId: z.string()
    })
    .parse(payload);
}

export async function sendOutboundSms(input: {
  to: string;
  body: string;
}): Promise<SendOutboundSmsResponse> {
  const payload = await postJson("/api/messages/send", input, {
    allowFailedSmsResponse: true
  });

  return sendOutboundSmsResponseSchema.parse(payload);
}

export function getApiEndpoint(path: string) {
  return `${config.apiBaseUrl}${path}`;
}

export function getEventStreamEndpoint() {
  return getApiEndpoint("/api/events");
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${config.apiBaseUrl}${path}`);

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json();
}

async function postJson(
  path: string,
  body: unknown,
  options: { allowFailedSmsResponse?: boolean } = {}
): Promise<unknown> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    if (options.allowFailedSmsResponse) {
      return payload;
    }

    throw new Error(`Request failed with ${response.status}`);
  }

  return payload;
}

async function postForm(
  path: string,
  body: URLSearchParams
): Promise<unknown> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return payload;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}
