import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkGatewayBuild } from "./build-schemas";
import { allDefinitions } from "./catalog";
import { boundedText, defineTool } from "./define";
import { type GatewaySchemaNode, SUPPORTED_WORDS, buildGatewayPayloads, payloadDigest, toGatewayNode, unsupportedWords } from "./gateway-schema";
import { EXPECTED_TOOL_COUNT, GATEWAY_TOOLS, ToolTarget } from "./targets";

const build = buildGatewayPayloads();

function toolSchema(target: ToolTarget, tool: string): GatewaySchemaNode {
  const found = build.payloads[target].find((definition) => definition.name === tool);
  if (found === undefined) throw new Error(`${target}___${tool} has no schema`);
  return found.inputSchema;
}

function words(node: GatewaySchemaNode): string[] {
  return [...Object.keys(node), ...Object.values(node.properties ?? {}).flatMap(words), ...(node.items ? words(node.items) : [])];
}

describe("tools:build-schemas: seven inlinePayloads with only the words the Gateway supports", () => {
  it("builds 7 targets and 28 tools, each in its target and in catalog order, without problems", () => {
    expect(checkGatewayBuild(build)).toEqual([]);
    expect(Object.keys(build.payloads)).toEqual(ToolTarget.options);
    for (const target of ToolTarget.options) expect(build.payloads[target].map((tool) => tool.name)).toEqual([...GATEWAY_TOOLS[target]]);
    expect(Object.values(build.payloads).flat()).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(allDefinitions()).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("uses only type, properties, required, items and description in every node of every tool", () => {
    for (const tool of Object.values(build.payloads).flat()) {
      expect(unsupportedWords(tool.inputSchema, tool.name)).toEqual([]);
      for (const word of words(tool.inputSchema)) expect(SUPPORTED_WORDS as readonly string[]).toContain(word);
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it("requires sessionToken on every tool and folds enums and bounds into the description", () => {
    for (const tool of Object.values(build.payloads).flat()) expect(tool.inputSchema.required).toContain("sessionToken");
    expect(toolSchema("complaints", "register_complaint").properties?.["kind"]?.description).toContain("One of: CONSULTA, RECLAMO.");
    expect(toolSchema("complaints", "register_complaint").properties?.["summary"]?.description).toContain("At most 200 characters.");
    expect(toolSchema("messaging", "send_whatsapp").properties?.["buttons"]?.description).toContain("At most 3 items.");
  });

  it("declares decision and capOverride as never-set strings, optional, so the Cedar forbids are valid, and nowhere else", () => {
    const money = ["apply_payment", "reverse_charge", "refund_duplicate_debit", "request_transfer_reversal"];
    for (const tool of Object.values(build.payloads).flat()) {
      const capOverride = tool.inputSchema.properties?.["capOverride"];
      const decision = tool.inputSchema.properties?.["decision"];
      if (money.includes(tool.name)) expect(capOverride).toEqual({ type: "string", description: "never set; denied by policy" });
      else expect(capOverride, tool.name).toBeUndefined();
      if (tool.name === "request_operator_approval") expect(decision).toEqual({ type: "string", description: "never set; denied by policy" });
      else expect(decision, tool.name).toBeUndefined();
      expect(tool.inputSchema.required ?? []).not.toContain("capOverride");
      expect(tool.inputSchema.required ?? []).not.toContain("decision");
    }
  });

  it("never lets the model name a recipient and keeps the WhatsApp kinds and attachments to their allowlists", () => {
    const serialized = JSON.stringify(build.payloads);
    expect(serialized).not.toContain("recipientRole");
    expect(Object.keys(toolSchema("messaging", "send_whatsapp").properties ?? {})).toEqual(["sessionToken", "kind", "text", "template", "buttons", "complaintId"]);
    const kind = toolSchema("messaging", "send_whatsapp").properties?.["kind"]?.description ?? "";
    expect(kind).toContain("One of: REPLY, IDENTITY_CHALLENGE, RECEIPT_REQUEST, COMPLAINT_UPDATE, RESOLUTION_NOTICE, OUT_OF_SCOPE_REFUSAL.");
    expect(kind).not.toContain("COLLECTION");
    expect(toolSchema("complaints", "answer_complaint_in_writing").properties?.["requestedAttachments"]?.items?.description).toBe("One of: PAYOFF_CERTIFICATE, CREDIT_NOTE, STATEMENT.");
  });

  it("gives the same digest for the same payload and another for any change", () => {
    const digest = payloadDigest(build.payloads.handoff);
    expect(payloadDigest(buildGatewayPayloads().payloads.handoff)).toBe(digest);
    expect(payloadDigest([...build.payloads.handoff].reverse())).not.toBe(digest);
  });
});

describe("the build fails instead of publishing a schema that says less than zod", () => {
  it("reports a word outside the subset (anyOf, a list of types)", () => {
    const problems: string[] = [];
    toGatewayNode({ type: "object", properties: { x: { anyOf: [{ type: "string" }, { type: "number" }] } } }, "t", problems);
    expect(problems.some((problem) => problem.includes('unsupported word "anyOf"'))).toBe(true);
    expect(unsupportedWords({ type: ["string", "null"] }, "t")).toEqual(['t: "type" ["string","null"] is not a Gateway type']);
  });

  it("reports a union field, a missing tool and a tool of another target", () => {
    const union = defineTool({ name: "send_whatsapp", description: "A tool with a field the Gateway cannot say.", fields: { text: z.union([z.string(), z.number()]) } });
    const broken = buildGatewayPayloads((target) => (target === "messaging" ? [union] : target === "handoff" ? [] : allDefinitions().filter((entry) => entry.target === target).map((entry) => entry.definition)));
    const problems = checkGatewayBuild(broken);
    expect(problems.some((problem) => problem.includes("send_whatsapp.text"))).toBe(true);
    expect(problems).toContain("handoff___escalate_to_human: tool without schema");
    expect(problems).toContain(`the Gateway has ${EXPECTED_TOOL_COUNT - 2} tools, expected ${EXPECTED_TOOL_COUNT}`);

    const stray = defineTool({ name: "escalate_to_human", description: "A tool declared under the wrong target.", fields: { summary: boundedText(10, "x") } });
    const misplaced = buildGatewayPayloads((target) => [...allDefinitions().filter((entry) => entry.target === target).map((entry) => entry.definition), ...(target === "identity" ? [stray] : [])]);
    expect(checkGatewayBuild(misplaced)).toContain("identity___escalate_to_human: not a tool of the identity target");
  });

  it("refuses at definition time a tool that declares the principal, a recipient or a scope path with no field", () => {
    expect(() => defineTool({ name: "send_whatsapp", description: "x", fields: { sessionToken: z.string() } })).toThrow(/sessionToken/);
    expect(() => defineTool({ name: "send_whatsapp", description: "x", fields: { recipientRole: z.string() } })).toThrow(/recipientRole/);
    expect(() => defineTool({ name: "send_whatsapp", description: "x", fields: {}, scoped: { complaintId: "COMPLAINT" } })).toThrow(/complaintId/);
  });
});
