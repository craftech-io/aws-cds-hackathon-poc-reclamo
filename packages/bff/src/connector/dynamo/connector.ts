// The connector over DynamoDB, for every Lambda of the stage. Table names come from the linked
// `Resource.<Table>.name` (lib/resource.ts), never from `process.env`; the DocumentClient carries the
// timeouts and SDK retries of lib/clients.ts. One connector per container.
import { createConnector } from "../create";
import type { Connector, ConnectorOptions } from "../port";
import { DynamoStore, type DynamoStoreOptions } from "./engine";

export function createDynamoConnector(options: ConnectorOptions & DynamoStoreOptions = {}): Connector {
  return createConnector(new DynamoStore(options), options);
}

let shared: Connector | undefined;

/** The container-wide connector over the linked tables. */
export function dynamoConnector(): Connector {
  shared ??= createDynamoConnector();
  return shared;
}
