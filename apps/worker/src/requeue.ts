import type { SmsRepository } from "@repo/db";

export type RequeueRepository = Pick<
  SmsRepository,
  "findJobsNeedingEnqueue" | "markJobEnqueued"
>;

export interface JobQueue {
  enqueue(inboundMessageId: string): Promise<string>;
}

export interface RequeueLogger {
  warn(input: unknown, message?: string): void;
}

export class DurableJobRequeuer {
  constructor(
    private readonly repository: RequeueRepository,
    private readonly queue: JobQueue,
    private readonly logger: RequeueLogger
  ) {}

  async runOnce(): Promise<number> {
    const staleProcessingBefore = new Date(Date.now() - 10 * 60 * 1000);
    const jobs = await this.repository.findJobsNeedingEnqueue({
      limit: 100,
      staleProcessingBefore
    });

    let enqueued = 0;

    for (const job of jobs) {
      try {
        const bullJobId = await this.queue.enqueue(job.inboundMessageId);
        await this.repository.markJobEnqueued(job.processingJobId, bullJobId);
        enqueued += 1;
      } catch (error) {
        this.logger.warn(
          {
            error,
            processingJobId: job.processingJobId,
            inboundMessageId: job.inboundMessageId
          },
          "durable_job_requeue_failed"
        );
      }
    }

    return enqueued;
  }
}
