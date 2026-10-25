// The `identity` target as the worker's preload, the local flows and the tests build it: the two tools
// behind `createToolHandler` over the ports they are given. The deployed entry (handler.ts) passes the
// ports linked into `ToolIdentity`.
import type { Implementations } from "../common/context";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { IDENTITY_TOOLS } from "./schema";
import { type IdentityPorts, identityTools } from "./tools";

export function identityImplementations(ports: IdentityPorts): Implementations<typeof IDENTITY_TOOLS> {
  return identityTools(ports);
}

export function createIdentityTarget(deps: ToolDeps, ports: IdentityPorts): GatewayTargetRuntime {
  return createToolHandler({ target: "identity", tools: IDENTITY_TOOLS, implementations: identityImplementations(ports) }, deps);
}
