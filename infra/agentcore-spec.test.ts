// The agent as resources (docs/build-plan.md WP-31): the spec against docs/architecture.md §1, §4, §9 and
// §14 and ADR-0021 §6, the verified service facts against the pinned provider and the installed SDK, and
// infra/agentcore.ts, infra/agentcore-iam.ts, infra/agent-tools.ts, infra/policy.ts and infra/scheduler.ts
// evaluated against recording stand-ins of the SST and Pulumi globals: the dependsOn chain, the model and
// its profile, the roles, the Linkables and the Scheduler. No AWS account.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../packages/bff/src/agent/system-prompt";
import { ToolTarget } from "../packages/bff/src/agent-tools/common/targets";
import * as spec from "./agentcore-spec";
import { CAPABILITIES, LAMBDA_CAPABILITIES, actionDrift, expectedActions, type LambdaCapabilities, type LambdaName } from "./iam-capabilities";
import { parseStatement } from "./policy-rules";

const APP = "aws-cds-hackathon-poc-reclamo";
const PLACE = { account: "776805327629", region: "us-east-1" };
const RUNTIME_ID = "harness_aws_cds_hackathon_poc_reclamo_poc-Ab12Cd34Ef";
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const section = (from: string, to: string): string => architecture.slice(architecture.indexOf(from), architecture.indexOf(to));
const documented = (text: string, label: string): number => Number(new RegExp(`${label} (\\d+)`).exec(text)?.[1] ?? Number.NaN);

/** Required fields of a `z.object({...})` link schema of the Lambda code, read from its source. */
function linkFields(path: string, name: string): string[] {
  const source = read(path);
  const start = source.indexOf(`export const ${name} = z.object({`);
  const body = source.slice(start, source.indexOf("});", start));
  return [...body.matchAll(/\b([A-Za-z]+): z\.[^,\n]*/g)].filter((match) => !match[0].includes(".optional()")).map((match) => match[1] ?? "");
}

/** Field names of an interface of a declaration file, from its header to its closing brace at the same indent. */
function interfaceFields(text: string, header: string, indent: number): string[] {
  const start = text.indexOf(`${header} {`);
  if (start < 0) throw new Error(`no ${header}`);
  const body = text.slice(start, text.indexOf(`\n${" ".repeat(indent - 4)}}`, start));
  return [...body.matchAll(new RegExp(`^ {${indent}}([A-Za-z]+)\\??:`, "gm"))].map((match) => match[1] ?? "");
}

// ---- Recording stand-ins ------------------------------------------------------------------------------

class Out<T = unknown> {
  constructor(readonly get: () => T) {}
  apply<U>(fn: (value: T) => U): Out<U> {
    return new Out(() => fn(settle(this) as T));
  }
}
function settle(value: unknown): unknown {
  if (value instanceof Out) return settle(value.get());
  if (Array.isArray(value)) return value.map(settle);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, settle(item)]));
  return value;
}
const constant = <T>(value: T): Out<T> => new Out(() => value);

interface Created {
  readonly kind: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly opts: { readonly dependsOn?: unknown[]; readonly ignoreChanges?: string[] };
  readonly self: object;
}
const created: Created[] = [];

function resource(kind: string, known: Record<string, unknown> = {}) {
  return class {
    constructor(name: string, args: Record<string, unknown> = {}, opts: Created["opts"] = {}) {
      const outputs = new Map<string, Out<unknown>>(Object.entries(known).map(([prop, value]) => [prop, constant(value)]));
      const self = new Proxy(this, {
        get: (_target, prop) => (typeof prop === "string" ? (outputs.get(prop) ?? outputs.set(prop, constant(`${name}.${prop}`)).get(prop)) : undefined),
      });
      created.push({ kind, name, args, opts, self });
      return self;
    }
  };
}

function installGlobals(): void {
  const kinds = (prefix: string, names: string[]) => Object.fromEntries(names.map((name) => [name, resource(`${prefix}.${name}`)]));
  const globals = {
    $app: { name: APP, stage: "poc" },
    $util: { all: (values: unknown[]) => new Out(() => values.map(settle)), output: (value: unknown) => new Out(() => settle(value)), log: { warn: () => undefined } },
    $interpolate: (strings: TemplateStringsArray, ...values: unknown[]) => new Out(() => strings.reduce((text, part, index) => `${text}${part}${index < values.length ? String(settle(values[index])) : ""}`, "")),
    sst: { Linkable: resource("sst.Linkable"), aws: { Function: resource("sst.aws.Function"), permission: (statement: unknown) => statement } },
    aws: {
      getCallerIdentityOutput: () => ({ accountId: constant(PLACE.account) }),
      getRegionOutput: () => ({ region: constant(PLACE.region) }),
      bedrock: kinds("aws.bedrock", ["InferenceProfile"]),
      iam: kinds("aws.iam", ["Role", "RolePolicy"]),
      cloudwatch: kinds("aws.cloudwatch", ["LogGroup"]),
      lambda: kinds("aws.lambda", ["Permission"]),
      scheduler: kinds("aws.scheduler", ["ScheduleGroup"]),
    },
    awsnative: {
      bedrockagentcore: {
        ...kinds("awsnative", ["Memory", "Gateway", "GatewayTarget", "PolicyEngine", "Policy", "HarnessEndpoint"]),
        Harness: resource("awsnative.Harness", { environment: { agentCoreRuntimeEnvironment: { agentRuntimeId: RUNTIME_ID, agentRuntimeArn: "AgentHarness.runtimeArn" } } }),
      },
    },
  };
  for (const [name, value] of Object.entries(globals)) Reflect.set(globalThis, name, value);
}

const all = (kind: string): Created[] => created.filter((item) => item.kind === kind);
function one(kind: string, name: string): Created {
  const found = created.filter((item) => item.kind === kind && item.name === name);
  if (found.length !== 1) throw new Error(`expected one ${kind} ${name}, found ${found.length}`);
  return found[0] as Created;
}
const nameOf = (self: unknown): string => created.find((item) => item.self === self)?.name ?? "?";
const dependsOn = (item: Created): string[] => (item.opts.dependsOn ?? []).map(nameOf);
const statementsOf = (item: Created) => (item.args.include as Array<{ actions: string[]; resources: unknown }>).map((statement) => ({ ...statement, resources: settle(statement.resources) as string[] }));
const policyOf = (name: string) => JSON.parse(String(settle(one("aws.iam.RolePolicy", name).args.policy))) as { Statement: Array<{ Sid: string; Action: string[]; Resource: string[] }> };

let agentcore: Record<string, unknown>;
beforeAll(async () => {
  installGlobals();
  const fakeFunction = (name: string) => new (resource("sst.aws.Function"))(name, {});
  vi.doMock("./guardrail", () => ({ g1: new (resource("aws.bedrock.Guardrail"))("GuardrailG1"), harnessGuardrailConfig: { guardrailConfig: { guardrailIdentifier: "g1", guardrailVersion: "1", trace: "enabled" } } }));
  vi.doMock("./workers", () => ({ scheduleDispatch: fakeFunction("ScheduleDispatch"), anchorWriter: fakeFunction("AnchorWriter") }));
  vi.doMock("./messaging-whatsapp", () => ({ pipelineLinks: ["Pipeline"], sendWhatsAppPermissions: constant([{ actions: ["social-messaging:SendWhatsAppMessage"], resources: ["phone"] }]) }));
  vi.doMock("./mocks", () => ({
    fixedRole: (fn: string) => (args: { name?: string }) => void (args.name = `fixed:${fn}`),
    functionData: (fn: string) => ({ links: [`data:${fn}`], permissions: [] }),
    grantMockInvoke: (fn: string) => [new (resource("aws.lambda.Permission"))(`MockGrant${fn}`)],
  }));
  agentcore = await import("./agentcore");
  await import("./scheduler");
});

// ---- Spec against the documents -------------------------------------------------------------------

describe("names (docs/architecture.md §1 and §9)", () => {
  it("fit the service patterns, the documented names and the fence of the CI bootstrap", () => {
    expect(spec.harnessName(APP, "poc")).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(section("### 9.3", "### 9.4")).toContain(`\`${spec.memoryName(APP, "poc")}\``);
    expect(section("### 9.2", "### 9.3")).toContain(`Gateway \`${spec.gatewayName(APP, "poc")}\`, herramienta del Harness \`${spec.GATEWAY_TOOL_NAME}\``);
    for (const purpose of ["harness", "gateway", "memory"] as const) expect(spec.agentRoleName(APP, "poc", purpose).length).toBeLessThanOrEqual(64);
    const prefix = /AgentNamePrefix:\n\s+Type: String\n\s+Default: (\S+)/.exec(read("infra/bootstrap/ci-role.yaml"))?.[1] ?? "?";
    expect(spec.harnessName(APP, "poc").startsWith(prefix)).toBe(true);
  });
});

describe("Harness (docs/architecture.md §4)", () => {
  const components = section("## 4.", "## 5.");

  it("uses the documented limits, maxTokens 4096 included, and the Gateway as its only tool", () => {
    expect(spec.HARNESS_LIMITS).toEqual({
      maxIterations: documented(components, "maxIterations"),
      maxTokens: documented(components, "maxTokens"),
      timeoutSeconds: documented(components, "timeoutSeconds"),
      slidingWindowMessages: documented(components, "sliding_window"),
    });
    expect(spec.HARNESS_LIMITS.maxTokens).toBe(4_096);
    expect(components).toContain(`allowedTools: [${spec.HARNESS_ALLOWED_TOOLS.map((tool) => `"${tool}"`).join(", ")}]`);
    const harness = one("awsnative.Harness", "AgentHarness").args;
    expect(harness).toMatchObject({ maxIterations: 12, maxTokens: 4_096, timeoutSeconds: 120, allowedTools: ["@reclamo-tools/*"], systemPrompt: [{ text: DEFAULT_SYSTEM_PROMPT }] });
    expect((harness.tools as unknown[]).map((tool) => (tool as { type: string }).type)).toEqual(["agentcore_gateway"]);
    expect(settle(harness.memory)).toEqual({ agentCoreMemoryConfiguration: { arn: "AgentMemory.memoryArn" } });
  });

  it("records what the installed SDK and the pinned provider say about guardrail scope, session attributes, caching and traces", () => {
    const models = read(spec.HARNESS_GUARDRAIL_SCOPE.source);
    const members = (type: string) => [...(new RegExp(`export type ${type} = ([^;]+);`).exec(models)?.[1] ?? "").matchAll(/\.(\w+)Member/g)].map((match) => match[1] ?? "").filter((name) => name !== "$Unknown").map((name) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`);
    expect(members("HarnessContentBlock").sort()).toEqual([...spec.HARNESS_GUARDRAIL_SCOPE.harnessContentBlockMembers].sort());
    expect(members("HarnessSystemContentBlock")).toEqual([...spec.PROMPT_CACHING.systemContentBlockMembers]);
    expect(interfaceFields(models, "export interface InvokeHarnessRequest", 4)).toEqual([...spec.SESSION_ATTRIBUTES.invokeHarnessFields]);
    const provider = read(spec.SESSION_ATTRIBUTES.checked[1]);
    expect(interfaceFields(provider, "    interface HarnessAgentCoreGatewayConfigArgs", 8)).toEqual([...spec.SESSION_ATTRIBUTES.gatewayToolConfigFields]);
    expect(interfaceFields(provider, "    interface HarnessSystemContentBlockArgs", 8)).toEqual(["text"]);
    expect(spec).toMatchObject({ SESSION_ATTRIBUTES: { propagatedToGateway: false }, PROMPT_CACHING: { exposed: false } });
    const [harnessFile, endpointFile, controlFile] = spec.TRACE_CONTENT_CAPTURE.checked.map(read);
    const fields = [
      ...interfaceFields(harnessFile ?? "", "export interface HarnessArgs", 4),
      ...interfaceFields(endpointFile ?? "", "export interface HarnessEndpointArgs", 4),
      ...interfaceFields(controlFile ?? "", "export interface CreateHarnessRequest", 4),
      ...interfaceFields(controlFile ?? "", "export interface CreateHarnessEndpointRequest", 4),
    ];
    expect(fields).toContain("executionRoleArn");
    expect(fields.filter((field) => /observab|capture|telemetry|trac|logging|content/i.test(field))).toEqual([]);
    expect(spec.TRACE_CONTENT_CAPTURE).toMatchObject({ captureCanBeTurnedOff: false, decision: "RETENTION" });
  });
});

describe("model (ADR-0021 §6): Sonnet 5.5 through the tagged application profile, nothing else", () => {
  it("names the profile after the model and tags it with the app's tags plus the model", () => {
    expect(spec.AGENT_MODEL_ID).toBe("global.anthropic.claude-sonnet-5-5");
    expect(spec.agentModelProfileName(APP, "poc")).toBe("aws-cds-hackathon-poc-reclamo-poc-sonnet-5-5");
    expect(architecture).toContain(`\`${spec.agentModelProfileName(APP, "poc")}\``);
    const profile = one("aws.bedrock.InferenceProfile", "AgentModelProfile").args;
    expect(settle(profile)).toEqual({
      name: spec.agentModelProfileName(APP, "poc"),
      description: spec.agentModelProfileDescription(APP, "poc"),
      modelSource: { copyFrom: "arn:aws:bedrock:us-east-1:776805327629:inference-profile/global.anthropic.claude-sonnet-5-5" },
      tags: { Model: spec.AGENT_MODEL_ID },
    });
    for (const value of [profile.name, profile.description]) expect(value).toMatch(/^([0-9a-zA-Z:.][ _-]?)+$/);
    const defaults = /const tags = \{([\s\S]*?)\};/.exec(read("sst.config.ts"))?.[1] ?? "";
    for (const key of ["Project", "Stage", "ManagedBy", "Owner", '"sst:app"', '"sst:stage"']) expect(defaults).toContain(`${key}:`);
  });

  it("gives the Harness and the three Memory strategies only that profile, and the roles only its ARNs", () => {
    const profileArn = "AgentModelProfile.arn";
    expect(settle((one("awsnative.Harness", "AgentHarness").args.model as { bedrockModelConfig: { modelId: unknown } }).bedrockModelConfig.modelId)).toBe(profileArn);
    const strategies = settle(one("awsnative.Memory", "AgentMemory").args.memoryStrategies) as Array<{ customMemoryStrategy: { configuration: object } }>;
    const models = strategies.flatMap((strategy) => Object.values(strategy.customMemoryStrategy.configuration).flatMap((override: object) => Object.values(override).map((prompt: { modelId: string }) => prompt.modelId)));
    expect(models).toEqual(Array(5).fill(profileArn));
    for (const role of ["AgentHarnessRolePolicy", "AgentMemoryRolePolicy"]) {
      const model = policyOf(role).Statement.find((statement) => statement.Action.includes("bedrock:InvokeModel"));
      expect(model?.Resource, role).toEqual(spec.agentModelArns(PLACE, profileArn));
    }
    expect(spec.agentModelArns(PLACE, profileArn).slice(1)).toEqual(["arn:aws:bedrock:us-east-1:776805327629:inference-profile/global.anthropic.claude-sonnet-5-5", "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5", "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5"]);
  });

  it("names a model id only in the spec: no resource module references another model", () => {
    const sources = readdirSync(resolve(process.cwd(), "infra")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "agentcore-spec.ts");
    const code = (file: string) => read(`infra/${file}`).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
    for (const file of sources) expect(code(file), file).not.toMatch(/anthropic\.claude-|claude-(sonnet|opus|haiku)/);
    const ids = [...read("infra/agentcore-spec.ts").matchAll(/"(global\.anthropic\.claude-[a-z0-9-]+)"/g)].map((match) => match[1]);
    expect(new Set(ids)).toEqual(new Set([spec.AGENT_MODEL_ID, spec.CLASSIFIER_MODEL_ID, spec.RECEIPT_MODEL_ID]));
    expect(spec.CLASSIFIER_MODEL_ID).toMatch(/haiku/);
  });
});

describe("Memory (docs/architecture.md §9.3, docs/design-brief.md §8.4)", () => {
  const memorySection = section("### 9.3", "### 9.4");

  it("has the three documented strategies, namespaces and topK, as the worker reads them", () => {
    const rows = [...memorySection.matchAll(/^\| [^|]+ \| `(\w+)` \| `([^`]+)` \|/gm)].map((match) => [match[1], match[2]]);
    expect(Object.entries(spec.MEMORY_STRATEGIES).map(([name, strategy]) => [name, strategy.namespace])).toEqual(rows);
    expect(spec.MEMORY_EVENT_EXPIRY_DAYS).toBe(documented(memorySection, "eventExpiryDuration"));
    const worker = read("packages/bff/src/agent/memory.ts");
    expect(worker).toContain(`MEMORY_TOP_K = { preferences: ${spec.MEMORY_STRATEGIES.customerPreferences.topK}, facts: ${spec.MEMORY_STRATEGIES.customerFacts.topK}, summary: ${spec.MEMORY_STRATEGIES.conversationSummary.topK} }`);
    expect(worker).toContain("return `/customers/${actorId}/${sessionId}/summary/`;");
    expect(worker).toContain("return `/customers/${actorId}/${kind}/`;");
    expect([spec.MEMORY_STRATEGIES.customerPreferences.namespace, spec.MEMORY_STRATEGIES.customerFacts.namespace]).toEqual(["/customers/{actorId}/preferences/", "/customers/{actorId}/facts/"]);
  });

  it("excludes sensitive data, system conclusions, refused sends and errors on every override, and keeps preferences enumerated", () => {
    const strategies = spec.memoryStrategyArgs("profile").map((entry) => entry.customMemoryStrategy);
    expect(strategies.map((strategy) => Object.keys(strategy.configuration))).toEqual([["userPreferenceOverride"], ["semanticOverride"], ["summaryOverride"]]);
    const prompts = strategies.flatMap((strategy) => Object.values(strategy.configuration).flatMap((override: object) => Object.values(override) as Array<{ appendToPrompt: string }>));
    expect(prompts).toHaveLength(5);
    for (const prompt of prompts) expect(prompt.appendToPrompt.startsWith(spec.MEMORY_EXCLUSION_INSTRUCTION)).toBe(true);
    for (const term of ["CBU", "CVU", "card numbers", "passwords", "codes", "amounts of money", "third parties", "receipts", "instructions", "conclusions about how the system works", "refused or blocked sends", "errors", "[TARJETA]", "[CLAVE]"]) {
      expect(spec.MEMORY_EXCLUSION_INSTRUCTION, term).toContain(term);
    }
    const preference = prompts.slice(0, 2).map((prompt) => prompt.appendToPrompt);
    for (const text of preference) expect(text).toContain("preferredChannel (WHATSAPP or EMAIL); contactWindow (MORNING or AFTERNOON or ANY); formOfAddress (VOS or USTED);");
    for (const prompt of prompts.slice(2)) expect(prompt.appendToPrompt).toBe(spec.MEMORY_EXCLUSION_INSTRUCTION);
  });
});

describe("tool Lambdas (docs/architecture.md §9.2 and §14)", () => {
  it("run one Lambda per target with its handler, budget, fixed role and the Gateway role as only invoker", () => {
    expect(Object.keys(spec.TOOL_FUNCTIONS)).toEqual(ToolTarget.options);
    for (const target of ToolTarget.options) {
      const fn = spec.TOOL_FUNCTIONS[target];
      const args = one("sst.aws.Function", fn).args;
      expect(args).toMatchObject({ handler: spec.toolHandlerPath(target), timeout: `${spec.TOOL_LAMBDAS[target].timeoutSeconds} seconds` });
      expect(read(`packages/bff/src/agent-tools/${target}/handler.ts`)).toMatch(/export const handler = lambdaEntry\(/);
      expect(spec.TOOL_LAMBDAS[target].timeoutSeconds).toBeLessThan(spec.HARNESS_LIMITS.timeoutSeconds);
      const role: { name?: string } = {};
      (args.transform as { role: (value: object) => void }).role(role);
      expect(role.name).toBe(`fixed:${fn}`);
      expect(one("aws.lambda.Permission", `${fn}InvokeByGateway`).args).toMatchObject({ action: "lambda:InvokeFunction", principal: (created.find((item) => item.name === "AgentGatewayRole")?.self as { arn?: unknown } | undefined)?.arn });
    }
    expect(one("sst.aws.Function", "ToolInvestigation").args.concurrency).toEqual({ reserved: 5 });
    expect(all("aws.lambda.Permission").filter((item) => item.name.startsWith("MockGrant")).map((item) => item.name).sort()).toEqual(["MockGrantToolAccount", "MockGrantToolActions", "MockGrantToolComplaints", "MockGrantToolHandoff", "MockGrantToolIdentity", "MockGrantToolInvestigation", "MockGrantToolMessaging"]);
  });

  it("get exactly the actions their capabilities declare, through one Linkable each", () => {
    for (const fn of Object.values(spec.TOOL_FUNCTIONS)) expect(actionDrift(fn, spec.toolActions(fn)), fn).toEqual({ extra: [], missing: [] });
    expect([...spec.toolLinkContracts("ToolMessaging")].sort()).toEqual(["AnchorWriter", "CoreMock", "EmailSender", "GuardrailG2", "Scheduler", "WhatsAppSender"]);
    expect(spec.toolLinkContracts("ToolInvestigation").sort()).toEqual(["CoreMock", "NetworkMock", "ReceiptReader"]);
    expect(() => spec.toolLinkContracts("WorldJanitor" as LambdaName)).toThrow();
    const holders = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((fn) => !fn.startsWith("Tool"));
    for (const fn of holders) {
      const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
      expect([entry.fence ?? "", ...(entry.invokes ?? [])].join(" "), fn).not.toMatch(/\bTool(Identity|Account|Investigation|Actions|Complaints|Messaging|Handoff)\b/);
    }
  });
});

describe("creation order: targets in series → permits → forbids → Harness → log group → endpoint", () => {
  it("chains the seven GatewayTargets one at a time, ignoring the Cloud Control read-back", () => {
    const targets = all("awsnative.GatewayTarget");
    expect(targets.map((target) => target.args.name)).toEqual(ToolTarget.options);
    expect(dependsOn(targets[0] as Created)).toEqual(["AgentGatewayRolePolicy", ...ToolTarget.options.map((target) => `${spec.TOOL_FUNCTIONS[target]}InvokeByGateway`)]);
    targets.slice(1).forEach((target, index) => expect(dependsOn(target)).toEqual([targets[index]?.name]));
    for (const target of targets) expect(target.opts.ignoreChanges).toEqual([...spec.TARGET_IGNORED_FIELDS]);
  });

  it("attaches the permits after the last target and every forbid after all the permits", () => {
    const policies = all("awsnative.Policy");
    const statements = policies.map((policy) => parseStatement(String(settle((policy.args.definition as { cedar: { statement: unknown } }).cedar.statement))));
    const permits = policies.filter((_, index) => statements[index]?.effect === "permit").map((policy) => policy.name);
    expect(permits).toHaveLength(7);
    for (const [index, policy] of policies.entries()) {
      expect(statements[index]?.principal).toBe(`arn:aws:sts::776805327629:assumed-role/AgentHarnessRole.name`);
      expect(dependsOn(policy)).toEqual(statements[index]?.effect === "permit" ? ["AgentGatewayTargetHandoff"] : ["AgentGatewayTargetHandoff", ...permits]);
      expect(String(policy.args.name).startsWith("reclamo_poc_CED_")).toBe(true);
    }
    expect(policies.findIndex((policy) => statements[policies.indexOf(policy)]?.effect === "forbid")).toBe(7);
  });

  it("creates the Harness after every policy, the live log group after the Harness and the endpoint after both", () => {
    const harness = one("awsnative.Harness", "AgentHarness");
    expect(dependsOn(harness)).toEqual(["AgentHarnessRolePolicy", ...all("awsnative.Policy").map((policy) => policy.name)]);
    const logGroup = one("aws.cloudwatch.LogGroup", "HarnessRuntimeLogsLive");
    expect(logGroup.args.retentionInDays).toBe(30);
    expect(dependsOn(logGroup)).toEqual(["AgentHarness"]);
    const endpoint = one("awsnative.HarnessEndpoint", "AgentHarnessEndpoint");
    expect(endpoint.args.endpointName).toBe("live");
    expect(dependsOn(endpoint)).toEqual(["AgentHarness", "HarnessRuntimeLogsLive"]);
    expect(one("awsnative.Gateway", "AgentGateway").args).toMatchObject({ authorizerType: "AWS_IAM", protocolType: "MCP" });
  });
});

describe("Linkables and roles (docs/architecture.md §14)", () => {
  it("lets the workers invoke the Harness and retrieve memory, the shape harness-client.ts reads", () => {
    const harness = one("sst.Linkable", "Harness");
    const properties = settle(harness.args.properties) as Record<string, unknown>;
    for (const field of [...linkFields("packages/bff/src/agent/harness-client.ts", "HarnessLink"), "memoryId"]) expect(properties[field], field).toBeDefined();
    expect(statementsOf(harness).flatMap((statement) => statement.actions).sort()).toEqual(expectedActions("EventWorker").filter((action) => action.startsWith("bedrock-agentcore:")).sort());
    expect(statementsOf(one("sst.Linkable", "Agent")).flatMap((statement) => statement.actions)).toEqual([...CAPABILITIES.MEMORY_ADMIN.actions]);
    expect(agentcore.Classifier).toBe(created.find((item) => item.kind === "sst.Linkable" && item.name === "Classifier")?.self);
  });

  it("gives each Converse caller only its own model (BEDROCK_READ)", () => {
    for (const link of ["Classifier", "ReceiptReader"] as const) {
      const linkable = one("sst.Linkable", link);
      expect(settle(linkable.args.properties)).toEqual({ modelId: spec.MODEL_LINKS[link].modelId });
      expect(statementsOf(linkable)).toEqual([{ actions: [...CAPABILITIES.BEDROCK_READ.actions], resources: spec.globalModelArns(PLACE, spec.MODEL_LINKS[link].modelId) }]);
    }
  });

  it("keeps the Harness role off retrieval and deletion, and the Gateway role on the seven targets only", () => {
    const harness = policyOf("AgentHarnessRolePolicy").Statement;
    const actions = harness.flatMap((statement) => statement.Action);
    for (const action of ["bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:DeleteEvent", "lambda:InvokeFunction"]) expect(actions).not.toContain(action);
    expect(harness.find((statement) => statement.Sid === "Memory")?.Resource).toEqual(["AgentMemory.memoryArn"]);
    const gateway = policyOf("AgentGatewayRolePolicy").Statement.find((statement) => statement.Sid === "InvokeToolTargets");
    expect(gateway?.Resource).toEqual(ToolTarget.options.map((target) => `${spec.TOOL_FUNCTIONS[target]}.arn`));
    const trust = JSON.parse(String(settle(one("aws.iam.Role", "AgentGatewayRole").args.assumeRolePolicy))) as { Statement: Array<{ Condition: unknown }> };
    expect(trust.Statement[0]?.Condition).toEqual({ StringEquals: { "aws:SourceAccount": PLACE.account }, ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:us-east-1:776805327629:gateway/${APP}-poc-*` } });
  });
});

describe("Scheduler (docs/architecture.md §10 and §14)", () => {
  it("creates the group, a role that only invokes ScheduleDispatch and the TIMERS Linkable", () => {
    expect(one("aws.scheduler.ScheduleGroup", "Schedules").args.name).toBe(`${APP}-poc-schedules`);
    const role = one("aws.iam.Role", "SchedulerInvocationRole").args;
    expect(role.name).toBe(`${APP}-poc-scheduler-invoke`);
    expect(JSON.parse(String(settle(role.assumeRolePolicy)))).toMatchObject({ Statement: [{ Principal: { Service: "scheduler.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": PLACE.account, "aws:SourceArn": "Schedules.arn" } } }] });
    expect(policyOf("SchedulerInvocationPolicy").Statement).toEqual([{ Sid: "InvokeScheduleDispatchOnly", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: ["ScheduleDispatch.arn"] }]);
    const scheduler = one("sst.Linkable", "Scheduler");
    expect(Object.keys(settle(scheduler.args.properties) as object).sort()).toEqual(linkFields("packages/bff/src/timers/scheduler-client.ts", "SchedulerLink").sort());
    const [schedules, passRole] = statementsOf(scheduler);
    expect(schedules?.resources).toEqual([`arn:aws:scheduler:us-east-1:776805327629:schedule/Schedules.name/*`]);
    expect([...(schedules?.actions ?? []), ...(passRole?.actions ?? [])].sort()).toEqual([...CAPABILITIES.TIMERS.actions].sort());
    expect(passRole).toMatchObject({ resources: ["SchedulerInvocationRole.arn"], conditions: [{ test: "StringEquals", variable: "iam:PassedToService", values: ["scheduler.amazonaws.com"] }] });
  });
});
