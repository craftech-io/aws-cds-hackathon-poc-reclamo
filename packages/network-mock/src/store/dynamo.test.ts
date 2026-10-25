import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { NetworkUnavailableError } from "../errors";
import { TEST_REAL_NOW } from "../testing";
import { createDynamoNetworkStore } from "./dynamo";
import { type StoredBatch, type StoredTransfer, items } from "./items";

type Command = GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand;

/** A DocumentClient that records each command and answers from a script. */
function fakeClient(answer: (command: Command) => unknown = () => ({})) {
  const sent: Command[] = [];
  return {
    sent,
    client: {
      send: async (command: Command) => {
        sent.push(command);
        const result = answer(command);
        if (result instanceof Error) throw result;
        return result;
      },
    } as never,
  };
}

function cancelled(codes: string[]): Error {
  return Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });
}

const BATCH: StoredBatch = { worldId: "qamin", network: "NORTE", businessDate: "2026-10-07", status: "PENDING", publishAtSim: "2026-10-08T08:30:00-03:00", seq: 1, deferred: false, version: 3 };
const LINE = {
  worldId: "qamin",
  origin: "COLLECTION" as const,
  createdBatch: false,
  line: { network: "NORTE" as const, businessDate: "2026-10-07", operationCode: "NTE-20261006-004817-2", paidAt: "2026-10-06T18:40:00-03:00", amount: 100, customerRef: "cus-0001", loanRef: "L-0001", instalment: 4, terminal: "T-0412" },
};
const TRANSFER: StoredTransfer = { worldId: "qamin", transferId: "trf-1", customerId: "cus-0030", direction: "OUT", amount: 800, status: "REJECTED_NOT_REVERSED", transitions: [], version: 1 };

describe("DynamoDB network store", () => {
  it("reads with strong consistency and parses what it reads", async () => {
    const { client, sent } = fakeClient(() => ({ Item: items.batch(BATCH, TEST_REAL_NOW) }));
    const store = createDynamoNetworkStore({ client, tableName: "networks-table", realNow: () => TEST_REAL_NOW });
    expect(await store.getBatch("qamin", "NORTE", "2026-10-07")).toEqual(BATCH);
    expect(sent[0]?.input).toEqual({ TableName: "networks-table", Key: { pk: "W#qamin#NET#NORTE", sk: "BATCH#2026-10-07" }, ConsistentRead: true });
  });

  it("pages through a batch's lines", async () => {
    let page = 0;
    const { client, sent } = fakeClient(() => {
      page += 1;
      return page === 1 ? { Items: [items.line(LINE, TEST_REAL_NOW)], LastEvaluatedKey: { pk: "x", sk: "y" } } : { Items: [] };
    });
    const store = createDynamoNetworkStore({ client, tableName: "networks-table" });
    expect(await store.listLines("qamin", "NORTE", "2026-10-07")).toEqual([LINE]);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.input).toMatchObject({ KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to", ExpressionAttributeValues: { ":pk": "W#qamin#NET#NORTE", ":from": "LINE#2026-10-07#" } });
    expect(sent[1]?.input).toMatchObject({ ExclusiveStartKey: { pk: "x", sk: "y" } });
  });

  it("writes a collection in one transaction: batch at its version and still PENDING, the code's claim, the line", async () => {
    const { client, sent } = fakeClient();
    const store = createDynamoNetworkStore({ client, tableName: "networks-table", realNow: () => TEST_REAL_NOW });
    expect(await store.writeCollection({ worldId: "qamin", network: "NORTE", businessDate: "2026-10-07", batch: { expectVersion: 3 }, lines: [LINE] })).toBe("OK");
    const transactItems = (sent[0] as TransactWriteCommand).input.TransactItems ?? [];
    expect(transactItems).toHaveLength(3);
    expect(transactItems[0]?.Update).toMatchObject({ Key: { pk: "W#qamin#NET#NORTE", sk: "BATCH#2026-10-07" }, ConditionExpression: "#version = :expected AND #status = :pending" });
    expect(transactItems[1]?.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)", Item: { pk: "W#qamin#NET#NORTE", sk: "OPC#NTE-20261006-004817-2", worldIndexKey: "W#qamin#" } });
    expect(transactItems[2]?.Put?.Item).toMatchObject({ sk: "LINE#2026-10-07#NTE-20261006-004817-2", entity: "SettlementLine", expiresAt: expect.any(Number) });
  });

  it("maps a cancelled transaction to the outcome, and any other failure to unavailable", async () => {
    const write = { worldId: "qamin", network: "NORTE" as const, businessDate: "2026-10-07", batch: { create: BATCH }, lines: [LINE] };
    const stale = createDynamoNetworkStore({ client: fakeClient(() => cancelled(["ConditionalCheckFailed", "None", "None"])).client, tableName: "t" });
    expect(await stale.writeCollection(write)).toBe("STALE");
    const taken = createDynamoNetworkStore({ client: fakeClient(() => cancelled(["None", "ConditionalCheckFailed", "None"])).client, tableName: "t" });
    expect(await taken.writeCollection(write)).toBe("CODE_TAKEN");
    const down = createDynamoNetworkStore({ client: fakeClient(() => Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" })).client, tableName: "t" });
    await expect(down.writeCollection(write)).rejects.toBeInstanceOf(NetworkUnavailableError);
    await expect(down.getTransfer("qamin", "trf-1")).rejects.toBeInstanceOf(NetworkUnavailableError);
  });

  it("publishes only a PENDING batch at the version it read", async () => {
    const { client, sent } = fakeClient((command) => (command instanceof UpdateCommand && sent.length > 1 ? Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }) : {}));
    const store = createDynamoNetworkStore({ client, tableName: "t", realNow: () => TEST_REAL_NOW });
    const publication = { publishedAtSim: "2026-10-08T08:30:00-03:00", s3Key: "W/demo/NORTE/2026-10-07/batch-1.csv", lineCount: 4, sha256: "a".repeat(64) };
    expect(await store.markPublished(BATCH, publication)).toBe("OK");
    expect((sent[0] as UpdateCommand).input).toMatchObject({ ConditionExpression: "#version = :expected AND #status = :pending", ExpressionAttributeValues: { ":expected": 3, ":next": 4, ":pending": "PENDING" } });
    expect(await store.markPublished(BATCH, publication)).toBe("STALE");
  });

  it("takes the TRV# claim and moves the transfer in one transaction", async () => {
    const { client, sent } = fakeClient();
    const store = createDynamoNetworkStore({ client, tableName: "t", realNow: () => TEST_REAL_NOW });
    const claim = { worldId: "qamin", transferId: "trf-1", actionId: "trv-1", customerId: "cus-0030", complaintId: "cmp-1", idempotencyKey: "k", amount: 800, reversedAtSim: "2026-10-07T10:10:00-03:00" };
    expect(await store.reverseTransfer(claim, { ...TRANSFER, status: "REJECTED_REVERSED" }, 1)).toBe("OK");
    const [put, update] = (sent[0] as TransactWriteCommand).input.TransactItems ?? [];
    expect(put?.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)", Item: { pk: "W#qamin#TRV#trf-1", sk: "CLAIM" } });
    expect(update?.Update).toMatchObject({ Key: { pk: "W#qamin#TRF#trf-1", sk: "STATUS" }, ConditionExpression: "#version = :expected" });
    const claimed = createDynamoNetworkStore({ client: fakeClient(() => cancelled(["ConditionalCheckFailed", "None"])).client, tableName: "t" });
    expect(await claimed.reverseTransfer(claim, TRANSFER, 1)).toBe("CODE_TAKEN");
  });
});
