import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { type DocumentSender, createDynamoCoreStore } from "./dynamo";
import { StoreConflictError, StoreUnavailableError } from "./port";

type Sent = { name: string; input: Record<string, unknown> };

function fakeClient(answer: (command: Sent) => unknown): { client: DocumentSender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const entry = { name: command.constructor.name, input: command.input };
      sent.push(entry);
      const result = answer(entry);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as DocumentSender;
  return { client, sent };
}

function cancelled(codes: string[]): Error {
  return Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });
}

describe("DynamoDB adapter of the core's store", () => {
  it("reads consistently and pages a partition under a sort-key prefix", async () => {
    let page = 0;
    const { client, sent } = fakeClient(({ name }) => {
      if (name === GetCommand.name) return { Item: { pk: "p", sk: "META" } };
      page += 1;
      return page === 1 ? { Items: [{ pk: "p", sk: "LOAN#1" }], LastEvaluatedKey: { pk: "p", sk: "LOAN#1" } } : { Items: [{ pk: "p", sk: "LOAN#2" }] };
    });
    const store = createDynamoCoreStore({ tableName: "Core", client });
    expect(await store.get("p", "META")).toEqual({ pk: "p", sk: "META" });
    expect(await store.query("p", "LOAN#")).toHaveLength(2);
    expect(sent[0]?.input).toMatchObject({ TableName: "Core", Key: { pk: "p", sk: "META" }, ConsistentRead: true });
    expect(sent[1]?.input).toMatchObject({ KeyConditionExpression: "#k = :k AND begins_with(#sk, :prefix)", ConsistentRead: true, ExpressionAttributeValues: { ":k": "p", ":prefix": "LOAN#" } });
    expect(sent[2]?.input).toMatchObject({ ExclusiveStartKey: { pk: "p", sk: "LOAN#1" } });
  });

  it("queries ByOperationCode and WorldIndex by their own attributes", async () => {
    const { client, sent } = fakeClient(() => ({ Items: [{ pk: "a", sk: "b" }] }));
    const store = createDynamoCoreStore({ tableName: "Core", client });
    await store.queryByOperationCode("W#demo#NORTE#NTE-1");
    expect(await store.worldHasItems("demo")).toBe(true);
    expect(sent[0]?.input).toMatchObject({ IndexName: "ByOperationCode", ExpressionAttributeNames: { "#k": "opCodeKey" }, ConsistentRead: false });
    expect(sent[1]?.input).toMatchObject({ IndexName: "WorldIndex", ExpressionAttributeNames: { "#k": "worldIndexKey" }, ExpressionAttributeValues: { ":k": "W#demo#" }, Limit: 1 });
  });

  it("writes one transaction of conditional puts", async () => {
    const { client, sent } = fakeClient(() => ({}));
    const store = createDynamoCoreStore({ tableName: "Core", client });
    await store.transact([
      { item: { pk: "W#demo#OPC#NORTE#1", sk: "CLAIM" }, condition: { kind: "absent" } },
      { item: { pk: "W#demo#CUS#cus-1", sk: "LOAN#L-1", version: 3 }, condition: { kind: "version", version: 2 } },
    ]);
    expect(sent[0]?.name).toBe(TransactWriteCommand.name);
    expect(sent[0]?.input).toEqual({
      TransactItems: [
        { Put: { TableName: "Core", Item: { pk: "W#demo#OPC#NORTE#1", sk: "CLAIM" }, ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } } },
        {
          Put: {
            TableName: "Core",
            Item: { pk: "W#demo#CUS#cus-1", sk: "LOAN#L-1", version: 3 },
            ConditionExpression: "#version = :expected",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":expected": 2 },
          },
        },
      ],
    });
  });

  it("turns a failed condition into StoreConflictError and anything else into StoreUnavailableError", async () => {
    const conflict = createDynamoCoreStore({ tableName: "Core", client: fakeClient(() => cancelled(["ConditionalCheckFailed", "None"])).client });
    await expect(conflict.transact([{ item: { pk: "a", sk: "b" }, condition: { kind: "absent" } }])).rejects.toMatchObject({ name: StoreConflictError.name, failed: [0] });
    const throttled = createDynamoCoreStore({ tableName: "Core", client: fakeClient(() => cancelled(["ThrottlingError"])).client });
    await expect(throttled.transact([{ item: { pk: "a", sk: "b" }, condition: { kind: "absent" } }])).rejects.toBeInstanceOf(StoreUnavailableError);
    const down = createDynamoCoreStore({ tableName: "Core", client: fakeClient(() => Object.assign(new Error("x"), { name: "TimeoutError" })).client });
    await expect(down.get("a", "b")).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});
