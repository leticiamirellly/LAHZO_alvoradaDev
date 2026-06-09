import { Buffer } from "node:buffer";

export type SendSmsInput = {
  from: string;
  to: string;
  body: string;
  idempotencyKey: string;
};

export type SendSmsResult = {
  providerMessageId: string;
};

export interface SmsProvider {
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
}

export type TwilioRestSmsProviderConfig = {
  accountSid: string;
  authToken?: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  fromPhone?: string;
  messagingServiceSid?: string;
  statusCallbackUrl?: string;
};

export type CreateSmsProviderInput = {
  accountSid?: string | undefined;
  authToken?: string | undefined;
  apiKeySid?: string | undefined;
  apiKeySecret?: string | undefined;
  fromPhone?: string | undefined;
  messagingServiceSid?: string | undefined;
  statusCallbackUrl?: string | undefined;
};

export class TwilioRestSmsProvider implements SmsProvider {
  constructor(
    private readonly config: TwilioRestSmsProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const requestBody = new URLSearchParams({
      To: input.to,
      Body: input.body
    });

    if (this.config.messagingServiceSid) {
      requestBody.set("MessagingServiceSid", this.config.messagingServiceSid);
    } else {
      requestBody.set("From", this.config.fromPhone ?? input.from);
    }

    if (this.config.statusCallbackUrl) {
      requestBody.set("StatusCallback", this.config.statusCallbackUrl);
    }

    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            createBasicAuthCredentials(this.config)
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: requestBody
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Twilio send failed with ${response.status}: ${truncate(responseText)}`
      );
    }

    return {
      providerMessageId: parseTwilioMessageSid(responseText)
    };
  }
}

export function createSmsProvider(input: CreateSmsProviderInput): SmsProvider {
  return new TwilioRestSmsProvider(assertTwilioConfig(input));
}

function assertTwilioConfig(
  input: CreateSmsProviderInput
): TwilioRestSmsProviderConfig {
  if (!input.accountSid) {
    throw new Error("TWILIO_ACCOUNT_SID is required");
  }

  if (input.authToken) {
    return {
      accountSid: input.accountSid,
      authToken: input.authToken,
      ...(input.fromPhone ? { fromPhone: input.fromPhone } : {}),
      ...(input.messagingServiceSid
        ? { messagingServiceSid: input.messagingServiceSid }
        : {}),
      ...(input.statusCallbackUrl
        ? { statusCallbackUrl: input.statusCallbackUrl }
        : {})
    };
  }

  if (!input.apiKeySid) {
    throw new Error("TWILIO_API_KEY_SID is required");
  }

  if (!input.apiKeySecret) {
    throw new Error("TWILIO_API_KEY_SECRET is required");
  }

  return {
    accountSid: input.accountSid,
    apiKeySid: input.apiKeySid,
    apiKeySecret: input.apiKeySecret,
    ...(input.fromPhone ? { fromPhone: input.fromPhone } : {}),
    ...(input.messagingServiceSid
      ? { messagingServiceSid: input.messagingServiceSid }
      : {}),
    ...(input.statusCallbackUrl
      ? { statusCallbackUrl: input.statusCallbackUrl }
      : {})
  };
}

function createBasicAuthCredentials(config: TwilioRestSmsProviderConfig) {
  if (config.authToken) {
    return `${config.accountSid}:${config.authToken}`;
  }

  return `${config.apiKeySid}:${config.apiKeySecret}`;
}

function parseTwilioMessageSid(responseText: string) {
  const parsed: unknown = JSON.parse(responseText);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Twilio response was not an object");
  }

  const sid = (parsed as { sid?: unknown }).sid;

  if (typeof sid !== "string" || sid.length === 0) {
    throw new Error("Twilio response did not include a message sid");
  }

  return sid;
}

function truncate(value: string) {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}
