// Models and IAM of the agent (docs/architecture.md §1 and §14, rows "Harness (ejecución)", "Gateway" and
// `BEDROCK_READ`, ADR-0016, ADR-0021 §6, docs/build-plan.md WP-31).
//
//   AgentModelProfile      application inference profile `<app>-<stage>-sonnet-5-5`, a copy of
//                          `global.anthropic.claude-sonnet-5-5` with the app's tags (provider default tags
//                          plus `Model`): the Harness and the three Memory strategies call only it.
//   <app>-<stage>-memory   assumed by Memory to run the agent model of the three custom strategies.
//   <app>-<stage>-gateway  lambda:InvokeFunction on the seven target Lambdas and the three policy engine
//                          actions the Gateway needs to evaluate Cedar; the targets name it in their
//                          resource policy (infra/agent-tools.ts).
//   <app>-<stage>-harness  the Harness execution role: the model (the application profile, the global profile
//                          it copies and its two model ARNs), ApplyGuardrail on G1, InvokeGateway, the
//                          Memory events of its sessions (never RetrieveMemoryRecords: the worker retrieves),
//                          its own runtime logs, traces, metrics and the managed image pull.
//   Classifier,            BEDROCK_READ (Converse): `Resource.Classifier.modelId` for InboundWhatsApp
//   ReceiptReader          (ADR-0016) and `Resource.ReceiptReader.modelId` for ToolInvestigation and the
//                          QaDriver (ADR-0007), each with InvokeModel on its global profile and model only.
//
// Statements are pure functions at the top of this module (infra/agentcore-spec.test.ts checks them); the
// roles' path `/<app>/` and the permissions boundary come from the $transform of infra/ci.ts. Role names
// are fixed because Cedar names the Harness by `assumed-role/<name>` (infra/policy.ts).
//
// Trust: `aws:SourceAccount` always; `aws:SourceArn` is the gateway id pattern for the Gateway role (known
// before the Gateway exists) and the AgentCore resources of this account for the Harness and Memory roles.
//
// After a model change the Memory update can fail on IAM propagation of the new profile: rerun the CI job
// (docs/architecture.md §16).
//
// Verify:
//   aws --profile craftech-demos bedrock list-inference-profiles --type-equals APPLICATION
//     → aws-cds-hackathon-poc-reclamo-poc-sonnet-5-5, models of anthropic.claude-sonnet-5-5
//   aws --profile craftech-demos iam list-role-policies --role-name aws-cds-hackathon-poc-reclamo-poc-harness
//   aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-reclamo-poc-gateway
//     → Path /aws-cds-hackathon-poc-reclamo/, PermissionsBoundary …-ci-boundary, trust bedrock-agentcore.amazonaws.com

import {
  AGENT_MODEL_ID,
  AGENT_MODEL_PROFILE_TAGS,
  MODEL_INVOKE_ACTIONS,
  MODEL_LINKS,
  RUNTIME_LOG_GROUP_PREFIX,
  agentModelArns,
  agentModelProfileDescription,
  agentModelProfileName,
  agentRoleName,
  gatewayName,
  globalModelArns,
  globalProfileArn,
  harnessName,
  type AgentPlace,
  type ModelLink,
} from "./agentcore-spec";

// ---- Statements (pure) --------------------------------------------------------------------------------

export interface AgentStatement {
  readonly sid: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly condition?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export const AGENTCORE_PRINCIPAL = "bedrock-agentcore.amazonaws.com";
/** Events of the Harness sessions (docs/architecture.md §14): no retrieval and no delete. */
export const HARNESS_MEMORY_ACTIONS = ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:GetEvent", "bedrock-agentcore:ListEvents"] as const;
/** What the Gateway needs to evaluate Cedar; without them every tool call is denied. */
export const GATEWAY_POLICY_ENGINE_ACTIONS = ["bedrock-agentcore:GetPolicyEngine", "bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"] as const;
/** Statements whose resource is `*`: the actions have no resource-level permission. */
export const WILDCARD_SIDS = ["Traces", "Metrics", "ManagedImagePull", "ManagedImageBearer"] as const;

export const agentCoreArnPrefix = (place: AgentPlace): string => `arn:aws:bedrock-agentcore:${place.region}:${place.account}`;

/** Gateways of this stage: the id is the lowercase name plus a suffix, so the pattern exists before the Gateway. */
export function gatewayArnPattern(place: AgentPlace, app: string, stage: string): string {
  return `${agentCoreArnPrefix(place)}:gateway/${gatewayName(app, stage).toLowerCase()}-*`;
}

/** Trust of an agent role: AgentCore only, this account only, from `sourceArnPattern` only (confused deputy). */
export function agentCoreTrustPolicy(place: AgentPlace, sourceArnPattern: string): string {
  const condition = { StringEquals: { "aws:SourceAccount": place.account }, ArnLike: { "aws:SourceArn": sourceArnPattern } };
  return JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: AGENTCORE_PRINCIPAL }, Action: "sts:AssumeRole", Condition: condition }] });
}

export function policyDocument(statements: readonly AgentStatement[]): string {
  const rendered = statements.map(({ sid, actions, resources, condition }) => ({ Sid: sid, Effect: "Allow", Action: [...actions], Resource: [...resources], ...(condition ? { Condition: condition } : {}) }));
  return JSON.stringify({ Version: "2012-10-17", Statement: rendered });
}

/** AgentCore resolves the application profile before it accepts it as a model. */
const modelProfileRead = (profileArn: string): AgentStatement => ({ sid: "ModelProfileRead", actions: ["bedrock:GetInferenceProfile"], resources: [profileArn] });

/** Memory execution role: the agent model of the three strategy overrides, nothing else. */
export function memoryRoleStatements(place: AgentPlace, profileArn: string): AgentStatement[] {
  return [{ sid: "ExtractionModel", actions: MODEL_INVOKE_ACTIONS, resources: agentModelArns(place, profileArn) }, modelProfileRead(profileArn)];
}

/** Gateway role: invoke exactly the seven target Lambdas and evaluate Cedar on this stage's engine. */
export function gatewayRoleStatements(place: AgentPlace, app: string, stage: string, functionArns: readonly string[], policyEngineArn: string): AgentStatement[] {
  const [configuration, ...authorization] = GATEWAY_POLICY_ENGINE_ACTIONS;
  return [
    { sid: "InvokeToolTargets", actions: ["lambda:InvokeFunction"], resources: functionArns },
    { sid: "PolicyEngineConfiguration", actions: [configuration], resources: [policyEngineArn] },
    { sid: "PolicyEngineAuthorization", actions: authorization, resources: [policyEngineArn, gatewayArnPattern(place, app, stage)] },
  ];
}

export interface HarnessRoleResources {
  readonly modelProfileArn: string;
  readonly gatewayArn: string;
  readonly memoryArn: string;
  /** G1 (infra/guardrail.ts), the guardrail of the Harness model calls. */
  readonly guardrailArn: string;
}

/** Harness execution role: the model, G1, the Gateway, its Memory events and the runtime's logs, traces and image pull. */
export function harnessRoleStatements(place: AgentPlace, app: string, stage: string, resources: HarnessRoleResources): AgentStatement[] {
  const runtime = `harness_${harnessName(app, stage)}`;
  const logs = `arn:aws:logs:${place.region}:${place.account}:log-group:${RUNTIME_LOG_GROUP_PREFIX}${runtime}*`;
  const identity = `${agentCoreArnPrefix(place)}:workload-identity-directory/default`;
  return [
    { sid: "Model", actions: MODEL_INVOKE_ACTIONS, resources: agentModelArns(place, resources.modelProfileArn) },
    modelProfileRead(resources.modelProfileArn),
    { sid: "GuardrailG1", actions: ["bedrock:ApplyGuardrail"], resources: [resources.guardrailArn] },
    { sid: "Gateway", actions: ["bedrock-agentcore:InvokeGateway"], resources: [resources.gatewayArn] },
    { sid: "Memory", actions: HARNESS_MEMORY_ACTIONS, resources: [resources.memoryArn] },
    { sid: "WorkloadIdentity", actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"], resources: [identity, `${identity}/workload-identity/${runtime}-*`] },
    { sid: "RuntimeLogGroup", actions: ["logs:CreateLogGroup", "logs:DescribeLogStreams"], resources: [logs] },
    { sid: "RuntimeLogStreams", actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [`${logs}:log-stream:*`] },
    { sid: "DescribeLogGroups", actions: ["logs:DescribeLogGroups"], resources: [`arn:aws:logs:${place.region}:${place.account}:log-group:*`] },
    { sid: "Traces", actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], resources: ["*"] },
    { sid: "Metrics", actions: ["cloudwatch:PutMetricData"], resources: ["*"], condition: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } } },
    { sid: "ManagedImagePull", actions: ["ecr-public:GetAuthorizationToken"], resources: ["*"] },
    { sid: "ManagedImageBearer", actions: ["sts:GetServiceBearerToken"], resources: ["*"], condition: { StringEquals: { "sts:AWSServiceName": "ecr-public.amazonaws.com" } } },
  ];
}

// ---- Resources ----------------------------------------------------------------------------------------

/** Account and region of the provider, the scope of every ARN of the agent's policies. */
export const agentPlace: $util.Output<AgentPlace> = $util
  .all([aws.getCallerIdentityOutput({}).accountId, aws.getRegionOutput({}).region])
  .apply(([account, region]) => ({ account, region }));

export const agentModelProfile = new aws.bedrock.InferenceProfile("AgentModelProfile", {
  name: agentModelProfileName($app.name, $app.stage),
  description: agentModelProfileDescription($app.name, $app.stage),
  modelSource: { copyFrom: agentPlace.apply((place) => globalProfileArn(place, AGENT_MODEL_ID)) },
  tags: { ...AGENT_MODEL_PROFILE_TAGS },
});

/** BEDROCK_READ of one Converse caller: `Resource.<link>.modelId` and InvokeModel on that global profile and its model only. */
function modelLink(link: ModelLink): sst.Linkable<{ modelId: string }> {
  const { modelId } = MODEL_LINKS[link];
  return new sst.Linkable(link, {
    properties: { modelId },
    include: [sst.aws.permission({ actions: [...MODEL_INVOKE_ACTIONS], resources: agentPlace.apply((place) => globalModelArns(place, modelId)) })],
  });
}

/** InboundWhatsApp (late link of infra/messaging-whatsapp.ts, re-exported by infra/agentcore.ts). */
export const Classifier = modelLink("Classifier");
/** ToolInvestigation (infra/agent-tools.ts) and the QaDriver (infra/bff.ts). */
export const ReceiptReader = modelLink("ReceiptReader");

const anyAgentCoreResource = agentPlace.apply((place) => agentCoreTrustPolicy(place, `${agentCoreArnPrefix(place)}:*`));

export const memoryRole = new aws.iam.Role("AgentMemoryRole", {
  name: agentRoleName($app.name, $app.stage, "memory"),
  description: "Assumed by AgentCore Memory to run the agent model of the three custom strategies.",
  assumeRolePolicy: anyAgentCoreResource,
});

export const memoryRolePolicy = new aws.iam.RolePolicy("AgentMemoryRolePolicy", {
  role: memoryRole.id,
  policy: $util.all([agentPlace, agentModelProfile.arn]).apply(([place, profileArn]) => policyDocument(memoryRoleStatements(place, profileArn))),
});

export const gatewayRole = new aws.iam.Role("AgentGatewayRole", {
  name: agentRoleName($app.name, $app.stage, "gateway"),
  description: "Assumed by the AgentCore Gateway: invokes the seven tool Lambdas and evaluates Cedar.",
  assumeRolePolicy: agentPlace.apply((place) => agentCoreTrustPolicy(place, gatewayArnPattern(place, $app.name, $app.stage))),
});

export interface GatewayRolePolicyArgs {
  /** ARNs of the seven target Lambdas, the only functions the Gateway may invoke. */
  readonly functionArns: ReadonlyArray<$util.Input<string>>;
  readonly policyEngineArn: $util.Input<string>;
}

export function createGatewayRolePolicy(args: GatewayRolePolicyArgs): aws.iam.RolePolicy {
  return new aws.iam.RolePolicy("AgentGatewayRolePolicy", {
    role: gatewayRole.id,
    policy: $util
      .all([agentPlace, $util.all([...args.functionArns]), args.policyEngineArn])
      .apply(([place, functionArns, policyEngineArn]) => policyDocument(gatewayRoleStatements(place, $app.name, $app.stage, functionArns, policyEngineArn))),
  });
}

/** Exists before its policy: Cedar names it, and its policy scopes to the Gateway, Memory and G1. */
export const harnessRole = new aws.iam.Role("AgentHarnessRole", {
  name: agentRoleName($app.name, $app.stage, "harness"),
  description: "Execution role of the AgentCore Harness: model, G1, Gateway, Memory events, runtime logs and traces.",
  assumeRolePolicy: anyAgentCoreResource,
});

export interface HarnessRolePolicyArgs {
  readonly modelProfileArn: $util.Input<string>;
  readonly gatewayArn: $util.Input<string>;
  readonly memoryArn: $util.Input<string>;
  readonly guardrailArn: $util.Input<string>;
}

export function createHarnessRolePolicy(args: HarnessRolePolicyArgs): aws.iam.RolePolicy {
  return new aws.iam.RolePolicy("AgentHarnessRolePolicy", {
    role: harnessRole.id,
    policy: $util
      .all([agentPlace, args.modelProfileArn, args.gatewayArn, args.memoryArn, args.guardrailArn])
      .apply(([place, modelProfileArn, gatewayArn, memoryArn, guardrailArn]) => policyDocument(harnessRoleStatements(place, $app.name, $app.stage, { modelProfileArn, gatewayArn, memoryArn, guardrailArn }))),
  });
}
