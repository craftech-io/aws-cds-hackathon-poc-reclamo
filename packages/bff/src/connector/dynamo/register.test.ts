// The append-only records over DynamoDB (SDK mocked, ADR-0014): an append is ONE
// `TransactWriteItems` with the conditional head and a put that cannot overwrite, the entry tables
// never receive an update, a delete or a batch write, and a cancelled transaction tells the caller
// which operation failed.
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TransactionCancelledError } from "../errors";
import { SIM_NOW, TEST_NOW, auditEntry, registerEntry, tapeEntry, testHash } from "../testing";
import { createDynamoConnector } from "./connector";

const ddb = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const connector = createDynamoConnector({ client, tableName: (table) => `reclamo-poc-${table}`, now: () => TEST_NOW });
const APPEND_ONLY = ["reclamo-poc-Register", "reclamo-poc-ComplianceTape", "reclamo-poc-AuditLog"];

function transactItems(index = 0) {
  return ddb.commandCalls(TransactWriteCommand)[index]?.args[0].input.TransactItems ?? [];
}

beforeEach(() => {
  ddb.reset();
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(PutCommand).resolves({});
});

// Whatever a test did, no append-only table received anything but a put that cannot overwrite.
afterEach(() => {
  expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  for (const call of [...ddb.commandCalls(UpdateCommand), ...ddb.commandCalls(DeleteCommand)]) expect(APPEND_ONLY).not.toContain(call.args[0].input.TableName);
  for (const call of ddb.commandCalls(TransactWriteCommand)) {
    for (const item of call.args[0].input.TransactItems ?? []) {
      expect(APPEND_ONLY).not.toContain(item.Update?.TableName);
      expect(APPEND_ONLY).not.toContain(item.Delete?.TableName);
      if (item.Put && APPEND_ONLY.includes(item.Put.TableName as string)) expect(item.Put.ConditionExpression).toBe("attribute_not_exists(#n0)");
    }
  }
  for (const call of ddb.commandCalls(PutCommand)) {
    if (APPEND_ONLY.includes(call.args[0].input.TableName as string)) expect(call.args[0].input.ConditionExpression).toBe("attribute_not_exists(#n0)");
  }
});

describe("register over DynamoDB", () => {
  it("reads the head strongly consistent", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "W#demo#COUNTER#REGSEQ#e1", sk: "META", entity: "ChainHead", value: 7, hash: testHash(7) } });
    expect(await connector.chains.readHead("demo", 1, "REG")).toEqual({ value: 7, hash: testHash(7) });
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input).toEqual({ TableName: "reclamo-poc-Runtime", Key: { pk: "W#demo#COUNTER#REGSEQ#e1", sk: "META" }, ConsistentRead: true });
  });

  it("appends the first entry in one transaction: head created only if absent, entry put only if absent", async () => {
    const appended = await connector.chains.append({ chain: "REG", head: undefined, entry: registerEntry("demo", 1) });
    expect(appended).toMatchObject({ pk: "W#demo#REG#e1", sk: "000000001", seq: 1 });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    const [head, entry] = transactItems();
    expect(head?.Update).toMatchObject({ TableName: "reclamo-poc-Runtime", Key: { pk: "W#demo#COUNTER#REGSEQ#e1", sk: "META" }, ConditionExpression: "attribute_not_exists(#n0)" });
    expect(head?.Update?.ExpressionAttributeNames?.["#n0"]).toBe("value");
    expect(head?.Update?.UpdateExpression).toMatch(/^SET #n0 = :v0, #n1 = :v1/);
    expect(head?.Update?.ExpressionAttributeValues).toMatchObject({ ":v0": 1, ":v1": testHash(1) });
    expect(entry?.Put).toMatchObject({
      TableName: "reclamo-poc-Register",
      ConditionExpression: "attribute_not_exists(#n0)",
      ExpressionAttributeNames: { "#n0": "pk" },
      Item: { pk: "W#demo#REG#e1", sk: "000000001", entity: "RegisterEntry", seq: 1, hash: testHash(1), complaintKey: "W#demo#e1#R-2026-000123" },
    });
    // Demo register entries expire after 180 days, fixed at write time.
    expect(entry?.Put?.Item?.expiresAt).toBe(Math.floor(TEST_NOW.getTime() / 1000) + 180 * 86_400);
  });

  it("conditions the next append on the head the caller read and carries the caller's extra operations", async () => {
    const transition = connector.complaints.transitionOp({
      worldId: "demo",
      complaintId: "cmp-0001",
      version: 2,
      allowedFrom: ["REGISTERED"],
      to: "INVESTIGATING",
      change: { from: "REGISTERED", to: "INVESTIGATING", atSim: SIM_NOW, cause: "IDENTIFIED", actor: "AGENT" },
    });
    await connector.chains.append({ chain: "REG", head: { value: 41, hash: testHash(41) }, entry: registerEntry("demo", 42), extra: [transition] });
    const items = transactItems();
    expect(items).toHaveLength(3);
    expect(items[0]?.Update?.ConditionExpression).toBe("#n0 = :v0");
    expect(items[0]?.Update?.ExpressionAttributeValues?.[":v0"]).toBe(41);
    expect(items[1]?.Put?.Item).toMatchObject({ sk: "000000042", prevHash: testHash(41) });
    expect(items[2]?.Update).toMatchObject({ TableName: "reclamo-poc-Complaints", ConditionExpression: "(#n0 = :v0 AND #n1 IN (:v1))" });
  });

  it("surfaces a cancelled append with the reason of each operation, so the caller re-reads and retries", async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: "Transaction cancelled",
        $metadata: {},
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }],
      }),
    );
    const error = await connector.chains.append({ chain: "REG", head: { value: 1, hash: testHash(1) }, entry: registerEntry("demo", 2) }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionCancelledError);
    expect(error).toMatchObject({ code: "CONFLICT", reasons: ["ConditionalCheckFailed", "None", "None"] });
    expect((error as TransactionCancelledError).failedConditions()).toEqual([0]);

    ddb.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: [{ Code: "ThrottlingError" }, { Code: "None" }] }));
    await expect(connector.chains.append({ chain: "REG", head: { value: 1, hash: testHash(1) }, entry: registerEntry("demo", 2) })).rejects.toMatchObject({ code: "THROTTLED", retryable: true });
  });

  it("files a tape entry by Argentine simulated day with its decision, complaint and seq indexes", async () => {
    await connector.chains.append({ chain: "TAPE", head: undefined, entry: tapeEntry("demo", 1, { decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"] }) });
    const [head, entry] = transactItems();
    expect(head?.Update?.Key).toEqual({ pk: "W#demo#COUNTER#TAPESEQ#e1", sk: "META" });
    expect(entry?.Put).toMatchObject({
      TableName: "reclamo-poc-ComplianceTape",
      Item: {
        pk: "W#demo#TAPE#2026-10-07",
        sk: "2026-10-07T13:10:00.000Z#tape-1",
        decisionKey: "W#demo#BLOCKED",
        complaintKey: "W#demo#CMP#cmp-0001",
        seqKey: "W#demo#TAPESEQ#e1",
        atSort: "2026-10-07T13:10:00.000Z",
        messageId: "msg-1",
      },
    });
  });

  it("walks the register of an epoch in seq order with a consistent query", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ ...registerEntry("demo", 5), pk: "W#demo#REG#e1", sk: "000000005", entity: "RegisterEntry", version: 1 }] });
    const { entries } = await connector.chains.listRegister("REG", "demo", 1, { fromSeq: 5 });
    expect(entries.map((entry) => entry.seq)).toEqual([5]);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: "reclamo-poc-Register",
      KeyConditionExpression: "#n0 = :v0 AND #n1 >= :v1",
      ExpressionAttributeValues: { ":v0": "W#demo#REG#e1", ":v1": "000000005" },
      ConsistentRead: true,
    });
  });
});

describe("audit log over DynamoDB", () => {
  it("appends with a single put that cannot overwrite", async () => {
    await connector.audit.append(auditEntry("g01", { action: "CROSS_WORLD", actor: "OPERATOR:stf-guest-01" }));
    const input = ddb.commandCalls(PutCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      TableName: "reclamo-poc-AuditLog",
      ConditionExpression: "attribute_not_exists(#n0)",
      Item: { pk: "W#g01#AUD#e1#2026-10", sk: "2026-10-07T13:10:00.000Z#aud-0001", actionKey: "W#g01#CROSS_WORLD", refIndexKey: "W#g01#CMP#cmp-0001", entity: "Decision" },
    });
  });
});

describe("append-only guard", () => {
  it("refuses to build an update, a delete or an unconditional put on an append-only table, before sending anything", async () => {
    const key = { pk: "W#demo#REG#e1", sk: "000000001" };
    await expect(connector.write({ kind: "update", table: "Register", key, update: { set: { hash: "forged" } } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(connector.write({ kind: "delete", table: "ComplianceTape", key })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(connector.write({ kind: "put", table: "AuditLog", item: { ...key, forged: true } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(connector.transact([{ kind: "update", table: "Register", key, update: { set: { hash: "forged" } } }])).rejects.toMatchObject({ code: "VALIDATION" });
    expect(ddb.calls()).toHaveLength(0);
  });
});
