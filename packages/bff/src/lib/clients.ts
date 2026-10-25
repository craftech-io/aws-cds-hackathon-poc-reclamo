// AWS SDK v3 clients with explicit timeouts and retry budgets. Every Lambda that talks to AWS
// builds its client here so the call timeout stays below the Lambda timeout, which in turn stays
// below what the channel waits for (CLAUDE.md, typescript-dev agent).
//
// Only DynamoDB lives here for now (WP-10); later waves add SES, End User Messaging, Bedrock and
// AgentCore clients with the same `awsClientConfig` so nothing runs without a deadline.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export interface ClientTimeouts {
  /** Milliseconds to wait for the whole response before the SDK gives up on one attempt. */
  readonly requestTimeoutMs: number;
  /** Milliseconds to establish the TCP connection. */
  readonly connectionTimeoutMs: number;
  /** SDK attempts including the first one (adaptive retry inside the SDK). */
  readonly maxAttempts: number;
}

// DynamoDB answers in single-digit milliseconds; anything past two seconds is an outage, and the
// SDK's own retries already cover throttling.
export const DYNAMO_TIMEOUTS: ClientTimeouts = {
  requestTimeoutMs: 2_000,
  connectionTimeoutMs: 1_000,
  maxAttempts: 3,
};

export function awsClientConfig(timeouts: ClientTimeouts) {
  return {
    maxAttempts: timeouts.maxAttempts,
    requestHandler: new NodeHttpHandler({
      requestTimeout: timeouts.requestTimeoutMs,
      connectionTimeout: timeouts.connectionTimeoutMs,
    }),
  };
}

let documentClient: DynamoDBDocumentClient | undefined;

export function createDocumentClient(timeouts: ClientTimeouts = DYNAMO_TIMEOUTS): DynamoDBDocumentClient {
  const base = new DynamoDBClient(awsClientConfig(timeouts));
  return DynamoDBDocumentClient.from(base, {
    // Optional entity fields are `undefined` in TypeScript and simply absent in DynamoDB.
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    unmarshallOptions: { wrapNumbers: false },
  });
}

/** Process-wide DocumentClient, reused across Lambda invocations of the same container. */
export function dynamoDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= createDocumentClient();
  return documentClient;
}
