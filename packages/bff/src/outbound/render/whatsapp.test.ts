// Step 2 of the gate for WhatsApp: what the customer reads and taps, decided by code (FL-001: the
// disclosure line and "Hablar con alguien" never depend on the model).
import { ToolError } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { AUTOMATED_DISCLOSURE, buttonTitle, renderTemplateBody } from "../../copy";
import { renderWhatsApp, toWaOutbound } from "./whatsapp";

const LOANS = [
  { loanId: "L-0001", label: "Préstamo personal 0001" },
  { loanId: "L-0002", label: "Préstamo personal en pesos de dieciocho cuotas 0002" },
];

function expectInvalid(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("INVALID");
    return;
  }
  throw new Error("expected ToolError INVALID");
}

describe("WhatsApp render: text [FL-001]", () => {
  it("puts the fixed disclosure line first and adds 'Hablar con alguien' to an agent's first message [FL-001]", () => {
    const draft = renderWhatsApp({ request: { text: "¿En qué te puedo ayudar?" }, senderClass: "AGENT", disclose: true, loans: [] });
    expect(draft.shape).toBe("buttons");
    expect(draft.disclosure).toBe(true);
    expect(draft.text).toBe(`${AUTOMATED_DISCLOSURE}\n\n¿En qué te puedo ayudar?`);
    expect(draft.buttons.map((button) => [button.action, "title" in button ? button.title : ""])).toEqual([["TALK_TO_HUMAN", "Hablar con alguien"]]);
  });

  it("renders the same text without the line once the epoch was disclosed [FL-001]", () => {
    const draft = renderWhatsApp({ request: { text: "Listo, ya lo registré." }, senderClass: "SYSTEM", disclose: false, loans: [] });
    expect(draft.text).toBe("Listo, ya lo registré.");
    expect(draft.disclosure).toBe(false);
  });

  it("adds no derivation button to an operator's message (the operator is the person)", () => {
    const draft = renderWhatsApp({ request: { text: "Hola, soy Laura del equipo de atención." }, senderClass: "OPERATOR", disclose: true, loans: [] });
    expect(draft.shape).toBe("text");
    expect(draft.buttons).toEqual([]);
    expect(draft.text.startsWith(AUTOMATED_DISCLOSURE)).toBe(true);
  });

  it("keeps the buttons asked for, adds 'Hablar con alguien' once and last, bound to the complaint", () => {
    const draft = renderWhatsApp({ request: { text: "¿Te mando la respuesta a ese email?", complaintId: "cmp-0001", buttons: [{ action: "ACCEPT_EMAIL" }, { action: "DECLINE_EMAIL" }] }, senderClass: "AGENT", disclose: false, loans: [] });
    expect(draft.buttons.map((button) => button.action)).toEqual(["ACCEPT_EMAIL", "DECLINE_EMAIL", "TALK_TO_HUMAN"]);
    expect(draft.buttons.every((button) => button.complaintId === "cmp-0001")).toBe(true);
    const asked = renderWhatsApp({ request: { text: "Te paso con alguien.", buttons: [{ action: "TALK_TO_HUMAN" }] }, senderClass: "AGENT", disclose: false, loans: [] });
    expect(asked.buttons.map((button) => button.action)).toEqual(["TALK_TO_HUMAN"]);
  });

  it("every title comes from copy/buttons.ts and fits its form", () => {
    const draft = renderWhatsApp({ request: { text: "¿Querés dejar de recibir mensajes?", buttons: [{ action: "OPT_OUT" }] }, senderClass: "SYSTEM", disclose: false, loans: [] });
    for (const button of draft.buttons) {
      const title = "title" in button ? button.title : "";
      expect(title).toBe(buttonTitle(button.action, "INTERACTIVE"));
      expect([...title].length).toBeLessThanOrEqual(20);
    }
  });

  it("makes a list of the customer's loans as the core names them, with the person row", () => {
    const draft = renderWhatsApp({ request: { text: "¿Sobre qué préstamo es?", buttons: [{ action: "CHOOSE_LOAN", ref: "L-0001" }, { action: "CHOOSE_LOAN", ref: "L-0002" }] }, senderClass: "AGENT", disclose: false, loans: LOANS });
    expect(draft.shape).toBe("list");
    if (draft.shape !== "list") return;
    expect(draft.menu).toBe(buttonTitle("CHOOSE_LOAN", "LIST_MENU"));
    expect(draft.buttons.map((row) => row.title)).toEqual(["Préstamo personal 0001", "Préstamo personal en pe…", "Hablar con una persona"]);
    expect(draft.buttons.every((row) => [...row.title].length <= 24)).toBe(true);
  });

  it("refuses a loan the customer does not have, a fourth reply button, a button in the wrong form and an empty text", () => {
    expectInvalid(() => renderWhatsApp({ request: { text: "¿Cuál?", buttons: [{ action: "CHOOSE_LOAN", ref: "L-9999" }] }, senderClass: "AGENT", disclose: false, loans: LOANS }));
    expectInvalid(() => renderWhatsApp({ request: { text: "Elegí", buttons: [{ action: "ACCEPT_EMAIL" }, { action: "DECLINE_EMAIL" }, { action: "OPT_OUT" }] }, senderClass: "AGENT", disclose: false, loans: [] }));
    expectInvalid(() => renderWhatsApp({ request: { text: "Ver", buttons: [{ action: "SEE_DETAIL" }] }, senderClass: "AGENT", disclose: false, loans: [] }));
    expectInvalid(() => renderWhatsApp({ request: { text: "   " }, senderClass: "AGENT", disclose: false, loans: [] }));
  });

  it("refuses a body over the limit of its shape", () => {
    expectInvalid(() => renderWhatsApp({ request: { text: "a".repeat(4_097) }, senderClass: "OPERATOR", disclose: false, loans: [] }));
    expectInvalid(() => renderWhatsApp({ request: { text: "a".repeat(1_025) }, senderClass: "AGENT", disclose: false, loans: [] }));
  });
});

describe("WhatsApp render: template", () => {
  it("renders the template body with its parameters and its own quick-reply buttons, never the disclosure", () => {
    const draft = renderWhatsApp({ request: { template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"] }, complaintId: "cmp-0001" }, senderClass: "AGENT", disclose: true, loans: [] });
    expect(draft.shape).toBe("template");
    expect(draft.disclosure).toBe(false);
    expect(draft.text).toBe(renderTemplateBody("reclamo_novedad", ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"]));
    expect(draft.text).toContain("ya tenemos la rendición de la red");
    expect(draft.buttons).toEqual([
      { action: "SEE_DETAIL", complaintId: "cmp-0001" },
      { action: "TALK_TO_HUMAN", complaintId: "cmp-0001" },
    ]);
  });

  it("refuses a template with extra buttons or with a text beside it", () => {
    expectInvalid(() => renderWhatsApp({ request: { template: { name: "reclamo_derivado", params: ["R-2026-000123", "jueves 22/10"] }, buttons: [{ action: "OPT_OUT" }] }, senderClass: "SYSTEM", disclose: false, loans: [] }));
    expectInvalid(() => renderWhatsApp({ request: { template: { name: "reclamo_derivado", params: ["R-2026-000123", "jueves 22/10"] }, text: "y además…" }, senderClass: "SYSTEM", disclose: false, loans: [] }));
  });
});

describe("WhatsApp render: transport message", () => {
  it("puts one nonce per button, in order, as the reply ids", () => {
    const draft = renderWhatsApp({ request: { text: "¿A ese email?", buttons: [{ action: "ACCEPT_EMAIL" }] }, senderClass: "AGENT", disclose: false, loans: [] });
    expect(toWaOutbound(draft, ["n-1", "n-2"])).toEqual({ kind: "buttons", body: "¿A ese email?", buttons: [{ id: "n-1", title: "Sí, a ese email" }, { id: "n-2", title: "Hablar con alguien" }] });
    const template = renderWhatsApp({ request: { template: { name: "reclamo_respuesta_no_entregada", params: ["R-2026-000123"] } }, senderClass: "SYSTEM", disclose: false, loans: [] });
    expect(toWaOutbound(template, ["n-9"])).toEqual({ kind: "template", name: "reclamo_respuesta_no_entregada", values: ["R-2026-000123"], nonces: ["n-9"] });
    const text = renderWhatsApp({ request: { text: "Hola." }, senderClass: "OPERATOR", disclose: false, loans: [] });
    expect(toWaOutbound(text, [])).toEqual({ kind: "text", body: "Hola." });
  });

  it("never sends a button without its nonce", () => {
    const draft = renderWhatsApp({ request: { text: "Hola." }, senderClass: "AGENT", disclose: false, loans: [] });
    expect(() => toWaOutbound(draft, [])).toThrow(RangeError);
  });
});
