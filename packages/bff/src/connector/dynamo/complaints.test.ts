// The complaints repository over DynamoDB (SDK mocked): the exact requests it sends — a create that
// cannot overwrite, a transition conditional on version and origin states, index queries with
// cursors — and how AWS errors reach the domain.
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectorError } from "@reclamo/shared";
import { cond } from "../store";
import { SIM_NOW, TEST_NOW, approval, complaint } from "../testing";
import { createDynamoConnector } from "./connector";

const ddb = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const sleeps: number[] = [];
const connector = createDynamoConnector({ client, tableName: (table) => `reclamo-poc-${table}`, now: () => TEST_NOW, sleep: async (ms) => void sleeps.push(ms) });

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: {} });
}

beforeEach(() => {
  ddb.reset();
  sleeps.length = 0;
});

describe("complaints over DynamoDB", () => {
  it("creates a complaint with a put that cannot overwrite, carrying its index keys", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await connector.transact([connector.complaints.createOp(complaint("demo"))]);
    const input = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const put = input?.TransactItems?.[0]?.Put;
    expect(put).toMatchObject({
      TableName: "reclamo-poc-Complaints",
      ConditionExpression: "attribute_not_exists(#n0)",
      ExpressionAttributeNames: { "#n0": "pk" },
      Item: {
        pk: "W#demo#CMP#cmp-0001",
        sk: "META",
        entity: "Complaint",
        worldId: "demo",
        version: 1,
        inboxKey: "W#demo#OPEN",
        deadlineSort: "2026-10-23T02:59:59.000Z",
        customerKey: "W#demo#CUS#cus-0001",
        numberKey: "W#demo#R-2026-000123",
        worldIndexKey: "W#demo#",
        createdAt: TEST_NOW.toISOString(),
      },
    });
    expect(put?.ExpressionAttributeValues).toBeUndefined();
  });

  it("guards a transaction with a condition check whose values are all used", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await connector.transact([
      { kind: "check", table: "Worlds", key: { pk: "W#demo#WORLD", sk: "META" }, condition: cond.eq("status", "READY") },
      connector.complaints.createOp(complaint("demo")),
    ]);
    const check = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[0]?.ConditionCheck;
    expect(check).toEqual({
      TableName: "reclamo-poc-Worlds",
      Key: { pk: "W#demo#WORLD", sk: "META" },
      ConditionExpression: "#n0 = :v0",
      ExpressionAttributeNames: { "#n0": "status" },
      ExpressionAttributeValues: { ":v0": "READY" },
    });
  });

  it("transitions with version = :v AND status IN (:allowedFrom), appending the history, as one update", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { pk: "x", sk: "META" } });
    await connector.write(
      connector.complaints.transitionOp({
        worldId: "demo",
        complaintId: "cmp-0001",
        version: 4,
        allowedFrom: ["INVESTIGATING", "HUMAN_REVIEW"],
        to: "RESOLVED",
        change: { from: "INVESTIGATING", to: "RESOLVED", atSim: SIM_NOW, cause: "ACTION_EXECUTED", actor: "AGENT" },
        patch: { outcome: "IN_FAVOUR" },
      }),
    );
    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ TableName: "reclamo-poc-Complaints", Key: { pk: "W#demo#CMP#cmp-0001", sk: "META" }, ReturnValues: "ALL_NEW" });
    expect(input?.ConditionExpression).toBe("(#n0 = :v0 AND #n1 IN (:v1, :v2))");
    expect(input?.UpdateExpression).toBe("SET #n2 = :v3, #n1 = :v4, #n3 = :v5, #n0 = :v6, #n4 = :v7, #n5 = list_append(if_not_exists(#n5, :v8), :v9)");
    expect(input?.ExpressionAttributeNames).toEqual({ "#n0": "version", "#n1": "status", "#n2": "outcome", "#n3": "inboxKey", "#n4": "updatedAt", "#n5": "statusHistory" });
    expect(input?.ExpressionAttributeValues).toMatchObject({ ":v0": 4, ":v1": "INVESTIGATING", ":v2": "HUMAN_REVIEW", ":v3": "IN_FAVOUR", ":v4": "RESOLVED", ":v6": 5 });
  });

  it("turns a failed condition into CONFLICT, throttling into a retryable THROTTLED and a timeout into TIMEOUT", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} }));
    const conflict = await connector.complaints.patch("demo", "cmp-0001", 1, { slaState: "AT_RISK" }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ConnectorError);
    expect(conflict).toMatchObject({ code: "CONFLICT", retryable: false, table: "Complaints" });

    ddb.on(GetCommand).rejects(awsError("ProvisionedThroughputExceededException"));
    await expect(connector.complaints.get("demo", "cmp-0001")).rejects.toMatchObject({ code: "THROTTLED", retryable: true });
    ddb.on(GetCommand).rejects(awsError("TimeoutError"));
    await expect(connector.complaints.get("demo", "cmp-0001")).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    ddb.on(GetCommand).rejects(awsError("InternalServerError"));
    await expect(connector.complaints.get("demo", "cmp-0001")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("reads strongly consistent when asked, and refuses a stored row that does not match its schema", async () => {
    const stored = { ...complaint("demo"), pk: "W#demo#CMP#cmp-0001", sk: "META", entity: "Complaint", version: 3, inboxKey: "W#demo#OPEN", expiresAt: 1 };
    ddb.on(GetCommand).resolves({ Item: stored });
    expect(await connector.complaints.get("demo", "cmp-0001", { consistent: true })).toMatchObject({ complaintNumber: "R-2026-000123", version: 3 });
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input).toEqual({ TableName: "reclamo-poc-Complaints", Key: { pk: "W#demo#CMP#cmp-0001", sk: "META" }, ConsistentRead: true });
    ddb.on(GetCommand).resolves({ Item: { ...stored, status: "LOST" } });
    await expect(connector.complaints.get("demo", "cmp-0001")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("queries the inbox index by world and state and pages with the key DynamoDB returned", async () => {
    const lastKey = { pk: "W#demo#CMP#cmp-0001", sk: "META", inboxKey: "W#demo#OPEN", deadlineSort: "2026-10-23T02:59:59.000Z" };
    ddb.on(QueryCommand).resolvesOnce({ Items: [{ ...complaint("demo"), pk: "p", sk: "META", version: 1 }], LastEvaluatedKey: lastKey }).resolves({ Items: [] });
    const first = await connector.complaints.listInbox("demo", { limit: 1 });
    expect(first.complaints).toHaveLength(1);
    await connector.complaints.listInbox("demo", { limit: 1, cursor: first.cursor as string });
    const calls = ddb.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(calls[0]).toEqual({
      TableName: "reclamo-poc-Complaints",
      IndexName: "InboxIndex",
      KeyConditionExpression: "#n0 = :v0",
      ExpressionAttributeNames: { "#n0": "inboxKey" },
      ExpressionAttributeValues: { ":v0": "W#demo#OPEN" },
      ScanIndexForward: true,
      Limit: 1,
    });
    expect(calls[1]?.ExclusiveStartKey).toEqual(lastKey);
  });

  it("decides a pending approval once on its version and takes it out of the pending index", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    await connector.transact([connector.caseItems.createApprovalOp(approval("demo"))]);
    const put = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[0]?.Put;
    expect(put?.Item).toMatchObject({ sk: "APR#apr-0001", decision: "PENDING", approvalKey: "W#demo#PENDING", requestedAtSort: "2026-10-07T13:10:00.000Z" });

    await connector.write(
      connector.caseItems.decideApprovalOp({ worldId: "demo", complaintId: "cmp-0001", approvalId: "apr-0001", version: 1, decision: "APPROVED", decidedBy: "stf-lucia", decidedAtSim: SIM_NOW }),
    );
    const update = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.ConditionExpression).toBe("(#n0 = :v0 AND #n1 = :v1)");
    expect(update?.ExpressionAttributeNames).toMatchObject({ "#n0": "version", "#n1": "decision" });
    expect(update?.ExpressionAttributeValues).toMatchObject({ ":v0": 1, ":v1": "PENDING" });
    expect(update?.UpdateExpression).toMatch(/ REMOVE #n\d+, #n\d+$/);
    expect(Object.values(update?.ExpressionAttributeNames ?? {})).toEqual(expect.arrayContaining(["approvalKey", "requestedAtSort"]));
  });
});

describe("world items over DynamoDB", () => {
  const items = (count: number) => Array.from({ length: count }, (_, index) => ({ pk: `W#qa-r1-sc01#CUS#cus-${index}`, sk: "META", entity: "Customer" }));

  it("writes a factory block in batches of 25 and retries what DynamoDB left unprocessed, with backoff", async () => {
    const unprocessed = { "reclamo-poc-Core": [{ PutRequest: { Item: { pk: "W#qa-r1-sc01#CUS#cus-3", sk: "META" } } }] };
    ddb.on(BatchWriteCommand).resolvesOnce({ UnprocessedItems: unprocessed }).resolves({});
    await connector.worldItems.put("Core", "qa-r1-sc01", items(30));
    const calls = ddb.commandCalls(BatchWriteCommand).map((call) => call.args[0].input.RequestItems?.["reclamo-poc-Core"]?.length);
    expect(calls).toEqual([25, 1, 5]);
    expect(sleeps).toHaveLength(1);
  });

  it("reports items that stay unprocessed as THROTTLED, and never batches an append-only table", async () => {
    const unprocessed = { "reclamo-poc-Core": [{ DeleteRequest: { Key: { pk: "W#qa-r1-sc01#CUS#cus-0", sk: "META" } } }] };
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: unprocessed });
    await expect(connector.worldItems.delete("Core", "qa-r1-sc01", [{ pk: "W#qa-r1-sc01#CUS#cus-0", sk: "META" }])).rejects.toMatchObject({ code: "THROTTLED" });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(5);
    ddb.reset();
    await expect(connector.worldItems.delete("Register", "qa-r1-sc01", [{ pk: "W#qa-r1-sc01#REG#e1", sk: "000000001" }])).rejects.toMatchObject({ code: "VALIDATION" });
    expect(ddb.calls()).toHaveLength(0);
  });

  it("enumerates a world through WorldIndex with its partition", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "W#qa-r1-sc01#CUS#cus-0", sk: "META", worldIndexKey: "W#qa-r1-sc01#", worldIndexSort: "W#qa-r1-sc01#CUS#cus-0|META" }] });
    expect((await connector.worldItems.listKeys("Core", "qa-r1-sc01")).keys).toEqual([{ pk: "W#qa-r1-sc01#CUS#cus-0", sk: "META" }]);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({ IndexName: "WorldIndex", ExpressionAttributeValues: { ":v0": "W#qa-r1-sc01#" } });
  });
});
