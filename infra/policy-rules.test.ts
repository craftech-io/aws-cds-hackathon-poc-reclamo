// The Cedar fences of docs/design-brief.md §8.6 as rendered by infra/policy-rules.ts: ids, creation order,
// engine limits, cited fields against the Gateway schemas generated from zod, and every fence evaluated
// with the local evaluator of the subset. No AWS account.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allDefinitions } from "../packages/bff/src/agent-tools/common/catalog";
import { GATEWAY_TOOLS, type CedarStatementId } from "../packages/bff/src/agent-tools/common/targets";
import { AnswerAttachment } from "../packages/bff/src/agent-tools/complaints/schema";
import { AgentWhatsAppKind } from "../packages/bff/src/agent-tools/messaging/schema";
import { gatewayInlinePayloads } from "./agent-tool-schemas";
import {
  GATEWAY_TARGETS,
  KILL_SWITCH_ACTIVE,
  MAX_STATEMENT_CHARS,
  MONEY_TOOLS,
  actionId,
  allActionIds,
  assumedRoleEntityId,
  cedarPermitId,
  cedarPolicies,
  cedarSessionId,
  creationPlan,
  evaluateCedar,
  inputSchemasByAction,
  parseStatement,
  policyEngineName,
  policyName,
  schemaProblems,
  unguardedReads,
  type CedarPolicyDefinition,
  type CedarRequest,
  type ToolInputSchemas,
} from "./policy-rules";

const ACCOUNT = "776805327629";
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
// Worst case of what infra/agentcore.ts can pass: an IAM role name of 64 characters and a Gateway id of 100.
const inputs = {
  gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:gateway/${"aws-cds-hackathon-poc-reclamo-poc-".padEnd(100, "x")}`,
  harnessPrincipalId: assumedRoleEntityId(ACCOUNT, "aws-cds-hackathon-poc-reclamo-poc-harness".padEnd(64, "z")),
};
const policies = cedarPolicies(inputs);
const byId = (id: string): CedarPolicyDefinition => {
  const found = policies.find((policy) => policy.id === id);
  if (found === undefined) throw new Error(`no policy ${id}`);
  return found;
};
const schemas: ToolInputSchemas = inputSchemasByAction(gatewayInlinePayloads);
const TOKEN = "w.s.t.1.sig";
const ID = "cmp_0001";

/** The smallest input every fence accepts for an action. */
function validInput(action: string): Record<string, unknown> {
  if (action === "messaging___send_whatsapp") return { sessionToken: TOKEN, kind: "REPLY", text: "Hola" };
  if (action === "complaints___answer_complaint_in_writing") return { sessionToken: TOKEN, outcome: "IN_FAVOUR", draftBody: "…" };
  return { sessionToken: TOKEN };
}

const request = (action: string, input: Record<string, unknown>, overrides: Partial<CedarRequest> = {}): CedarRequest => ({ principal: inputs.harnessPrincipalId, action, resource: inputs.gatewayArn, input, ...overrides });
const decide = (action: string, input: Record<string, unknown>, set: readonly CedarPolicyDefinition[] = policies) => evaluateCedar(set, request(action, input));

/** The CED-* ids of docs/design-brief.md §8.6 (the two per-target rows expanded). */
function documentedIds(): string[] {
  const brief = read("docs/design-brief.md");
  const section = brief.slice(brief.indexOf("### 8.6"), brief.indexOf("### 8.7"));
  const ids = [...section.matchAll(/^\| `(CED-[A-Z-]+(?:<TARGET>)?)`/gm)].map((match) => match[1] ?? "");
  return ids.flatMap((id) => (id.endsWith("<TARGET>") ? GATEWAY_TARGETS.map((target) => id.replace("<TARGET>", target.toUpperCase())) : [id]));
}

describe("statements (docs/design-brief.md §8.6)", () => {
  it("renders every CED-* of the design once, permits first, each with a valid unique name inside the prefix budget", () => {
    expect([...policies.map((policy) => policy.id)].sort()).toEqual(documentedIds().sort());
    const prefix = /CEDAR_NAME_PREFIX = "([a-z_]+)"/.exec(read("infra/policy.ts"))?.[1] ?? "";
    expect(prefix).toMatch(/^[a-z][a-z_]+_$/);
    for (const policy of policies) {
      expect(`${prefix}${policy.name}`).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
      expect(policy.name).toBe(policyName(policy.id));
      expect(policy.statement.startsWith(`// ${policy.id}\n${policy.effect}(\n  principal == AgentCore::IamEntity::"${inputs.harnessPrincipalId}",`)).toBe(true);
      expect(policy.statement).toContain(`resource == AgentCore::Gateway::"${inputs.gatewayArn}"`);
      expect(policy.enforcementMode).toBe("ACTIVE");
    }
    expect(new Set(policies.map((policy) => policy.name)).size).toBe(policies.length);
    expect(policyEngineName("aws-cds-hackathon-poc-reclamo", "poc")).toBe("aws_cds_hackathon_poc_reclamo_poc");
  });

  it("permits exactly the 28 Gateway tools, one permit per target (CED-PERMIT-<TARGET>)", () => {
    const permits = policies.filter((policy) => policy.effect === "permit");
    expect(permits.map((policy) => policy.id)).toEqual(GATEWAY_TARGETS.map(cedarPermitId));
    GATEWAY_TARGETS.forEach((target, index) => {
      expect(parseStatement(permits[index]?.statement ?? "").actions).toEqual(GATEWAY_TOOLS[target].map((tool) => `${target}___${tool}`));
    });
    expect(allActionIds()).toHaveLength(28);
    expect(allActionIds().sort()).toEqual(Object.keys(schemas).sort());
  });

  it("stays within the subset the local evaluator understands and rejects anything else", () => {
    for (const policy of policies) expect(() => parseStatement(policy.statement)).not.toThrow();
    const like = byId("CED-NO-SELF-APPROVAL").statement.replace("context.input has decision", 'context.input.decision like "*"');
    expect(() => parseStatement(like)).toThrow(/Unsupported Cedar term/);
    expect(() => parseStatement("permit(principal, action, resource);")).toThrow(/outside the supported Cedar subset/);
  });
});

describe("engine limits and creation order", () => {
  it("keeps every statement under 10,000 characters once each action is qualified with the Gateway ARN", () => {
    const qualified = (statement: string): string => statement.replace(/AgentCore::Action::"/g, `AgentCore::Action::"${inputs.gatewayArn}/`);
    for (const policy of [...policies, ...cedarPolicies(inputs, { killSwitchActive: true })]) expect(qualified(policy.statement).length, policy.name).toBeLessThan(MAX_STATEMENT_CHARS);
  });

  it("creates the seven permits first and every forbid after all of them", () => {
    const plan = creationPlan(policies);
    const permitNames = GATEWAY_TARGETS.map((target) => policyName(cedarPermitId(target)));
    expect(plan.slice(0, 7).map((step) => [step.definition.name, step.after])).toEqual(permitNames.map((name) => [name, []]));
    for (const step of plan.slice(7)) {
      expect(step.definition.effect).toBe("forbid");
      expect(step.after).toEqual(permitNames);
    }
    expect(plan).toHaveLength(policies.length);
  });

  it("fails on analyzer findings except where the finding is certain by construction", () => {
    const certain = new Set<string>([...GATEWAY_TARGETS.map(cedarPermitId), ...GATEWAY_TARGETS.map(cedarSessionId), "CED-KILL-SWITCH"]);
    for (const policy of policies) expect(policy.validationMode, policy.id).toBe(certain.has(policy.id) ? "IGNORE_ALL_FINDINGS" : "FAIL_ON_ANY_FINDINGS");
  });
});

describe("cited fields: declared in the Gateway schemas with their type and read only behind `has`", () => {
  it("declares every cited field in the schemas generated from zod (npm run tools:build-schemas)", () => {
    expect(schemaProblems(policies, schemas)).toEqual([]);
    for (const policy of policies) expect(unguardedReads(policy.statement), policy.id).toEqual([]);
  });

  it("names each field of `deniedByPolicy` in the policy its schema points to, on every tool that declares it", () => {
    for (const { definition } of allDefinitions()) {
      for (const field of definition.deniedFields) {
        const policy = policies.find((candidate) => parseStatement(candidate.statement).condition?.terms.some((term) => term.kind === "has" && term.field === field));
        expect(policy, `${definition.name}.${field}`).toBeDefined();
        expect(parseStatement(policy?.statement ?? "").actions, `${definition.name}.${field}`).toContain(actionId(definition.name));
      }
    }
    const capOverride = allDefinitions().filter(({ definition }) => definition.deniedFields.includes("capOverride")).map(({ definition }) => definition.name);
    expect(capOverride.sort()).toEqual([...MONEY_TOOLS].sort());
  });

  it("reports a read without `has`, an undeclared field, a wrong type and a tool no permit names", () => {
    const kind = byId("CED-WA-KIND-ALLOWLIST");
    const bare = { ...kind, statement: kind.statement.replace("context.input has kind &&\n  ", "") };
    expect(unguardedReads(bare.statement)).toEqual(["kind"]);
    const whatsapp = schemas["messaging___send_whatsapp"]?.properties ?? {};
    const approval = schemas["handoff___request_operator_approval"]?.properties ?? {};
    const answer = schemas["complaints___answer_complaint_in_writing"]?.properties ?? {};
    const broken: ToolInputSchemas = {
      ...schemas,
      messaging___send_whatsapp: { properties: { ...whatsapp, kind: { type: "object" } } },
      complaints___answer_complaint_in_writing: { properties: { ...answer, requestedAttachments: { type: "string" } } },
      handoff___request_operator_approval: { properties: Object.fromEntries(Object.entries(approval).filter(([field]) => field !== "decision")) },
      handoff___approve_complaint: { properties: { sessionToken: { type: "string" } } },
    };
    expect(schemaProblems([...policies.filter((policy) => policy !== kind), bare], broken)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^CED-WA-KIND-ALLOWLIST: context\.input\.kind is read without/),
        "CED-WA-KIND-ALLOWLIST: messaging___send_whatsapp.kind is compared with strings but is object",
        "CED-ATTACHMENTS-ALLOWLIST: complaints___answer_complaint_in_writing.requestedAttachments is used as a set of strings but is string",
        'CED-NO-SELF-APPROVAL: handoff___request_operator_approval declares no input field "decision"',
        "Gateway tool handoff___approve_complaint is named by no permit",
      ]),
    );
  });

  it("shows why: a forbid that read an absent field without `has` would let the call through", () => {
    const attachments = byId("CED-ATTACHMENTS-ALLOWLIST");
    const bare = { ...attachments, statement: attachments.statement.replace("context.input has requestedAttachments &&\n  ", "") };
    const weakened = [...policies.filter((policy) => policy !== attachments), bare];
    expect(decide("complaints___answer_complaint_in_writing", validInput("complaints___answer_complaint_in_writing"), weakened).errors).toEqual(["CED_ATTACHMENTS_ALLOWLIST"]);
  });
});

describe("[FL-088] the agent cannot approve (CED-NO-SELF-APPROVAL)", () => {
  it("denies request_operator_approval whenever `decision` is present, whatever its value", () => {
    for (const decision of ["APPROVED", "approve", "", "REJECTED"]) {
      const result = decide("handoff___request_operator_approval", { sessionToken: TOKEN, evidenceId: ID, justification: "aprobado", decision });
      expect(result, decision).toEqual({ decision: "DENY", determining: ["CED_NO_SELF_APPROVAL"], errors: [] });
    }
    expect(decide("handoff___request_operator_approval", { sessionToken: TOKEN, evidenceId: ID, justification: "above the cap" }).decision).toBe("ALLOW");
  });

  it("works because `decision` is optional and documented as never set, and no Gateway tool approves", () => {
    const tool = gatewayInlinePayloads.handoff.find((candidate) => candidate.name === "request_operator_approval");
    expect(tool?.inputSchema.properties?.["decision"]?.description).toContain("never set; denied by policy");
    expect(tool?.inputSchema.required ?? []).not.toContain("decision");
    expect(allActionIds().some((id) => /___(approve|decide)/.test(id))).toBe(false);
  });
});

describe("CED-NO-CAP-OVERRIDE: the agent never sets its own cap", () => {
  it("denies the four money tools with a capOverride of any value and nothing else", () => {
    for (const tool of MONEY_TOOLS) {
      expect(decide(actionId(tool), { sessionToken: TOKEN, capOverride: "999999" }).determining, tool).toEqual(["CED_NO_CAP_OVERRIDE"]);
      expect(decide(actionId(tool), { sessionToken: TOKEN }).decision, tool).toBe("ALLOW");
    }
    expect(decide("actions___freeze_outgoing", { sessionToken: TOKEN, capOverride: "1" }).determining).not.toContain("CED_NO_CAP_OVERRIDE");
  });
});

describe("CED-WA-KIND-ALLOWLIST and CED-ATTACHMENTS-ALLOWLIST: allowlists, the zod enums of the tools", () => {
  it("lets WhatsApp carry only the six kinds of the allowlist, and nothing without a kind", () => {
    const brief = read("docs/design-brief.md");
    expect(brief).toContain(`[${AgentWhatsAppKind.options.map((kind) => `"${kind}"`).join(",")}].contains(context.input.kind)`);
    for (const kind of AgentWhatsAppKind.options) expect(decide("messaging___send_whatsapp", { sessionToken: TOKEN, kind }).decision, kind).toBe("ALLOW");
    for (const kind of ["COLLECTION_REMINDER", "COLLECTION_NOTICE_EMAIL", "reply", "REPLY "]) {
      expect(decide("messaging___send_whatsapp", { sessionToken: TOKEN, kind }).determining, kind).toEqual(["CED_WA_KIND_ALLOWLIST"]);
    }
    expect(decide("messaging___send_whatsapp", { sessionToken: TOKEN }).determining).toEqual(["CED_WA_KIND_ALLOWLIST"]);
  });

  it("attaches only documents of the allowlist; no attachments is fine", () => {
    expect(read("docs/design-brief.md")).toContain(`[${AnswerAttachment.options.map((value) => `"${value}"`).join(",")}].containsAll(context.input.requestedAttachments)`);
    const answer = (requestedAttachments?: unknown) => decide("complaints___answer_complaint_in_writing", { ...validInput("complaints___answer_complaint_in_writing"), ...(requestedAttachments === undefined ? {} : { requestedAttachments }) });
    expect(answer().decision).toBe("ALLOW");
    expect(answer([]).decision).toBe("ALLOW");
    expect(answer(["PAYOFF_CERTIFICATE", "STATEMENT"]).decision).toBe("ALLOW");
    expect(answer(["STATEMENT", "IDENTITY_DOCUMENT"]).determining).toEqual(["CED_ATTACHMENTS_ALLOWLIST"]);
    expect(answer(["payoff_certificate"]).determining).toEqual(["CED_ATTACHMENTS_ALLOWLIST"]);
  });
});

describe("sessions and scope", () => {
  it("denies every tool without a sessionToken (CED-SESSION-<TARGET>)", () => {
    for (const action of allActionIds()) {
      const withoutSession = Object.fromEntries(Object.entries(validInput(action)).filter(([field]) => field !== "sessionToken"));
      const result = decide(action, withoutSession);
      expect(result.decision, action).toBe("DENY");
      const target = GATEWAY_TARGETS.find((candidate) => action.startsWith(`${candidate}___`));
      expect(result.determining, action).toContain(policyName(cedarSessionId(target ?? "identity")));
    }
  });

  it("allows only the Harness, only on this Gateway, only the Gateway tools", () => {
    for (const action of allActionIds()) expect(decide(action, validInput(action)).decision, action).toBe("ALLOW");
    const input = validInput("messaging___send_whatsapp");
    expect(evaluateCedar(policies, request("messaging___send_whatsapp", input, { principal: assumedRoleEntityId(ACCOUNT, "someone-else") })).decision).toBe("DENY");
    expect(evaluateCedar(policies, request("messaging___send_whatsapp", input, { resource: `${inputs.gatewayArn}-other` })).decision).toBe("DENY");
    expect(decide("handoff___approve_complaint", { sessionToken: TOKEN })).toEqual({ decision: "DENY", determining: [], errors: [] });
  });

  it("covers the four field fences of @reclamo targets.ts", () => {
    const ids: CedarStatementId[] = ["CED-NO-SELF-APPROVAL", "CED-NO-CAP-OVERRIDE", "CED-ATTACHMENTS-ALLOWLIST", "CED-WA-KIND-ALLOWLIST"];
    for (const id of ids) expect(byId(id).effect).toBe("forbid");
  });
});

describe("[FL-109] kill switch (CED-KILL-SWITCH), the second layer behind KILL#AGENT", () => {
  it("is present and off by default: it denies nothing", () => {
    expect(KILL_SWITCH_ACTIVE).toBe(false);
    const killSwitch = byId("CED-KILL-SWITCH");
    expect(killSwitch.effect).toBe("forbid");
    expect(killSwitch.statement.endsWith("\nwhen {\n  false\n};")).toBe(true);
    expect(parseStatement(killSwitch.statement).actions).toEqual(allActionIds());
    for (const action of allActionIds()) expect(decide(action, validInput(action)).determining, action).not.toContain("CED_KILL_SWITCH");
  });

  it("denies every Gateway tool of the Harness once switched on through IaC, under the same name", () => {
    const switchedOn = cedarPolicies(inputs, { killSwitchActive: true });
    const killSwitch = switchedOn.find((policy) => policy.id === "CED-KILL-SWITCH");
    expect(killSwitch?.statement.endsWith(`resource == AgentCore::Gateway::"${inputs.gatewayArn}"\n);`)).toBe(true);
    expect(killSwitch?.name).toBe(byId("CED-KILL-SWITCH").name);
    for (const action of allActionIds()) expect(evaluateCedar(switchedOn, request(action, validInput(action))).determining, action).toContain("CED_KILL_SWITCH");
  });
});
