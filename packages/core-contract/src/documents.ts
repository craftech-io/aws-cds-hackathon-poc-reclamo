// The two OpenAPI documents of the package and their zod side: `npm run core:contract`
// (scripts/core/contract-check.ts) compares each YAML with its registry and its route table.
import { coreRoutes } from "./core-routes";
import { networksRoutes } from "./networks-routes";
import { type ComponentRegistry, coreRegistry, networksRegistry } from "./registry";
import type { RouteTable } from "./routes";

export interface ContractDocument {
  /** File name next to this package's package.json. */
  readonly file: string;
  readonly registry: ComponentRegistry;
  readonly routes: RouteTable;
}

export const coreContract: ContractDocument = { file: "core.openapi.yaml", registry: coreRegistry, routes: coreRoutes };
export const networksContract: ContractDocument = { file: "networks.openapi.yaml", registry: networksRegistry, routes: networksRoutes };

export const CONTRACT_DOCUMENTS: readonly ContractDocument[] = [coreContract, networksContract];
