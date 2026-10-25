// The `investigation` target as the local flows and the tests build it: the six tools behind
// `createToolHandler` over the ports they are given. The deployed entry (handler.ts) passes the ports
// linked into `ToolInvestigation`.
import type { Implementations } from "../common/context";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { checkTools } from "./checks";
import { movementTools } from "./movements";
import { type PaymentPorts, paymentTools } from "./payments";
import type { CorePort } from "../account/core";
import type { NetworksPort } from "./movements";
import { INVESTIGATION_TOOLS } from "./schema";

export interface InvestigationPorts extends PaymentPorts {
  readonly core: CorePort;
  readonly networks: NetworksPort;
}

export function investigationImplementations(ports: InvestigationPorts): Implementations<typeof INVESTIGATION_TOOLS> {
  return { ...paymentTools(ports), ...checkTools(ports.core), ...movementTools(ports.core, ports.networks, ports.complaints) };
}

export function createInvestigationTarget(deps: ToolDeps, ports: InvestigationPorts): GatewayTargetRuntime {
  return createToolHandler({ target: "investigation", tools: INVESTIGATION_TOOLS, implementations: investigationImplementations(ports) }, deps);
}
