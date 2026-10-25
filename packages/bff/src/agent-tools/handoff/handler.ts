// Lambda entry of `ToolHandoff` (docs/architecture.md §9.2): the infra points the Function at
// `packages/bff/src/agent-tools/handoff/handler.handler`. The deployed entry accepts only a Gateway call
// with the turn's token (`LAM-CALLER`) and sends through the imported `sendThroughGate`;
// `createHandoffTarget` takes other ports in the local flows and the tests. No tool here approves.
import { sendThroughGate } from "../../outbound/gate";
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { NO_CORE_OWNERSHIP, stageComplaintsDeps } from "../actions/stage";
import { requestOperatorApprovalTool } from "./approval";
import { escalateToHumanTool } from "./escalate";
import type { HandoffPorts } from "./ports";
import { HANDOFF_TOOLS } from "./schema";

export function handoffImplementations(ports: HandoffPorts): Implementations<typeof HANDOFF_TOOLS> {
  return {
    escalate_to_human: escalateToHumanTool(ports),
    request_operator_approval: requestOperatorApprovalTool(ports),
  };
}

export function stageHandoffPorts(deps: Pick<ToolDeps, "connector">): HandoffPorts {
  return { gate: sendThroughGate, complaints: stageComplaintsDeps(deps.connector) };
}

export function createHandoffTarget(deps: ToolDeps, ports: HandoffPorts = stageHandoffPorts(deps)): GatewayTargetRuntime {
  return createToolHandler({ target: "handoff", tools: HANDOFF_TOOLS, implementations: handoffImplementations(ports) }, deps);
}

export const handler = lambdaEntry(createHandoffTarget, () => NO_CORE_OWNERSHIP);
