/// <reference path="../../sst-env.d.ts" />
// The raw writes of `register.tamperProbe` (tamper-probe.ts, ADR-0014) with the QaDriver's OWN role. They
// must NOT go through the connector, which refuses them in code before IAM could answer: the probe exists
// to show what IAM answers (and what the chain detects). So the calls are DynamoDB's JSON API signed with
// SigV4 by hand (the connector stays the only importer of the DynamoDB SDK, connector/boundary.test.ts),
// and `PutLogEvents` on the anchors' log group. Each call answers the AWS error name, or `OK`.
import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { authConfig } from "../auth/config";
import { STAGE_ACCOUNT_ID } from "../channels/whatsapp/config";
import { awsClientConfig } from "../lib/clients";
import { withDeadline } from "../lib/deadline";
import { tableName } from "../lib/resource";
import type { TamperPorts } from "./ports";
import { SHORT_TIMEOUTS, errorNameOf, linkedName } from "./stage-aws";

type AttributeValue = { S: string } | { N: string } | { BOOL: boolean } | { NULL: true } | { L: AttributeValue[] } | { M: Record<string, AttributeValue> };

/** A plain value as DynamoDB JSON (strings, numbers, booleans, null, lists and maps: what an entry holds). */
export function toAttribute(value: unknown): AttributeValue {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (value === null || value === undefined) return { NULL: true };
  if (Array.isArray(value)) return { L: value.map(toAttribute) };
  return { M: toItem(value as Record<string, unknown>) };
}

export function toItem(value: Readonly<Record<string, unknown>>): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined).map(([name, member]) => [name, toAttribute(member)]));
}

/** `com.amazon.coral.service#AccessDeniedException` → `AccessDeniedException`. */
export function errorTypeOf(body: unknown): string {
  const type = (body as { readonly __type?: unknown } | undefined)?.__type;
  return typeof type === "string" ? (type.split("#").pop() ?? type) : "unknown";
}

async function dynamoCall(operation: "UpdateItem" | "DeleteItem" | "PutItem", payload: Readonly<Record<string, unknown>>): Promise<string> {
  const region = authConfig().region;
  const url = new URL(`https://dynamodb.${region}.amazonaws.com/`);
  const body = JSON.stringify(payload);
  const signer = new SignatureV4({ service: "dynamodb", region, credentials: defaultProvider(), sha256: Sha256 });
  const signed = await signer.sign({
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query: {},
    headers: { host: url.host, "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${operation}` },
    body,
  });
  const response = await withDeadline(`dynamodb.${operation}`, 5_000, (signal) => fetch(url, { method: "POST", headers: signed.headers, body, signal, redirect: "error" }));
  if (response.ok) return "OK";
  return errorTypeOf(await response.json().catch(() => undefined));
}

export function stageTamper(): TamperPorts {
  let logs: CloudWatchLogsClient | undefined;
  return {
    appendOnlyTableArns: () => (["Register", "ComplianceTape", "AuditLog"] as const).map((table) => `arn:aws:dynamodb:${authConfig().region}:${STAGE_ACCOUNT_ID}:table/${tableName(table)}`),
    updateRegister: (key) =>
      dynamoCall("UpdateItem", { TableName: tableName("Register"), Key: toItem(key), UpdateExpression: "SET #r = :r", ExpressionAttributeNames: { "#r": "reason" }, ExpressionAttributeValues: { ":r": { S: "qa" } } }),
    deleteRegister: (key) => dynamoCall("DeleteItem", { TableName: tableName("Register"), Key: toItem(key) }),
    putRegister: (item, condition) => dynamoCall("PutItem", { TableName: tableName("Register"), Item: toItem(item), ...(condition === undefined ? {} : { ConditionExpression: condition }) }),
    async putAnchor(stream, message, timestampMs) {
      logs ??= new CloudWatchLogsClient(awsClientConfig(SHORT_TIMEOUTS));
      const client = logs;
      const group = linkedName("RegisterAnchors");
      const created = await errorNameOf(() => client.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: stream })));
      if (created !== "OK" && created !== "ResourceAlreadyExistsException") return created;
      return errorNameOf(() => client.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: stream, logEvents: [{ message, timestamp: timestampMs }] })));
    },
  };
}
