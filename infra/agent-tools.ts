// The seven tool Lambdas of the agent, one per Gateway target (docs/architecture.md §9.2 and §14,
// docs/tool-catalog.md, docs/build-plan.md WP-31): ToolIdentity, ToolAccount, ToolInvestigation,
// ToolActions, ToolComplaints, ToolMessaging and ToolHandoff. Each one runs
// `packages/bff/src/agent-tools/<target>/handler.handler` (WP-28, WP-29), the `createToolHandler` wrapper
// over that target's tools, which accepts ONLY `{sessionToken, …}` (`LAM-CALLER`). Runtime (Node 22),
// architecture (arm64) and log retention come from the $transform of sst.config.ts; timeout and memory
// from TOOL_LAMBDAS of infra/agentcore-spec.ts; ToolInvestigation keeps a reserved concurrency of 5
// (docs/architecture.md §12).
//
// Least privilege (infra/iam-capabilities.ts). `functionData(fn)` of infra/mocks.ts links the tables,
// buckets and secrets of the entry (with their exact access level, never SST's default) and the mock
// Linkables of MOCK_CORE / MOCK_NETWORK. The rest comes from one Linkable per capability
// (`toolLinkContracts`): PIPELINE brings the outbound gate's links (SES sender, G2, channel modes, phone
// number, demo recipients), SEND_WHATSAPP its statement on the phone number (none while not connected),
// TIMERS the Scheduler of infra/scheduler.ts (late: it imports modules evaluated after this one), ANCHOR
// the AnchorWriter of infra/workers.ts, BEDROCK_READ the ReceiptReader of infra/agentcore-iam.ts.
//
// Who may invoke a target (`LAM-CALLER`, docs/design-brief.md §8.6). Each target's resource policy names
// the Gateway role, the Gateway's only way in. No internal role invokes a target: the worker, the console
// and the QaDriver import the handlers in process, and no Lambda of infra/iam-capabilities.ts holds
// lambda:InvokeFunction on a target (infra/agentcore-spec.test.ts holds this). Every target runs under a
// fixed role name (infra/workers-spec.ts `fixedRoleName`): the six that call a mock are authorised by it
// (`MockCallers`), and `iam get-role` finds the others by name.
//
// Cost: per invocation; nothing bills while the agent is idle.
//
// Verify:
//   aws --profile craftech-demos lambda get-function-configuration --function-name <ToolX physical name>
//     → Timeout and MemorySize of TOOL_LAMBDAS, Role …/aws-cds-hackathon-poc-reclamo-poc-tool-x, no secret in Environment
//   aws --profile craftech-demos lambda get-policy --function-name <ToolX physical name>
//     → lambda:InvokeFunction for …-poc-gateway
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <ToolInvestigation name> → 5

import { ToolTarget } from "../packages/bff/src/agent-tools/common/targets";
import { TOOL_FUNCTIONS, TOOL_LAMBDAS, toolHandlerPath, toolLinkContracts, type ToolLinkContract } from "./agentcore-spec";
import { ReceiptReader, gatewayRole } from "./agentcore-iam";
import { lateLinks, links } from "./late-links";
import { pipelineLinks, sendWhatsAppPermissions } from "./messaging-whatsapp";
import { fixedRole, functionData, grantMockInvoke } from "./mocks";
import { RESERVED_CONCURRENCY } from "./workers-spec";
import { anchorWriter } from "./workers";

/** What each contract adds to `link` beyond `functionData` (the mocks are already there). */
function contractLinks(contract: ToolLinkContract): $util.Input<unknown[]> {
  switch (contract) {
    case "GuardrailG2":
      return pipelineLinks;
    case "Scheduler":
      return lateLinks("agent-tools", "scheduler", () => import("./scheduler"), ["Scheduler"]);
    case "AnchorWriter":
      return [anchorWriter];
    case "ReceiptReader":
      return [ReceiptReader];
    case "EmailSender":
    case "WhatsAppSender":
    case "CoreMock":
    case "NetworkMock":
      return [];
  }
}

function toolFunction(target: ToolTarget): sst.aws.Function {
  const fn = TOOL_FUNCTIONS[target];
  const spec = TOOL_LAMBDAS[target];
  const contracts = toolLinkContracts(fn);
  const data = functionData(fn);
  return new sst.aws.Function(fn, {
    handler: toolHandlerPath(target),
    description: spec.description,
    timeout: `${spec.timeoutSeconds} seconds`,
    memory: `${spec.memoryMb} MB`,
    ...(fn === "ToolInvestigation" ? { concurrency: { reserved: RESERVED_CONCURRENCY.ToolInvestigation } } : {}),
    link: links(data.links, ...[...new Set(contracts)].map(contractLinks)),
    // SendWhatsAppMessage on the secret's phone number id; no statement while it is not connected.
    permissions: contracts.includes("WhatsAppSender")
      ? $util.all([$util.output(data.permissions), sendWhatsAppPermissions]).apply(([granted, whatsApp]) => [...granted, ...whatsApp])
      : data.permissions,
    transform: { role: fixedRole(fn) },
  });
}

/** The seven target Lambdas, in the order infra/agentcore.ts chains their `GatewayTarget`s. */
export const toolFunctions = Object.fromEntries(ToolTarget.options.map((target) => [target, toolFunction(target)])) as Readonly<Record<ToolTarget, sst.aws.Function>>;

/** Resource side of MOCK_CORE / MOCK_NETWORK (infra/mocks.ts): the pair of permissions on each mock a target calls. */
export const toolMockGrants: aws.lambda.Permission[] = ToolTarget.options
  .filter((target) => toolLinkContracts(TOOL_FUNCTIONS[target]).some((contract) => contract === "CoreMock" || contract === "NetworkMock"))
  .flatMap((target) => grantMockInvoke(TOOL_FUNCTIONS[target], toolFunctions[target]));

/** Resource policy of each target: the Gateway role, its only invoker. */
export const toolGatewayInvokePermissions: Readonly<Record<ToolTarget, aws.lambda.Permission>> = Object.fromEntries(
  ToolTarget.options.map((target) => [
    target,
    new aws.lambda.Permission(`${TOOL_FUNCTIONS[target]}InvokeByGateway`, {
      action: "lambda:InvokeFunction",
      function: toolFunctions[target].name,
      principal: gatewayRole.arn,
    }, { dependsOn: [toolFunctions[target]] }),
  ]),
) as Record<ToolTarget, aws.lambda.Permission>;
