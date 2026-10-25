/// <reference path="../../sst-env.d.ts" />
// The operator's reads and writes of the lead scripts, inside `sst shell` (the linked `Leads` table
// and the pool of `Resource.Auth`, the `PhoneHashKey` secret), with the operator's profile. The only
// full read of `Leads`: a paged `Scan` of the `LEAD#` items, which no Lambda role may run.
import { AdminDeleteUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { authConfig } from "../../packages/bff/src/auth/config";
import { type Lead, Lead as LeadSchema } from "../../packages/bff/src/leads/records";
import { awsClientConfig, dynamoDocumentClient } from "../../packages/bff/src/lib/clients";
import { tableName } from "../../packages/bff/src/lib/resource";

const COGNITO_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 2_000, maxAttempts: 3 } as const;

/** Every lead of the table, page by page (skips a row that does not parse, and says how many). */
export async function* scanLeads(): AsyncIterable<Lead> {
  const client = dynamoDocumentClient();
  let start: Record<string, unknown> | undefined;
  let skipped = 0;
  do {
    const page: ScanCommandOutput = await client.send(
      new ScanCommand({ TableName: tableName("Leads"), FilterExpression: "begins_with(pk, :lead)", ExpressionAttributeValues: { ":lead": "LEAD#" }, ...(start ? { ExclusiveStartKey: start } : {}) }),
    );
    for (const item of page.Items ?? []) {
      const parsed = LeadSchema.safeParse(item);
      if (parsed.success) yield parsed.data;
      else skipped += 1;
    }
    start = page.LastEvaluatedKey;
  } while (start);
  if (skipped > 0) console.warn(`leads: ${skipped} row(s) did not match the lead schema and were left out.`);
}

/** The two Cognito calls of a deletion, on the app's pool; "no such user" is not an error. */
export function poolAccounts() {
  const auth = authConfig();
  const client = new CognitoIdentityProviderClient({ region: auth.region, ...awsClientConfig(COGNITO_TIMEOUTS) });
  const tolerant = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof Error && error.name === "UserNotFoundException")) throw error;
    }
  };
  return {
    signOutEverywhere: (username: string) => tolerant(() => client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: auth.userPoolId, Username: username }))),
    deleteAccount: (username: string) => tolerant(() => client.send(new AdminDeleteUserCommand({ UserPoolId: auth.userPoolId, Username: username }))),
  };
}
