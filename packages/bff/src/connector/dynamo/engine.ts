// DynamoDB engine of the storage port, over the DocumentClient of lib/clients.ts (timeouts and SDK
// retries with backoff). The only module of the app that sends DynamoDB commands for the BFF
// tables: tools, the worker and the console reach DynamoDB through the connector, never through
// `@aws-sdk/lib-dynamodb` (connector/boundary.test.ts). AWS errors become `ConnectorError`s here, so
// no SDK type crosses the port.
import {
  BatchWriteCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type TransactWriteCommandInput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConnectorError, type ConnectorErrorCode } from "@reclamo/shared";
import { dynamoDocumentClient } from "../../lib/clients";
import { tableName as linkedTableName } from "../../lib/resource";
import { backoffDelayMs } from "../../lib/retry";
import { type CancellationCode, TransactionCancelledError, cancellationCode } from "../errors";
import {
  type BatchRequest,
  type GetOptions,
  type Key,
  MAX_BATCH_REQUESTS,
  type QueryPage,
  type QuerySpec,
  type StoredItem,
  type TableStore,
  type WriteOp,
  normalizeWrite,
  validateBatch,
  validateTransaction,
  validateWrite,
} from "../store";
import { INDEXES, type TableName } from "../tables";
import { ExpressionBuilder, compileCondition, compileKeyCondition, compileUpdate } from "./expressions";

export interface DynamoStoreOptions {
  /** Defaults to the process-wide DocumentClient (lib/clients.ts). */
  readonly client?: DynamoDBDocumentClient;
  /** Physical name of a logical table; defaults to the linked `Resource.<Table>.name`. */
  readonly tableName?: (table: TableName) => string;
  /** Waits between retries of unprocessed batch items (injected by tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Attempts of a batch before its unprocessed items are reported as throttled. */
const BATCH_ATTEMPTS = 5;

const CODE_BY_ERROR_NAME: Readonly<Record<string, ConnectorErrorCode>> = {
  ConditionalCheckFailedException: "CONFLICT",
  TransactionConflictException: "CONFLICT",
  ProvisionedThroughputExceededException: "THROTTLED",
  ThrottlingException: "THROTTLED",
  RequestLimitExceeded: "THROTTLED",
  ValidationException: "VALIDATION",
  TimeoutError: "TIMEOUT",
  RequestTimeout: "TIMEOUT",
  AbortError: "TIMEOUT",
};

/** An AWS SDK error as a `ConnectorError`; anything unknown is `UNAVAILABLE`. */
export function toConnectorError(error: unknown, table?: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TransactionCanceledException") {
    const reasons = ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((reason): CancellationCode => reason.Code ?? "None");
    return new TransactionCancelledError(cancellationCode(reasons), reasons, table, { cause: error });
  }
  const code = CODE_BY_ERROR_NAME[name] ?? ((error as { code?: string }).code === "ETIMEDOUT" ? "TIMEOUT" : "UNAVAILABLE");
  const message = code === "CONFLICT" ? "the conditional request failed" : `DynamoDB ${name || "error"}`;
  return new ConnectorError(code, message, table, { cause: error });
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}

function decodeCursor(cursor: string | undefined, table: TableName): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // falls through to the validation error
  }
  throw new ConnectorError("VALIDATION", "invalid query cursor", table);
}

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export class DynamoStore implements TableStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly physical: (table: TableName) => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DynamoStoreOptions = {}) {
    this.client = options.client ?? dynamoDocumentClient();
    this.physical = options.tableName ?? linkedTableName;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get(table: TableName, key: Key, options: GetOptions = {}): Promise<StoredItem | undefined> {
    try {
      const projection = options.attributes?.length
        ? {
            ProjectionExpression: options.attributes.map((_, index) => `#p${index}`).join(", "),
            ExpressionAttributeNames: Object.fromEntries(options.attributes.map((name, index) => [`#p${index}`, name])),
          }
        : {};
      const output = await this.client.send(new GetCommand({ TableName: this.physical(table), Key: { pk: key.pk, sk: key.sk }, ConsistentRead: options.consistent === true, ...projection }));
      return output.Item as StoredItem | undefined;
    } catch (error) {
      throw toConnectorError(error, table);
    }
  }

  async write(raw: WriteOp): Promise<StoredItem | undefined> {
    const op = normalizeWrite(raw);
    validateWrite(op);
    if (op.kind === "check") throw new ConnectorError("VALIDATION", "a condition check only exists inside a transaction", op.table);
    const item = this.transactItem(op);
    try {
      if (item.Put) {
        await this.client.send(new PutCommand(item.Put));
        return undefined;
      }
      if (item.Delete) {
        await this.client.send(new DeleteCommand(item.Delete));
        return undefined;
      }
      const output = await this.client.send(new UpdateCommand({ ...(item.Update as NonNullable<TransactItem["Update"]>), ReturnValues: "ALL_NEW" }));
      return output.Attributes as StoredItem | undefined;
    } catch (error) {
      throw toConnectorError(error, op.table);
    }
  }

  async transact(raw: readonly WriteOp[]): Promise<void> {
    const ops = raw.map(normalizeWrite);
    validateTransaction(ops);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: ops.map((op) => this.transactItem(op)) }));
    } catch (error) {
      throw toConnectorError(error, ops[0]?.table);
    }
  }

  /** The request of one operation, in the shape both `TransactWriteItems` and the single commands take. */
  private transactItem(op: WriteOp): TransactItem {
    const builder = new ExpressionBuilder();
    const TableName = this.physical(op.table);
    // Compiled once: an expression value that no expression uses makes DynamoDB reject the request.
    const conditionExpression = op.condition ? compileCondition(op.condition, builder) : undefined;
    const condition = conditionExpression === undefined ? {} : { ConditionExpression: conditionExpression };
    switch (op.kind) {
      case "put":
        return { Put: { TableName, Item: { ...op.item }, ...condition, ...builder.attributes() } };
      case "delete":
        return { Delete: { TableName, Key: { pk: op.key.pk, sk: op.key.sk }, ...condition, ...builder.attributes() } };
      case "check":
        return { ConditionCheck: { TableName, Key: { pk: op.key.pk, sk: op.key.sk }, ConditionExpression: conditionExpression as string, ...builder.attributes() } };
      case "update": {
        // The update compiles after the condition so its placeholders follow the condition's.
        const UpdateExpression = compileUpdate(op.update, builder);
        return { Update: { TableName, Key: { pk: op.key.pk, sk: op.key.sk }, UpdateExpression, ...condition, ...builder.attributes() } };
      }
    }
  }

  /** `BatchWriteItem` in chunks of 25; unprocessed items are retried with backoff and jitter. */
  async batchWrite(table: TableName, requests: readonly BatchRequest[]): Promise<void> {
    validateBatch(table, requests);
    const TableName = this.physical(table);
    for (let start = 0; start < requests.length; start += MAX_BATCH_REQUESTS) {
      let pending = requests
        .slice(start, start + MAX_BATCH_REQUESTS)
        .map((request) => ("put" in request ? { PutRequest: { Item: { ...request.put } } } : { DeleteRequest: { Key: { pk: request.delete.pk, sk: request.delete.sk } } }));
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt >= BATCH_ATTEMPTS) throw new ConnectorError("THROTTLED", `${pending.length} batch item(s) stayed unprocessed`, table);
        if (attempt > 0) await this.sleep(backoffDelayMs(attempt));
        try {
          const output = await this.client.send(new BatchWriteCommand({ RequestItems: { [TableName]: pending } }));
          pending = (output.UnprocessedItems?.[TableName] ?? []) as typeof pending;
        } catch (error) {
          throw toConnectorError(error, table);
        }
      }
    }
  }

  async query(spec: QuerySpec): Promise<QueryPage> {
    const index = spec.index === undefined ? undefined : INDEXES[spec.table][spec.index];
    if (spec.index !== undefined && !index) throw new ConnectorError("VALIDATION", `${spec.table} has no index ${spec.index}`, spec.table);
    if (index && spec.consistent) throw new ConnectorError("VALIDATION", "a consistent read is not supported on a global secondary index", spec.table);
    const builder = new ExpressionBuilder();
    const KeyConditionExpression = compileKeyCondition(index ? index.partition : "pk", spec.partition, index ? index.sort : "sk", spec.sort, builder);
    const startKey = decodeCursor(spec.cursor, spec.table);
    try {
      const output = await this.client.send(
        new QueryCommand({
          TableName: this.physical(spec.table),
          ...(spec.index !== undefined ? { IndexName: spec.index } : {}),
          KeyConditionExpression,
          ...builder.attributes(),
          ScanIndexForward: spec.descending !== true,
          ...(spec.limit !== undefined ? { Limit: spec.limit } : {}),
          ...(spec.consistent ? { ConsistentRead: true } : {}),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      const cursor = encodeCursor(output.LastEvaluatedKey);
      return { items: (output.Items ?? []) as StoredItem[], ...(cursor ? { cursor } : {}) };
    } catch (error) {
      throw toConnectorError(error, spec.table);
    }
  }
}
