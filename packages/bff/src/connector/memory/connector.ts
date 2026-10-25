// The connector over the in-memory engine: local flows (`LF`), the local UI server and unit tests.
// The store is returned too, so a test can seed rows, inspect them or race a writer.
import { createConnector } from "../create";
import type { Connector, ConnectorOptions } from "../port";
import { MemoryStore, type MemoryStoreOptions } from "./engine";

export interface MemoryConnector {
  readonly connector: Connector;
  readonly store: MemoryStore;
}

export function createMemoryConnector(options: ConnectorOptions & MemoryStoreOptions = {}): MemoryConnector {
  const store = new MemoryStore(options);
  return { connector: createConnector(store, options), store };
}
