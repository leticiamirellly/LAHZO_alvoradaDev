import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65535);
const millisecondsSchema = z.coerce.number().int().min(0);
const optionalNonEmptySchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional()
);

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: portSchema.default(3000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  PROCESSING_DELAY_MIN_MS: millisecondsSchema.default(3000),
  PROCESSING_DELAY_MAX_MS: millisecondsSchema.default(15000),
  TWILIO_FROM_PHONE: z.string().trim().min(1),
  TWILIO_ACCOUNT_SID: optionalNonEmptySchema,
  TWILIO_AUTH_TOKEN: optionalNonEmptySchema,
  TWILIO_API_KEY_SID: optionalNonEmptySchema,
  TWILIO_API_KEY_SECRET: optionalNonEmptySchema,
  TWILIO_MESSAGING_SERVICE_SID: optionalNonEmptySchema,
  TWILIO_STATUS_CALLBACK_URL: optionalNonEmptySchema
});

const adminEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url().default("http://localhost:3000")
});

export type ServerConfig = ReturnType<typeof getServerConfig>;
export type AdminConfig = ReturnType<typeof getAdminConfig>;

export function getServerConfig(env: NodeJS.ProcessEnv = readProcessEnv()) {
  const config = serverEnvSchema.parse(env);

  if (config.PROCESSING_DELAY_MAX_MS < config.PROCESSING_DELAY_MIN_MS) {
    throw new Error(
      "PROCESSING_DELAY_MAX_MS must be greater than or equal to PROCESSING_DELAY_MIN_MS"
    );
  }

  return {
    databaseUrl: config.DATABASE_URL,
    redisUrl: config.REDIS_URL,
    apiPort: config.API_PORT,
    workerConcurrency: config.WORKER_CONCURRENCY,
    processingDelayMinMs: config.PROCESSING_DELAY_MIN_MS,
    processingDelayMaxMs: config.PROCESSING_DELAY_MAX_MS,
    twilioFromPhone: config.TWILIO_FROM_PHONE,
    twilioAccountSid: config.TWILIO_ACCOUNT_SID,
    twilioAuthToken: config.TWILIO_AUTH_TOKEN,
    twilioApiKeySid: config.TWILIO_API_KEY_SID,
    twilioApiKeySecret: config.TWILIO_API_KEY_SECRET,
    twilioMessagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
    twilioStatusCallbackUrl: config.TWILIO_STATUS_CALLBACK_URL
  };
}

type PublicEnv = Record<string, string | undefined>;

export function getAdminConfig(env: PublicEnv = readImportMetaEnv()) {
  const config = adminEnvSchema.parse(env);

  return {
    apiBaseUrl: config.VITE_API_BASE_URL
  };
}

function readImportMetaEnv(): PublicEnv {
  const meta = import.meta as ImportMeta & { env?: PublicEnv };
  return meta.env ?? {};
}

function readProcessEnv(): NodeJS.ProcessEnv {
  if (typeof process === "undefined") {
    return {};
  }

  return process.env;
}
