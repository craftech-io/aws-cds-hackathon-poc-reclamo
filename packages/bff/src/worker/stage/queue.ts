// `ChangeMessageVisibility` of the worker's own queue (infra: `WORKER_OWN_QUEUE_ACTIONS`, on that queue
// only): a `POISON` of the QaDriver releases its delivery at once, so its two deliveries reach the QA dead
// letters without waiting for the visibility timeout (FL-108). The worker never sends a message here: the
// only producer of the queues is worker/enqueue.ts.
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { awsClientConfig } from "../../lib/clients";
import { withRetry } from "../../lib/retry";
import { QUEUE_TIMEOUTS } from "../enqueue";
import type { QueueVisibility } from "../ports";

let client: SQSClient | undefined;

export function sqsQueueVisibility(): QueueVisibility {
  return {
    async releaseNow(receiptHandle, queueUrl) {
      client ??= new SQSClient({ region: "us-east-1", ...awsClientConfig(QUEUE_TIMEOUTS) });
      const sqs = client;
      await withRetry(() => sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 })), { attempts: 2, shouldRetry: () => true });
    },
  };
}
