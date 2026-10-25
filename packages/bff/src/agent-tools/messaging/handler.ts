// Lambda entry of `ToolMessaging` (docs/architecture.md §9.2): the infra points the Function at
// `packages/bff/src/agent-tools/messaging/handler.handler`. The deployed entry accepts only a Gateway call
// with the turn's token (`LAM-CALLER`) and sends through the imported `sendThroughGate`, the one path out
// (ADR-0006); `createMessagingTarget` takes another gate in the local flows and the tests.
import { dynamoConnector } from "../../connector/dynamo/connector";
import { linkedCoreClient } from "../../core/linked";
import { createLogger } from "../../lib/log";
import { sendThroughGate } from "../../outbound/gate";
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { coreLoanOwnership } from "./ownership";
import { MESSAGING_TOOLS } from "./schema";
import { type MessagingPorts, sendWhatsAppTool } from "./send-whatsapp";

export function messagingImplementations(ports: MessagingPorts): Implementations<typeof MESSAGING_TOOLS> {
  return { send_whatsapp: sendWhatsAppTool(ports) };
}

export function createMessagingTarget(deps: ToolDeps, ports: MessagingPorts = { gate: sendThroughGate }): GatewayTargetRuntime {
  return createToolHandler({ target: "messaging", tools: MESSAGING_TOOLS, implementations: messagingImplementations(ports) }, deps);
}

export const handler = lambdaEntry(createMessagingTarget, () => coreLoanOwnership(dynamoConnector(), linkedCoreClient, createLogger({ bindings: { service: "agent-tools", target: "messaging" } })));
