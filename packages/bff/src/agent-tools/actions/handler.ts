// Lambda entry of `ToolActions` (docs/architecture.md §9.2): the infra points the Function at
// `packages/bff/src/agent-tools/actions/handler.handler`. The deployed entry accepts only a Gateway call
// with the turn's token (`LAM-CALLER`, common/handler.ts). `createActionsTarget` is what the local flows
// and the tests build the target with, over the memory connector and the in-process mocks.
import { linkedCoreClient } from "../../core/linked";
import { linkedNetworkClient } from "../../networks/linked";
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { freezeOutgoing, requestAccountClosure, requestDataChange } from "./account-actions";
import { moneyImplementations } from "./money";
import type { ActionPorts } from "./ports";
import { ACTIONS_TOOLS } from "./schema";
import { NO_CORE_OWNERSHIP, stageComplaintsDeps } from "./stage";

export function actionsImplementations(ports: ActionPorts): Implementations<typeof ACTIONS_TOOLS> {
  return {
    ...moneyImplementations(ports),
    freeze_outgoing: freezeOutgoing(ports),
    request_account_closure: requestAccountClosure(ports),
    request_data_change: requestDataChange(ports),
  };
}

/** The ports of the stage: the linked core and networks, complaints/ over the tool's connector. */
export function stageActionPorts(deps: Pick<ToolDeps, "connector">): ActionPorts {
  return { core: linkedCoreClient, networks: linkedNetworkClient, complaints: stageComplaintsDeps(deps.connector) };
}

export function createActionsTarget(deps: ToolDeps, ports: ActionPorts = stageActionPorts(deps)): GatewayTargetRuntime {
  return createToolHandler({ target: "actions", tools: ACTIONS_TOOLS, implementations: actionsImplementations(ports) }, deps);
}

export const handler = lambdaEntry(createActionsTarget, () => NO_CORE_OWNERSHIP);
