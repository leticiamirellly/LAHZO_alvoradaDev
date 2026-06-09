import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  createSmsProvider,
  TwilioRestSmsProvider
} from "../src/index.js";

const providerConfig = {
  accountSid: "AC123",
  apiKeySid: "SK123",
  apiKeySecret: "secret",
  fromPhone: "+15862044115",
  statusCallbackUrl: "https://api.example.com/webhooks/twilio/message-status"
};

describe("TwilioRestSmsProvider", () => {
  it("sends an SMS through the Twilio Messages API", async () => {
    const calls: Array<{
      url: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url, init });

      return new Response(
        JSON.stringify({
          sid: "SM123"
        }),
        {
          status: 201
        }
      );
    }) as typeof fetch;

    const provider = new TwilioRestSmsProvider(providerConfig, fetchImpl);

    const result = await provider.sendSms({
      from: "+15550000000",
      to: "+15551234567",
      body: "Hello",
      idempotencyKey: "reply:message-1"
    });

    expect(result).toEqual({
      providerMessageId: "SM123"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const { url, init } = calls[0] ?? {};
    const body = init?.body as URLSearchParams;

    expect(url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from("SK123:secret").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    });
    expect(body.get("From")).toBe("+15862044115");
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("Hello");
    expect(body.get("StatusCallback")).toBe(
      "https://api.example.com/webhooks/twilio/message-status"
    );
  });

  it("uses a messaging service when configured", async () => {
    const calls: Array<{
      url: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url, init });

      return new Response(JSON.stringify({ sid: "SM123" }), {
        status: 201
      });
    }) as typeof fetch;
    const provider = new TwilioRestSmsProvider(
      {
        ...providerConfig,
        messagingServiceSid: "MG123"
      },
      fetchImpl
    );

    await provider.sendSms({
      from: "+15550000000",
      to: "+15551234567",
      body: "Hello",
      idempotencyKey: "reply:message-1"
    });

    const { init } = calls[0] ?? {};
    const body = init?.body as URLSearchParams;

    expect(body.get("MessagingServiceSid")).toBe("MG123");
    expect(body.get("From")).toBeNull();
  });

  it("uses account auth token credentials when configured", async () => {
    const calls: Array<{
      url: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url, init });

      return new Response(JSON.stringify({ sid: "SM123" }), {
        status: 201
      });
    }) as typeof fetch;
    const provider = new TwilioRestSmsProvider(
      {
        ...providerConfig,
        authToken: "auth-token"
      },
      fetchImpl
    );

    await provider.sendSms({
      from: "+15550000000",
      to: "+15551234567",
      body: "Hello",
      idempotencyKey: "reply:message-1"
    });

    const { init } = calls[0] ?? {};

    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("AC123:auth-token").toString("base64")}`
    });
  });


  it("throws a useful error when Twilio rejects the request", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "Invalid From" }), {
        status: 400
      });
    }) as typeof fetch;
    const provider = new TwilioRestSmsProvider(providerConfig, fetchImpl);

    await expect(
      provider.sendSms({
        from: "+15550000000",
        to: "+15551234567",
        body: "Hello",
        idempotencyKey: "reply:message-1"
      })
    ).rejects.toThrow("Twilio send failed with 400");
  });
});

describe("createSmsProvider", () => {
  it("requires account credentials", () => {
    expect(() => createSmsProvider({})).toThrow(
      "TWILIO_ACCOUNT_SID is required"
    );
  });
});
