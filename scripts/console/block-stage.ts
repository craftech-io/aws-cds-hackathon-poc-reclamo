/// <reference path="../../sst-env.d.ts" />
// The AWS side of `console:block` (block.ts), inside `sst shell` with the operator's profile: the app's
// user pool (`Resource.Auth`), the linked tables and a filtered `Scan` of `Runtime` for the passes of
// the SMS code of one account (their keys carry a session hash no index can find).
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { authConfig } from "../../packages/bff/src/auth/config";
import { DynamoStore } from "../../packages/bff/src/connector/dynamo/engine";
import type { Key } from "../../packages/bff/src/connector/store";
import { awsClientConfig, dynamoDocumentClient } from "../../packages/bff/src/lib/clients";
import { tableName } from "../../packages/bff/src/lib/resource";
import type { BlockDeps } from "./block";
import { COGNITO_TIMEOUTS } from "./invite";

async function runtimeKeys(pkPrefix: string): Promise<Key[]> {
  const client = dynamoDocumentClient();
  const found: Key[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await client.send(
      new ScanCommand({
        TableName: tableName("Runtime"),
        FilterExpression: "begins_with(pk, :prefix)",
        ProjectionExpression: "pk, sk",
        ExpressionAttributeValues: { ":prefix": pkPrefix },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    for (const item of page.Items ?? []) if (typeof item.pk === "string" && typeof item.sk === "string") found.push({ pk: item.pk, sk: item.sk });
    start = page.LastEvaluatedKey;
  } while (start);
  return found;
}

export function stageBlockDeps(): BlockDeps {
  const auth = authConfig();
  return {
    cognito: new CognitoIdentityProviderClient({ region: auth.region, ...awsClientConfig(COGNITO_TIMEOUTS) }),
    userPoolId: auth.userPoolId,
    store: new DynamoStore(),
    runtimeKeys,
    now: () => new Date(),
  };
}
