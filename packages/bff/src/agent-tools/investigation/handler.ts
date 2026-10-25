// Lambda entry of `ToolInvestigation` (docs/architecture.md §9.2): infra points the function at
// `handler`, over the ports linked into the Lambda (ports.ts), resolved on first use.
import { lambdaEntry } from "../common/deps";
import type { GatewayTargetRuntime, ToolDeps } from "../common/handler";
import { productionOwnership } from "../account/ownership";
import { productionInvestigationPorts } from "./ports";
import { createInvestigationTarget } from "./target";

export function stageInvestigationTarget(deps: ToolDeps): GatewayTargetRuntime {
  return createInvestigationTarget(deps, productionInvestigationPorts());
}

export const handler = lambdaEntry(stageInvestigationTarget, productionOwnership);
