import { resolve } from "node:path";
import { Worker } from "bullmq";
import { config as loadEnv } from "dotenv";
import { getServerConfig } from "@repo/config";
import { PrismaClient, PrismaSmsRepository } from "@repo/db";
import { RedisSmsEventPublisher } from "@repo/events";
import {
  createIncomingSmsQueue,
  createRedisConnection,
  enqueueIncomingSms,
  incomingSmsQueueName,
  type IncomingSmsJobData
} from "@repo/queue";
import { createSmsProvider } from "@repo/twilio";
import {
  createRandomProcessingDelay,
  DeterministicResponseGenerator,
  processIncomingSmsJob
} from "./message-processor.js";
import { DurableJobRequeuer } from "./requeue.js";

loadEnv({ path: resolve(process.cwd(), ".env") });
loadEnv({ path: resolve(process.cwd(), "../..", ".env") });

const config = getServerConfig();
const prisma = new PrismaClient({
  log: ["warn", "error"]
});
const repository = new PrismaSmsRepository(prisma);
const eventPublisher = new RedisSmsEventPublisher(config.redisUrl);
const queueConnection = createRedisConnection(config.redisUrl);
const workerConnection = createRedisConnection(config.redisUrl);
const queue = createIncomingSmsQueue(queueConnection);
const smsProvider = createSmsProvider({
  accountSid: config.twilioAccountSid,
  authToken: config.twilioAuthToken,
  apiKeySid: config.twilioApiKeySid,
  apiKeySecret: config.twilioApiKeySecret,
  fromPhone: config.twilioFromPhone,
  messagingServiceSid: config.twilioMessagingServiceSid
    ? config.twilioMessagingServiceSid
    : undefined,
  statusCallbackUrl: config.twilioStatusCallbackUrl
});
const responseGenerator = new DeterministicResponseGenerator();
const waitForProcessing = createRandomProcessingDelay(
  config.processingDelayMinMs,
  config.processingDelayMaxMs
);

const worker = new Worker<IncomingSmsJobData>(
  incomingSmsQueueName,
  async (job) =>
    processIncomingSmsJob({
      inboundMessageId: job.data.inboundMessageId,
      repository,
      smsProvider,
      eventPublisher,
      responseGenerator,
      waitForProcessing
    }),
  {
    connection: workerConnection,
    concurrency: config.workerConcurrency
  }
);

const requeuer = new DurableJobRequeuer(
  repository,
  {
    enqueue: (inboundMessageId) => enqueueIncomingSms(queue, inboundMessageId)
  },
  console
);

await requeuer.runOnce();

const requeueInterval = setInterval(() => {
  void requeuer.runOnce();
}, 30_000);

worker.on("failed", (job, error) => {
  console.warn(
    {
      jobId: job?.id,
      inboundMessageId: job?.data.inboundMessageId,
      error
    },
    "incoming_sms_job_failed"
  );
});

worker.on("completed", (job, result) => {
  console.log(
    {
      jobId: job.id,
      inboundMessageId: job.data.inboundMessageId,
      result
    },
    "incoming_sms_job_completed"
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

async function shutdown() {
  clearInterval(requeueInterval);
  await worker.close();
  await queue.close();
  await eventPublisher.close();
  await prisma.$disconnect();
  process.exit(0);
}
