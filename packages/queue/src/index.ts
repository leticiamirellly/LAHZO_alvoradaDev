import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

export const incomingSmsQueueName = "incoming-sms";
export const processIncomingSmsJobName = "process-incoming-sms";

export type IncomingSmsJobData = {
  inboundMessageId: string;
};

export function createRedisConnection(redisUrl: string) {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null
  } satisfies ConnectionOptions;
}

export function createIncomingSmsQueue(connection: ConnectionOptions) {
  return new Queue<IncomingSmsJobData>(incomingSmsQueueName, {
    connection
  });
}

export function incomingSmsJobId(inboundMessageId: string) {
  return `incoming-${inboundMessageId}`;
}

export async function enqueueIncomingSms(
  queue: Queue<IncomingSmsJobData>,
  inboundMessageId: string
) {
  const options: JobsOptions = {
    jobId: incomingSmsJobId(inboundMessageId),
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000
    },
    removeOnComplete: 1000,
    removeOnFail: 5000
  };

  const job = await queue.add(
    processIncomingSmsJobName,
    { inboundMessageId },
    options
  );

  return job.id ?? incomingSmsJobId(inboundMessageId);
}
