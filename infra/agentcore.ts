// Bedrock AgentCore: the agent as resources (docs/architecture.md §4, §9 and §12, docs/design-brief.md
// §8.3-§8.6, ADR-0021 §6, docs/build-plan.md WP-31). Names, models, limits, strategies and verified service
// facts: infra/agentcore-spec.ts; model profile, Linkables of the models and roles: infra/agentcore-iam.ts;
// tool Lambdas: infra/agent-tools.ts; schemas: infra/agent-tool-schemas.ts; Cedar: infra/policy.ts; G1:
// infra/guardrail.ts.
//
//   Memory      `aws_cds_hackathon_poc_reclamo_poc`, events 30 days, three custom strategies with the same
//               exclusion rules: `customerPreferences` (userPreference override, JSON with enumerated
//               fields only), `customerFacts` (semantic) and `conversationSummary` (summary), all per actor
//               `w-<worldId>-<customerId>-e<worldEpoch>` (passed by the worker on every invocation), all on
//               the agent's application profile. The worker retrieves (Linkable `Harness`); the Harness only
//               writes and reads the events of its sessions.
//   Gateway     `aws-cds-hackathon-poc-reclamo-poc`, MCP, `AWS_IAM`, called only by the Harness role; the
//               policy engine of infra/policy.ts in ENFORCE.
//   Targets     identity, account, investigation, actions, complaints, messaging, handoff: Lambda + inline
//               schema, created ONE AT A TIME (Cloud Control rejects concurrent target writes on a gateway)
//               through a dependsOn chain, with ignoreChanges (a changed schema is pushed by
//               scripts/agent/push-gateway-schemas.ts before the deploy).
//   Policies    the CED-* statements, attached after the LAST target: permits first, then every forbid
//               after all of them (the engine validates each statement against the Gateway's schemas).
//   Harness     the application profile of global.anthropic.claude-sonnet-5-5 over converse_stream with G1
//               in the model parameters; maxIterations 12, maxTokens 4096, timeout 120 s, sliding window 40;
//               tools = the Gateway only (`@reclamo-tools/*`); the default system prompt of
//               packages/bff/src/agent/system-prompt.ts (the worker sends the turn's own); public network,
//               idle microVMs stopped after 5 minutes. Created after the last forbid, so no turn ever runs
//               without the fences. No prompt-caching field exists to set (PROMPT_CACHING).
//   Log group   `/aws/bedrock-agentcore/runtimes/<runtimeId>-live`, 30 days, created after the Harness and
//               before the endpoint (never the DEFAULT one, which AgentCore creates: §17 item 9).
//   Endpoint    `live`, pinned to the Harness version of this deploy.
//
// Chain, held by infra/agentcore-spec.test.ts: targets in series → permits → forbids → Harness → log group
// → endpoint.
//
// What code links:
//   Harness        `Resource.Harness.{harnessArn, endpointName, memoryId, …}`, InvokeHarness and
//                  InvokeAgentRuntime on the harness, its endpoint and its runtime, RetrieveMemoryRecords on
//                  the Memory: the three event workers (late link of infra/workers.ts), the only holders.
//   Agent          `Resource.Agent.memoryId` and the namespaces, with MEMORY_ADMIN on this Memory: the roles
//                  that hold WORLDS (infra/bff.ts) for the purge.
//   Classifier     re-exported from infra/agentcore-iam.ts for InboundWhatsApp (late link).
//
// Cost: per model token, Gateway call, policy evaluation, Memory event and record; nothing bills while idle.
//
// Verify (AWS CLI ≥ 2.27, or the SDK v3 scripts, docs/architecture.md §16):
//   aws --profile craftech-demos bedrock-agentcore-control list-harnesses                                  → READY
//   aws --profile craftech-demos bedrock-agentcore-control list-gateway-targets --gateway-identifier <id>  → 7 READY
//   aws --profile craftech-demos bedrock-agentcore-control get-memory --memory-id <id>                     → ACTIVE, 3 strategies
//   aws --profile craftech-demos logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/harness_aws_cds_hackathon_poc_reclamo_poc
//     → <runtimeId>-live with retentionInDays 30 (-DEFAULT: 30 days by §17 item 9)

import { DEFAULT_SYSTEM_PROMPT } from "../packages/bff/src/agent/system-prompt";
import { ToolTarget } from "../packages/bff/src/agent-tools/common/targets";
import { gatewayInlinePayloads, gatewayToolSchemas } from "./agent-tool-schemas";
import { toolFunctions, toolGatewayInvokePermissions } from "./agent-tools";
import { agentModelProfile, createGatewayRolePolicy, createHarnessRolePolicy, gatewayRole, harnessRole, memoryRole, memoryRolePolicy } from "./agentcore-iam";
import {
  AGENT_LINK,
  AGENT_LOG_RETENTION_DAYS,
  GATEWAY_TOOL_NAME,
  HARNESS_ALLOWED_TOOLS,
  HARNESS_ENDPOINT_NAME,
  HARNESS_INVOKE_ACTIONS,
  HARNESS_LIFECYCLE,
  HARNESS_LIMITS,
  HARNESS_LINK,
  MEMORY_EVENT_EXPIRY_DAYS,
  MEMORY_STRATEGIES,
  WORKER_MEMORY_ACTIONS,
  gatewayName,
  gatewayTargetDescription,
  gatewayTargetIgnoreChanges,
  harnessBedrockModelConfig,
  harnessName,
  memoryName,
  memoryStrategyArgs,
  runtimeLogGroupEndpoints,
  runtimeLogGroupName,
  textDigest,
} from "./agentcore-spec";
import { g1, harnessGuardrailConfig } from "./guardrail";
import { CAPABILITIES } from "./iam-capabilities";
import { GATEWAY_POLICY_ENGINE_MODE, attachGatewayPolicies, policyEngineArn } from "./policy";
import { tagList, tagMap } from "./tags";

export { Classifier } from "./agentcore-iam";

const pascal = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;

// ---- Memory ------------------------------------------------------------------------------------------

export const memory = new awsnative.bedrockagentcore.Memory(
  "AgentMemory",
  {
    name: memoryName($app.name, $app.stage),
    description: `Customer preferences, facts and conversation summaries of the ${$app.name} agent, stage ${$app.stage}.`,
    eventExpiryDuration: MEMORY_EVENT_EXPIRY_DAYS,
    memoryExecutionRoleArn: memoryRole.arn,
    memoryStrategies: agentModelProfile.arn.apply(memoryStrategyArgs),
    tags: tagMap(),
  },
  { dependsOn: [memoryRolePolicy] },
);

// ---- Gateway and its targets -------------------------------------------------------------------------

const gatewayRolePolicy = createGatewayRolePolicy({ functionArns: ToolTarget.options.map((target) => toolFunctions[target].arn), policyEngineArn });

export const gateway = new awsnative.bedrockagentcore.Gateway(
  "AgentGateway",
  {
    name: gatewayName($app.name, $app.stage),
    description: `MCP tools of the ${$app.name} agent (${$app.stage}); called only by the Harness execution role.`,
    authorizerType: "AWS_IAM",
    protocolType: "MCP",
    roleArn: gatewayRole.arn,
    policyEngineConfiguration: { arn: policyEngineArn, mode: GATEWAY_POLICY_ENGINE_MODE },
    tags: tagMap(),
  },
  // The Gateway evaluates Cedar and invokes the targets with its role: without the policy the first call fails.
  { dependsOn: [gatewayRolePolicy] },
);

const targets: awsnative.bedrockagentcore.GatewayTarget[] = [];
// The first target waits for both sides of invoking the Lambdas: the role's policy and each target's resource policy.
let previous: $util.Resource[] = [gatewayRolePolicy, ...Object.values(toolGatewayInvokePermissions)];

for (const target of ToolTarget.options) {
  const { inlinePayload, digest } = gatewayToolSchemas[target];
  const created = new awsnative.bedrockagentcore.GatewayTarget(
    `AgentGatewayTarget${pascal(target)}`,
    {
      gatewayIdentifier: gateway.gatewayIdentifier,
      // Cedar action ids are `<name>___<tool>` (infra/policy-rules.ts): the name is the target id.
      name: target,
      description: gatewayTargetDescription(target, inlinePayload.length, digest),
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: { mcp: { lambda: { lambdaArn: toolFunctions[target].arn, toolSchema: { inlinePayload } } } },
    },
    { dependsOn: previous, ignoreChanges: gatewayTargetIgnoreChanges() },
  );
  targets.push(created);
  previous = [created];
}

export const gatewayTargets: readonly awsnative.bedrockagentcore.GatewayTarget[] = targets;

/** The CED-* policies after the last target: permits first, then the forbids (infra/policy.ts). */
export const gatewayPolicies = attachGatewayPolicies({
  gatewayArn: gateway.gatewayArn,
  harnessRoleName: harnessRole.name,
  targetNames: ToolTarget.options,
  toolSchemas: gatewayInlinePayloads,
  dependsOn: previous,
});

// ---- Harness, its runtime log group and the endpoint --------------------------------------------------

const harnessRolePolicy = createHarnessRolePolicy({ modelProfileArn: agentModelProfile.arn, gatewayArn: gateway.gatewayArn, memoryArn: memory.memoryArn, guardrailArn: g1.guardrailArn });

export const harness = new awsnative.bedrockagentcore.Harness(
  "AgentHarness",
  {
    harnessName: harnessName($app.name, $app.stage),
    executionRoleArn: harnessRole.arn,
    // G1 on every model call (infra/guardrail.ts); the turn's own prompt comes from the worker.
    model: { bedrockModelConfig: harnessBedrockModelConfig(agentModelProfile.arn, harnessGuardrailConfig) },
    systemPrompt: [{ text: DEFAULT_SYSTEM_PROMPT }],
    environment: {
      agentCoreRuntimeEnvironment: {
        networkConfiguration: { networkMode: "PUBLIC" },
        lifecycleConfiguration: { idleRuntimeSessionTimeout: HARNESS_LIFECYCLE.idleRuntimeSessionTimeoutSeconds, maxLifetime: HARNESS_LIFECYCLE.maxLifetimeSeconds },
      },
    },
    tools: [{ type: "agentcore_gateway", name: GATEWAY_TOOL_NAME, config: { agentCoreGateway: { gatewayArn: gateway.gatewayArn, outboundAuth: { awsIam: {} } } } }],
    allowedTools: [...HARNESS_ALLOWED_TOOLS],
    maxIterations: HARNESS_LIMITS.maxIterations,
    maxTokens: HARNESS_LIMITS.maxTokens,
    timeoutSeconds: HARNESS_LIMITS.timeoutSeconds,
    truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: HARNESS_LIMITS.slidingWindowMessages } } },
    // Short-term events only: no retrievalConfig, the worker retrieves long-term memory (docs/architecture.md §9.1).
    memory: { agentCoreMemoryConfiguration: { arn: memory.memoryArn } },
    tags: tagList({ SystemPromptDigest: textDigest(DEFAULT_SYSTEM_PROMPT) }),
  },
  { dependsOn: [harnessRolePolicy, ...gatewayPolicies] },
);

/** The AgentCore Runtime under the Harness: its id names the runtime log groups. */
const runtimeEnvironment = harness.environment.apply((environment) => {
  const runtime = environment?.agentCoreRuntimeEnvironment;
  if (runtime?.agentRuntimeId === undefined || runtime.agentRuntimeId === "") {
    throw new Error("The Harness state has no environment.agentCoreRuntimeEnvironment.agentRuntimeId, so the log group of the live endpoint cannot be named before it.");
  }
  return { id: runtime.agentRuntimeId, arn: runtime.agentRuntimeArn };
});

/** Created before the endpoint, so AgentCore never creates it first (with no retention). */
export const harnessLogGroups: aws.cloudwatch.LogGroup[] = runtimeLogGroupEndpoints(HARNESS_ENDPOINT_NAME).map(
  (endpoint) =>
    new aws.cloudwatch.LogGroup(
      `HarnessRuntimeLogs${pascal(endpoint)}`,
      { name: runtimeEnvironment.apply((runtime) => runtimeLogGroupName(runtime.id, endpoint)), retentionInDays: AGENT_LOG_RETENTION_DAYS },
      { dependsOn: [harness] },
    ),
);

export const harnessEndpoint = new awsnative.bedrockagentcore.HarnessEndpoint(
  "AgentHarnessEndpoint",
  {
    harnessId: harness.harnessId,
    endpointName: HARNESS_ENDPOINT_NAME,
    description: `Endpoint the event workers invoke; follows the Harness version of each deploy (${$app.stage}).`,
    targetVersion: harness.version,
    tags: tagList(),
  },
  { dependsOn: [harness, ...harnessLogGroups] },
);

// ---- Links -------------------------------------------------------------------------------------------

/** The three event workers (late link of infra/workers.ts): invoke the Harness and retrieve long-term memory. */
export const Harness = new sst.Linkable(HARNESS_LINK, {
  properties: {
    harnessArn: harness.arn,
    harnessId: harness.harnessId,
    endpointName: HARNESS_ENDPOINT_NAME,
    endpointArn: harnessEndpoint.arn,
    memoryId: memory.memoryId,
    timeoutSeconds: HARNESS_LIMITS.timeoutSeconds,
    maxIterations: HARNESS_LIMITS.maxIterations,
  },
  include: [
    sst.aws.permission({
      actions: [...HARNESS_INVOKE_ACTIONS],
      // One element per ARN; without a runtime ARN the third repeats the Harness.
      resources: [harness.arn, harnessEndpoint.arn, $util.all([harness.arn, runtimeEnvironment]).apply(([harnessArn, runtime]) => runtime.arn ?? harnessArn)],
    }),
    sst.aws.permission({ actions: [...WORKER_MEMORY_ACTIONS], resources: [memory.memoryArn] }),
  ],
});

/** The roles that hold WORLDS (purge): the Memory's id, its namespaces and MEMORY_ADMIN on it. */
export const Agent = new sst.Linkable(AGENT_LINK, {
  properties: {
    memoryId: memory.memoryId,
    memoryArn: memory.memoryArn,
    preferencesNamespace: MEMORY_STRATEGIES.customerPreferences.namespace,
    factsNamespace: MEMORY_STRATEGIES.customerFacts.namespace,
    summaryNamespace: MEMORY_STRATEGIES.conversationSummary.namespace,
    eventExpiryDays: MEMORY_EVENT_EXPIRY_DAYS,
  },
  include: [sst.aws.permission({ actions: [...CAPABILITIES.MEMORY_ADMIN.actions], resources: [memory.memoryArn] })],
});
