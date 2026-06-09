import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { getServerConfig } from "@repo/config";
import { PrismaClient, PrismaSmsRepository } from "@repo/db";
import {
  RedisSmsEventPublisher,
  RedisSmsEventSubscriber
} from "@repo/events";
import {
  createIncomingSmsQueue,
  createRedisConnection,
  enqueueIncomingSms
} from "@repo/queue";
import { createSmsProvider } from "@repo/twilio";
import { IncomingSmsService } from "./incoming-sms-service.js";
import { OutboundSmsService } from "./outbound-sms-service.js";
import { createApiServer } from "./server.js";

loadEnv({ path: resolve(process.cwd(), ".env") });
loadEnv({ path: resolve(process.cwd(), "../..", ".env") });

const config = getServerConfig();
const prisma = new PrismaClient({
  log: ["warn", "error"]
});
const repository = new PrismaSmsRepository(prisma);
const eventPublisher = new RedisSmsEventPublisher(config.redisUrl);
const eventSubscriber = new RedisSmsEventSubscriber(config.redisUrl);
const redisConnection = createRedisConnection(config.redisUrl);
const queue = createIncomingSmsQueue(redisConnection);
const smsProvider = createSmsProvider({
  accountSid: config.twilioAccountSid,
  authToken: config.twilioAuthToken,
  apiKeySid: config.twilioApiKeySid,
  apiKeySecret: config.twilioApiKeySecret,
  fromPhone: config.twilioFromPhone,
  messagingServiceSid: config.twilioMessagingServiceSid,
  statusCallbackUrl: config.twilioStatusCallbackUrl
});

const incomingSmsService = new IncomingSmsService(
  repository,
  {
    enqueue: (inboundMessageId) => enqueueIncomingSms(queue, inboundMessageId)
  },
  console
);
const outboundSmsService = new OutboundSmsService(
  repository,
  smsProvider,
  config.twilioFromPhone
);

const app = createApiServer(
  {
    repository,
    incomingSmsService,
    outboundSmsService,
    eventPublisher,
    eventSubscriber
  },
  {
    logger: true
  }
);

await app.listen({
  port: config.apiPort,
  host: "0.0.0.0"
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

async function shutdown() {
  await app.close();
  await queue.close();
  await eventPublisher.close();
  await eventSubscriber.close();
  await prisma.$disconnect();
  process.exit(0);
}
