// DynamoDB adapter of the core's store (table `Core`, docs/architecture.md §5). Base-table reads are
// strongly consistent: a money route reads the rows it is about to condition on. A change is one
// `TransactWriteItems` of conditional `Put`s; a failed condition becomes `StoreConflictError` (the
// ledger re-reads and decides), throttling, timeouts and outages become `StoreUnavailableError`
// (the mock answers 503 and the client retries).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type CoreStore, MAX_TRANSACTION_WRITES, type PutWrite, StoreConflictError, type StoredItem, StoreUnavailableError } from "./port";

export type DocumentSender = Pick<DynamoDBDocumentClient, "send">;

/** Physical names of the indexes this adapter queries (infra/storage-keys.ts). */
const BY_OPERATION_CODE = "ByOperationCode";
const WORLD_INDEX = "WorldIndex";
/** A customer partition holds a few hundred items; this bounds a runaway query, not a real one. */
const MAX_PAGES = 20;

/** DynamoDB answers in milliseconds; past two seconds an attempt is an outage (3 SDK attempts). */
export function coreDocumentClient(): DynamoDBDocumentClient {
  const base = new DynamoDBClient({ maxAttempts: 3, requestHandler: { requestTimeout: 2_000, connectionTimeout: 1_000 } });
  return DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false } });
}

function cancellationCodes(error: Error): string[] {
  const reasons: unknown = Reflect.get(error, "CancellationReasons");
  if (!Array.isArray(reasons)) return [];
  return reasons.map((reason: unknown) => (typeof reason === "object" && reason !== null ? String(Reflect.get(reason, "Code") ?? "None") : "None"));
}

function translate(error: unknown, operation: string): Error {
  if (error instanceof StoreConflictError || error instanceof StoreUnavailableError) return error;
  if (error instanceof Error && error.name === "TransactionCanceledException") {
    const codes = cancellationCodes(error);
    const failed = codes.flatMap((code, index) => (code === "ConditionalCheckFailed" ? [index] : []));
    if (failed.length > 0) return new StoreConflictError(failed, { cause: error });
  }
  const name = error instanceof Error ? error.name : "UnknownError";
  return new StoreUnavailableError(`${operation}: ${name}`, { cause: error });
}

async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translate(error, operation);
  }
}

function conditionOf(write: PutWrite): { ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
  if (write.condition.kind === "absent") return { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } };
  return {
    ConditionExpression: "#version = :expected",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":expected": write.condition.version },
  };
}

export function createDynamoCoreStore(options: { readonly tableName: string; readonly client: DocumentSender }): CoreStore {
  const { tableName, client } = options;

  async function queryAll(input: { index?: string; keyAttribute: string; key: string; skPrefix?: string; consistent: boolean; limit?: number }): Promise<StoredItem[]> {
    const items: StoredItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const prefixed = input.skPrefix !== undefined && input.skPrefix !== "";
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          ...(input.index === undefined ? {} : { IndexName: input.index }),
          KeyConditionExpression: prefixed ? "#k = :k AND begins_with(#sk, :prefix)" : "#k = :k",
          ExpressionAttributeNames: prefixed ? { "#k": input.keyAttribute, "#sk": "sk" } : { "#k": input.keyAttribute },
          ExpressionAttributeValues: prefixed ? { ":k": input.key, ":prefix": input.skPrefix } : { ":k": input.key },
          ConsistentRead: input.consistent,
          ...(input.limit === undefined ? {} : { Limit: input.limit }),
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      items.push(...((result.Items ?? []) as StoredItem[]));
      startKey = result.LastEvaluatedKey;
      if (startKey === undefined || (input.limit !== undefined && items.length >= input.limit)) return items;
    }
    throw new StoreUnavailableError(`query of ${input.key} exceeded ${MAX_PAGES} pages`);
  }

  return {
    get: (pk, sk) =>
      guarded("get", async () => {
        const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }));
        return result.Item as StoredItem | undefined;
      }),

    query: (pk, skPrefix) => guarded("query", () => queryAll({ keyAttribute: "pk", key: pk, consistent: true, ...(skPrefix === undefined ? {} : { skPrefix }) })),

    queryByOperationCode: (opCodeKey) =>
      guarded("queryByOperationCode", () => queryAll({ index: BY_OPERATION_CODE, keyAttribute: "opCodeKey", key: opCodeKey, consistent: false })),

    worldHasItems: (worldId) =>
      guarded("worldHasItems", async () => {
        const items = await queryAll({ index: WORLD_INDEX, keyAttribute: "worldIndexKey", key: `W#${worldId}#`, consistent: false, limit: 1 });
        return items.length > 0;
      }),

    transact: (writes) =>
      guarded("transact", async () => {
        if (writes.length === 0) return;
        if (writes.length > MAX_TRANSACTION_WRITES) throw new RangeError(`a transaction holds at most ${MAX_TRANSACTION_WRITES} writes`);
        await client.send(new TransactWriteCommand({ TransactItems: writes.map((write) => ({ Put: { TableName: tableName, Item: write.item, ...conditionOf(write) } })) }));
      }),
  };
}
