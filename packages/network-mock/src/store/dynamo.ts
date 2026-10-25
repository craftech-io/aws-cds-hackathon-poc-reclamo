// `NetworkStore` over the DynamoDB table `Networks` (docs/architecture.md §5). Reads are strongly
// consistent; every write is conditional and atomic: a collection is one `TransactWriteItems`
// (claim of each code + line + batch), a reversal is one (`TRV#` claim + transfer status), and a
// batch moves `PENDING` → `PUBLISHED` only at the version the publisher read. A condition that fails
// is an outcome (`CODE_TAKEN`, `STALE`), never an exception; anything else from DynamoDB is
// `NetworkUnavailableError` (503, the caller retries).
import { type DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { CollectionNetwork } from "@reclamo/core-contract";
import { NetworkUnavailableError } from "../errors";
import { Fault } from "../faults";
import { FaultsItem, type Key, NetworkWorld, ReversalClaim, StoredBatch, StoredLine, StoredTransfer, fromRaw, items, keys } from "./items";
import type { CollectionWrite, NetworkStore, Publication, WriteOutcome } from "./port";

type Raw = Record<string, unknown>;

export interface DynamoNetworkStoreOptions {
  readonly client: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
  /** Real time, only for the stamps and the TTL of what is written. */
  readonly realNow?: () => Date;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/** Which items of a cancelled transaction failed their condition. */
function cancelledIndexes(error: unknown): number[] {
  const reasons: unknown = Reflect.get(error as object, "CancellationReasons");
  if (!Array.isArray(reasons)) return [];
  return reasons.flatMap((reason: unknown, index) => (Reflect.get(reason as object, "Code") === "ConditionalCheckFailed" ? [index] : []));
}

function unavailable(error: unknown): NetworkUnavailableError {
  return new NetworkUnavailableError("the network store is unavailable", { cause: error });
}

/** `SET #f0 = :v0, …` for every field, plus the version bump guarded by the expected version. */
interface ExtraCondition {
  readonly expression: string;
  readonly names: Record<string, string>;
  readonly values: Raw;
}

function versionedUpdate(fields: Raw, expectVersion: number, extraCondition?: ExtraCondition) {
  const names: Record<string, string> = { "#version": "version", ...extraCondition?.names };
  const values: Raw = { ":expected": expectVersion, ":next": expectVersion + 1, ...extraCondition?.values };
  const sets = ["#version = :next"];
  Object.entries(fields).forEach(([name, value], index) => {
    if (name === "version" || value === undefined) return;
    names[`#f${index}`] = name;
    values[`:v${index}`] = value;
    sets.push(`#f${index} = :v${index}`);
  });
  const condition = ["#version = :expected", ...(extraCondition ? [extraCondition.expression] : [])].join(" AND ");
  return { UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}

export function createDynamoNetworkStore(options: DynamoNetworkStoreOptions): NetworkStore {
  const { client, tableName } = options;
  const realNow = options.realNow ?? (() => new Date());

  async function get(key: Key): Promise<Raw | undefined> {
    try {
      const result = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
      return result.Item;
    } catch (error) {
      throw unavailable(error);
    }
  }

  async function query(pk: string, from: string, to: string): Promise<Raw[]> {
    const out: Raw[] = [];
    let cursor: Raw | undefined;
    try {
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
            ExpressionAttributeValues: { ":pk": pk, ":from": from, ":to": to },
            ConsistentRead: true,
            ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
          }),
        );
        out.push(...(page.Items ?? []));
        cursor = page.LastEvaluatedKey;
      } while (cursor !== undefined);
    } catch (error) {
      throw unavailable(error);
    }
    return out;
  }

  async function update(key: Key, fields: Raw, expectVersion: number, extra?: ExtraCondition): Promise<WriteOutcome> {
    try {
      await client.send(new UpdateCommand({ TableName: tableName, Key: key, ...versionedUpdate({ ...fields, updatedAt: realNow().toISOString() }, expectVersion, extra) }));
      return "OK";
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return "STALE";
      throw unavailable(error);
    }
  }

  const pending: ExtraCondition = { expression: "#status = :pending", names: { "#status": "status" }, values: { ":pending": "PENDING" } };

  return {
    async getWorld(worldId) {
      const raw = await get(keys.config(worldId));
      return raw === undefined ? undefined : fromRaw(NetworkWorld, raw);
    },
    async getFaults(worldId) {
      const raw = await get(keys.faults(worldId));
      return raw === undefined ? [] : fromRaw(FaultsItem, raw).faults.map((fault) => Fault.parse(fault));
    },
    async getBatch(worldId, network, businessDate) {
      const raw = await get(keys.batch(worldId, network, businessDate));
      return raw === undefined ? undefined : fromRaw(StoredBatch, raw);
    },
    async listBatches(worldId, network, from, to) {
      const raws = await query(keys.network(worldId, network), keys.batch(worldId, network, from).sk, keys.batch(worldId, network, to).sk);
      return raws.map((raw) => fromRaw(StoredBatch, raw));
    },
    async listLines(worldId, network, businessDate) {
      const start = keys.linePrefix(businessDate);
      return (await query(keys.network(worldId, network), start, `${start}￿`)).map((raw) => fromRaw(StoredLine, raw));
    },
    async getCodeClaim(worldId, network: CollectionNetwork, operationCode) {
      const raw = await get(keys.operationCode(worldId, network, operationCode));
      return raw === undefined ? undefined : fromRaw(StoredLine, raw);
    },
    async writeCollection(write: CollectionWrite) {
      const now = realNow();
      const batchKey = keys.batch(write.worldId, write.network, write.businessDate);
      const batchItem =
        "create" in write.batch
          ? { Put: { TableName: tableName, Item: items.batch(write.batch.create, now), ConditionExpression: "attribute_not_exists(pk)" } }
          : { Update: { TableName: tableName, Key: batchKey, ...versionedUpdate({ updatedAt: now.toISOString() }, write.batch.expectVersion, pending) } };
      const claims = write.lines.map((line) => ({ Put: { TableName: tableName, Item: items.operationCode(line, now), ConditionExpression: "attribute_not_exists(pk)" } }));
      const lines = write.lines.map((line) => ({ Put: { TableName: tableName, Item: items.line(line, now) } }));
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [batchItem, ...claims, ...lines] }));
        return "OK";
      } catch (error) {
        if (errorName(error) !== "TransactionCanceledException") throw unavailable(error);
        const failed = cancelledIndexes(error);
        if (failed.includes(0)) return "STALE";
        if (failed.some((index) => index >= 1 && index <= claims.length)) return "CODE_TAKEN";
        throw unavailable(error);
      }
    },
    async deferBatch(batch, publishAtSim) {
      return update(keys.batch(batch.worldId, batch.network, batch.businessDate), { publishAtSim, deferred: true }, batch.version, pending);
    },
    async markPublished(batch, publication: Publication) {
      return update(keys.batch(batch.worldId, batch.network, batch.businessDate), { ...publication, status: "PUBLISHED" }, batch.version, pending);
    },
    async getTransfer(worldId, transferId) {
      const raw = await get(keys.transfer(worldId, transferId));
      return raw === undefined ? undefined : fromRaw(StoredTransfer, raw);
    },
    async updateTransfer(next, expectVersion) {
      const parsed = StoredTransfer.parse(next);
      return update(keys.transfer(parsed.worldId, parsed.transferId), parsed, expectVersion);
    },
    async getReversalClaim(worldId, transferId) {
      const raw = await get(keys.reversalClaim(worldId, transferId));
      return raw === undefined ? undefined : fromRaw(ReversalClaim, raw);
    },
    async reverseTransfer(claim, next, expectVersion) {
      const now = realNow();
      const parsed = StoredTransfer.parse(next);
      const transferUpdate = versionedUpdate({ ...parsed, updatedAt: now.toISOString() }, expectVersion);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: tableName, Item: items.reversalClaim(claim, now), ConditionExpression: "attribute_not_exists(pk)" } },
              { Update: { TableName: tableName, Key: keys.transfer(parsed.worldId, parsed.transferId), ...transferUpdate } },
            ],
          }),
        );
        return "OK";
      } catch (error) {
        if (errorName(error) !== "TransactionCanceledException") throw unavailable(error);
        const failed = cancelledIndexes(error);
        if (failed.includes(0)) return "CODE_TAKEN";
        if (failed.includes(1)) return "STALE";
        throw unavailable(error);
      }
    },
  };
}
