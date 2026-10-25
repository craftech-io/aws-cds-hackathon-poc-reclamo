// `channels:whatsapp-templates` (docs/architecture-integrations.md §3.4 step 5) against a mocked End User Messaging Social
// SDK and an in-memory `Reference` table: nothing runs before the product's WABA is connected, the plan
// writes nothing, `--apply` creates only the missing templates in Meta's format and records each one's
// id, status and category, and a template Meta files outside UTILITY is never sendable.
import { CreateWhatsAppMessageTemplateCommand, ListWhatsAppMessageTemplatesCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { TEMPLATE_REFERENCE } from "../../packages/bff/src/channels/whatsapp/template-records";
import { keys } from "../../packages/bff/src/connector/keys";
import { MemoryStore } from "../../packages/bff/src/connector/memory/engine";
import { WHATSAPP_TEMPLATES } from "../../packages/bff/src/copy/templates";
import type { TemplateName } from "../../packages/bff/src/copy/types";
import { type TemplatesDeps, metaDefinition, parseStageArgs, runTemplates, stageDeps, statusOf, wabaIdOf } from "./whatsapp-templates";

const social = mockClient(SocialMessagingClient);
const NAMES = Object.keys(WHATSAPP_TEMPLATES) as TemplateName[];
const keyOf = (name: TemplateName) => keys.reference(TEMPLATE_REFERENCE.type, TEMPLATE_REFERENCE.scope, name);

let store: MemoryStore;
let lines: string[];

async function seedRows(names: readonly TemplateName[] = NAMES): Promise<void> {
  for (const name of names) {
    await store.write({ kind: "put", table: "Reference", item: { ...keyOf(name), name, status: "LOCAL_ONLY", category: "UTILITY", language: "es_AR" } });
  }
}

function deps(secret = "waba-0123456789abcdef"): TemplatesDeps {
  return { ...stageDeps(new SocialMessagingClient({ region: "us-east-1" }), store), wabaSecret: () => secret, report: (line) => void lines.push(line) };
}

const row = async (name: TemplateName) => store.get("Reference", keyOf(name));

beforeEach(() => {
  social.reset();
  store = new MemoryStore();
  lines = [];
});

describe("channels:whatsapp-templates arguments and secret", () => {
  it("needs --stage poc and refuses unknown flags", () => {
    expect(() => parseStageArgs(["--apply"])).toThrow(/--stage poc/);
    expect(() => parseStageArgs(["--stage", "prod"])).toThrow(/--stage poc/);
    expect(() => parseStageArgs(["--stage", "poc", "--force"])).toThrow(/unknown argument/);
    expect(parseStageArgs(["--stage", "poc", "--apply"])).toEqual({ stage: "poc", apply: true });
  });

  it("reads the WABA id from the secret, as an id or an ARN, and never echoes a bad value", () => {
    expect(wabaIdOf("not-connected")).toBeUndefined();
    expect(wabaIdOf(" waba-0123456789abcdef ")).toBe("waba-0123456789abcdef");
    expect(wabaIdOf("arn:aws:social-messaging:us-east-1:776805327629:waba/0123456789abcdef")).toBe("waba-0123456789abcdef");
    const bad = "secret-looking-value-42";
    expect(() => wabaIdOf(bad)).toThrow(RangeError);
    try {
      wabaIdOf(bad);
    } catch (error) {
      expect(String(error)).not.toContain(bad);
    }
  });

  it("does nothing while the WABA is not configured", async () => {
    await seedRows();
    await expect(runTemplates({ stage: "poc", apply: true }, deps("not-connected"))).rejects.toThrow(/WabaId is not-connected/);
    expect(social.calls()).toHaveLength(0);
  });
});

describe("Meta's definition", () => {
  it("is UTILITY es_AR with the body, its examples and the quick-reply titles of copy/buttons.ts", () => {
    const definition = metaDefinition(WHATSAPP_TEMPLATES.reclamo_novedad);
    expect(definition).toMatchObject({ name: "reclamo_novedad", language: "es_AR", category: "UTILITY" });
    const [body, buttons] = definition.components as Array<Record<string, unknown>>;
    expect(body).toEqual({ type: "BODY", text: WHATSAPP_TEMPLATES.reclamo_novedad.body, example: { body_text: [[...WHATSAPP_TEMPLATES.reclamo_novedad.examples]] } });
    expect(buttons).toEqual({ type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Ver detalle" }, { type: "QUICK_REPLY", text: "Hablar con una persona" }] });
    expect(metaDefinition(WHATSAPP_TEMPLATES.reclamo_derivado).components).toHaveLength(1);
    for (const name of NAMES) {
      const template = WHATSAPP_TEMPLATES[name];
      expect(template.examples, name).toHaveLength(template.params.length);
    }
  });

  it("maps Meta's status, and anything outside UTILITY to DISABLED", () => {
    expect(statusOf("approved", "UTILITY")).toBe("APPROVED");
    expect(statusOf("IN_APPEAL", "UTILITY")).toBe("PENDING");
    expect(statusOf(undefined, undefined)).toBe("PENDING");
    expect(statusOf("APPROVED", "MARKETING")).toBe("DISABLED");
  });
});

describe("channels:whatsapp-templates against the SDK", () => {
  const existing = { templateName: "reclamo_resuelto", templateLanguage: "es_AR", metaTemplateId: "111", templateStatus: "APPROVED", templateCategory: "UTILITY" };

  it("pages through Meta's list and, without --apply, creates and records nothing", async () => {
    await seedRows();
    social
      .on(ListWhatsAppMessageTemplatesCommand, { id: "waba-0123456789abcdef" })
      .resolvesOnce({ templates: [existing], nextToken: "page-2" })
      .resolvesOnce({ templates: [{ templateName: "otro", templateLanguage: "es_AR" }] });
    expect(await runTemplates(parseStageArgs(["--stage", "poc"]), deps())).toEqual({ created: 0, existing: 1 });
    expect(social.commandCalls(ListWhatsAppMessageTemplatesCommand)).toHaveLength(2);
    expect(social.commandCalls(ListWhatsAppMessageTemplatesCommand)[1]?.args[0].input).toMatchObject({ nextToken: "page-2" });
    expect(social.commandCalls(CreateWhatsAppMessageTemplateCommand)).toHaveLength(0);
    for (const name of NAMES) expect((await row(name))?.status, name).toBe("LOCAL_ONLY");
    expect(lines.filter((line) => line.includes("would be created"))).toHaveLength(NAMES.length - 1);
  });

  it("with --apply creates only the missing ones and records id, status and category", async () => {
    await seedRows();
    social.on(ListWhatsAppMessageTemplatesCommand).resolves({ templates: [existing] });
    social.on(CreateWhatsAppMessageTemplateCommand).callsFake((input: { templateDefinition: Uint8Array }) => {
      const definition = JSON.parse(new TextDecoder().decode(input.templateDefinition)) as { name: string };
      return { metaTemplateId: `meta-${definition.name}`, templateStatus: "PENDING", category: "UTILITY" };
    });
    expect(await runTemplates(parseStageArgs(["--stage", "poc", "--apply"]), deps())).toEqual({ created: NAMES.length - 1, existing: 1 });
    const created = social.commandCalls(CreateWhatsAppMessageTemplateCommand).map((call) => JSON.parse(new TextDecoder().decode(call.args[0].input.templateDefinition)) as Record<string, unknown>);
    expect(created.map((definition) => definition.name).sort()).toEqual(NAMES.filter((name) => name !== "reclamo_resuelto").sort());
    for (const definition of created) expect(definition).toMatchObject({ category: "UTILITY", language: "es_AR" });
    expect(await row("reclamo_resuelto")).toMatchObject({ status: "APPROVED", metaTemplateId: "111", metaCategory: "UTILITY", category: "UTILITY" });
    expect(await row("reclamo_novedad")).toMatchObject({ status: "PENDING", metaTemplateId: "meta-reclamo_novedad", name: "reclamo_novedad" });
  });

  it("records a template Meta filed as MARKETING as DISABLED and says so", async () => {
    await seedRows();
    social.on(ListWhatsAppMessageTemplatesCommand).resolves({ templates: NAMES.map((name) => ({ templateName: name, templateLanguage: "es_AR", templateStatus: "APPROVED", templateCategory: name === "reclamo_novedad" ? "MARKETING" : "UTILITY" })) });
    expect(await runTemplates({ stage: "poc", apply: true }, deps())).toEqual({ created: 0, existing: NAMES.length });
    expect(await row("reclamo_novedad")).toMatchObject({ status: "DISABLED", metaCategory: "MARKETING" });
    expect(lines.some((line) => line.includes("reclamo_novedad") && line.includes("DISABLED"))).toBe(true);
  });

  it("refuses to record a template the seed never wrote", async () => {
    await seedRows(NAMES.filter((name) => name !== "reclamo_derivado"));
    social.on(ListWhatsAppMessageTemplatesCommand).resolves({ templates: NAMES.map((name) => ({ templateName: name, templateLanguage: "es_AR", templateStatus: "APPROVED", templateCategory: "UTILITY" })) });
    await expect(runTemplates({ stage: "poc", apply: true }, deps())).rejects.toThrow();
    expect(await row("reclamo_derivado")).toBeUndefined();
  });
});
