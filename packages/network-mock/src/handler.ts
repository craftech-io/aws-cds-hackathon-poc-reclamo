/// <reference path="../../../sst-env.d.ts" />
// Lambda entry of `NetworkMock` (Function URL with AWS_IAM, infra/mocks.ts). What it reaches comes
// linked through `Resource` (never `process.env`), validated with zod at first use:
//
//   Networks            its table (`name`)
//   Settlements         the bucket of the settlement files (`name`)
//   MockCallers         `{ roles: { <logical name>: <IAM role ARN> } }` of the functions that may invoke a mock
//
// Each AWS client carries its own timeouts and the SDK's retries with backoff; past them the request
// answers 503 and the caller retries. Nobody invokes it outside its Function URL.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { z } from "zod";
import { CallerRoleArns } from "./http/caller";
import { createFunctionUrlHandler } from "./http/lambda";
import { createDynamoNetworkStore } from "./store/dynamo";
import { createS3SettlementObjects } from "./store/s3";

const DYNAMO_CLIENT = { maxAttempts: 3, requestHandler: { requestTimeout: 2_000, connectionTimeout: 1_000 } };
const S3_CLIENT = { maxAttempts: 3, requestHandler: { requestTimeout: 5_000, connectionTimeout: 1_000 } };

const Named = z.object({ name: z.string().min(1) });

/** A linked resource, checked with zod; `Resource` throws when the name is not linked to this function. */
function readLinked<T>(logicalName: "Networks" | "Settlements" | "MockCallers", schema: z.ZodType<T>): T {
  return schema.parse(Reflect.get(Resource, logicalName));
}

export const handler = createFunctionUrlHandler(() => {
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient(DYNAMO_CLIENT), { marshallOptions: { removeUndefinedValues: true } });
  return {
    store: createDynamoNetworkStore({ client: documents, tableName: readLinked("Networks", Named).name }),
    objects: createS3SettlementObjects({ client: new S3Client(S3_CLIENT), bucket: readLinked("Settlements", Named).name }),
    callers: readLinked("MockCallers", CallerRoleArns),
  };
});
