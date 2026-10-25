// Step 4 of the gate: the deterministic verification of exactly what the customer will read
// (figures of the turn, template parameters, language, collection and payment lexicon on every
// WhatsApp, credit offers, sensitive asks, foreign contacts). A failure names checks, never the text.
import { describe, expect, it } from "vitest";
import { STAGE_DOMAIN } from "../channel-policy/types";
import { renderTemplateBody } from "../copy";
import { type VerifyInput, failureCodeOf, verifyOutbound } from "./verify";

const RESULTS = [
  { tool: "get_loan", loanId: "L-0008", outstanding: "$ 128.420,00", outstandingCents: 12_842_000 },
  { tool: "get_instalments", next: { number: 5, dueDate: "22/10/2026", amount: "$ 64.210,00" } },
  { tool: "get_complaint", complaintNumber: "R-2026-000123", deadlineText: "jueves 22/10" },
];

function input(overrides: Partial<VerifyInput>): VerifyInput {
  const text = overrides.freeText ?? overrides.rendered ?? "";
  return { channel: "WHATSAPP", kind: "REPLY", senderClass: "AGENT", rendered: text, freeText: text, results: RESULTS, stageDomains: [STAGE_DOMAIN], ...overrides };
}

const checks = (failures: ReturnType<typeof verifyOutbound>) => failures.map((failure) => [failure.check, failure.ruleId]);

describe("verify: a grounded answer goes out [FL-008]", () => {
  it("an inquiry answered with the balance and the due date the tools returned passes, with no collection reading [FL-008]", () => {
    const text = "Te quedan $ 128.420,00 en el préstamo. La próxima cuota es de $ 64.210,00 y vence el 22/10/2026.";
    expect(verifyOutbound(input({ freeText: text, rendered: text }))).toEqual([]);
  });

  it("a complaint number and a deadline of the results pass [FL-008]", () => {
    const text = "Tu reclamo R-2026-000123 sigue en curso; el plazo vence el jueves 22/10.";
    expect(verifyOutbound(input({ freeText: text, rendered: text }))).toEqual([]);
  });
});

describe("verify: figures that no tool returned [FL-062]", () => {
  it("an amount absent from the turn's results is GROUNDING_FAIL on VERIFY [FL-062]", () => {
    const failures = verifyOutbound(input({ freeText: "Te quedan $ 99.999,00 para cancelar." }));
    expect(checks(failures)).toEqual([["FIGURES", "VERIFY"]]);
    expect(failureCodeOf(failures)).toBe("GROUNDING_FAIL");
    expect(failures[0]?.detail).not.toContain("99.999");
  });

  it("a number of four or more digits absent from the results fails, a short one does not [FL-062]", () => {
    expect(checks(verifyOutbound(input({ freeText: "Tu reclamo R-2026-000999 sigue abierto." })))).toEqual([["FIGURES", "VERIFY"]]);
    expect(verifyOutbound(input({ freeText: "Es la cuota 5 de tu préstamo." }))).toEqual([]);
  });

  it("an amount written in words fails closed [FL-062]", () => {
    expect(checks(verifyOutbound(input({ freeText: "Te quedan mil quinientos pesos." })))).toEqual([["FIGURES", "VERIFY"]]);
  });

  it("[FL-007] [FL-030] the message's own complaint number and deadline ground a free text that no tool of the turn repeated; another complaint's number does not", () => {
    const results = RESULTS.slice(0, 2);
    const complaint = { complaintNumber: "R-2026-000123", deadlineSim: "2026-10-22T15:00:00.000Z" };
    const text = "Ya registré tu reclamo (número R-2026-000123); la respuesta escrita te llega a más tardar el jueves 22/10.";
    expect(checks(verifyOutbound(input({ freeText: text, results })))).toEqual([["FIGURES", "VERIFY"]]);
    expect(verifyOutbound(input({ freeText: text, results, complaint }))).toEqual([]);
    expect(verifyOutbound(input({ channel: "EMAIL", kind: "FORMAL_ANSWER", freeText: `Respuesta a tu reclamo R-2026-000123.`, results, complaint }))).toEqual([]);
    expect(checks(verifyOutbound(input({ freeText: "Tu reclamo R-2026-000124 sigue abierto.", results, complaint })))).toEqual([["FIGURES", "VERIFY"]]);
  });

  it("[FL-024] a written answer may quote what the complaint's case file proved in an earlier turn (passed with the results)", () => {
    const caseFacts = { caseFile: { readings: [{ operationCode: "NTE-20261005-010014-0", amount: "$ 312.400,00" }], matches: [], actions: [{ amount: "$ 312.400,00" }], approvals: [] } };
    const text = "Imputamos el pago NTE-20261005-010014-0 por $ 312.400,00.";
    expect(checks(verifyOutbound(input({ channel: "EMAIL", kind: "FORMAL_ANSWER", freeText: text, results: [] })))).toEqual([["FIGURES", "VERIFY"]]);
    expect(verifyOutbound(input({ channel: "EMAIL", kind: "FORMAL_ANSWER", freeText: text, results: [caseFacts] }))).toEqual([]);
  });

  it("an operator's or the system's text is not compared with the agent's turn", () => {
    expect(verifyOutbound(input({ senderClass: "OPERATOR", freeText: "Te reintegramos $ 7.777,00." }))).toEqual([]);
    expect(verifyOutbound(input({ senderClass: "SYSTEM", freeText: undefined, rendered: "Tu reclamo R-2026-000555 quedó registrado." }))).toEqual([]);
  });
});

describe("verify: template parameters", () => {
  it("a parameter the agent filled is a value of the results; the status phrase comes from the closed list", () => {
    const params = ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"];
    const rendered = renderTemplateBody("reclamo_novedad", params);
    const results = [...RESULTS, { tool: "get_customer", firstName: "Valeria" }];
    expect(verifyOutbound(input({ freeText: undefined, rendered, template: { name: "reclamo_novedad", params }, results }))).toEqual([]);
    const loose = verifyOutbound(input({ freeText: undefined, rendered, template: { name: "reclamo_novedad", params: ["Ricardo", "R-2026-000123", "SETTLEMENT_PUBLISHED"] }, results }));
    expect(checks(loose)).toEqual([["PARAMS", "VERIFY"]]);
    expect(loose[0]?.detail).toBe("template parameter 1 is not a value of this turn's tool results");
  });

  it("a truncated complaint number is not grounded, though a result contains it as a substring", () => {
    const params = ["R-2026-00012", "jueves 22/10"];
    const failures = verifyOutbound(input({ freeText: undefined, rendered: renderTemplateBody("reclamo_derivado", params), template: { name: "reclamo_derivado", params } }));
    expect(checks(failures)).toEqual([["PARAMS", "VERIFY"]]);
    expect(failures[0]?.detail).toBe("template parameter 1 is not a value of this turn's tool results");
  });

  it("a complaint number must have the register's format and be exactly one the turn or the message's complaint has", () => {
    const template = (number: string) => ({ name: "reclamo_derivado" as const, params: [number, "jueves 22/10"] });
    const rendered = (number: string) => renderTemplateBody("reclamo_derivado", [number, "jueves 22/10"]);
    expect(checks(verifyOutbound(input({ freeText: undefined, rendered: rendered("r-2026-000123 "), template: template("r-2026-000123 ") })))).toEqual([["PARAMS", "VERIFY"]]);
    expect(verifyOutbound(input({ freeText: undefined, rendered: rendered("R-2026-000777"), template: template("R-2026-000777"), complaint: { complaintNumber: "R-2026-000777", deadlineSim: "2026-10-23T02:59:59Z" } }))).toEqual([]);
    expect(checks(verifyOutbound(input({ freeText: undefined, rendered: rendered("R-2026-000777"), template: template("R-2026-000777") })))).toEqual([["PARAMS", "VERIFY"]]);
  });

  it("a first name and a masked email are exactly the core's values, never a fragment of any result", () => {
    const results = [...RESULTS, { tool: "get_customer", firstName: "Valeria", emailMasked: "v•••@…" }, { tool: "read_receipt", fields: { payerReference: "Valentina Ruiz" } }];
    const novedad = (name: string) => ({ freeText: undefined, rendered: renderTemplateBody("reclamo_novedad", [name, "R-2026-000123", "SETTLEMENT_PUBLISHED"]), template: { name: "reclamo_novedad" as const, params: [name, "R-2026-000123", "SETTLEMENT_PUBLISHED"] }, results });
    expect(verifyOutbound(input(novedad("Valeria")))).toEqual([]);
    expect(checks(verifyOutbound(input(novedad("Vale"))))).toEqual([["PARAMS", "VERIFY"]]);
    expect(checks(verifyOutbound(input(novedad("Valentina"))))).toEqual([["PARAMS", "VERIFY"]]);
    const email = (masked: string) => ({ freeText: undefined, rendered: renderTemplateBody("reclamo_resuelto", ["R-2026-000123", masked]), template: { name: "reclamo_resuelto" as const, params: ["R-2026-000123", masked] }, results });
    expect(verifyOutbound(input(email("v•••@…")))).toEqual([]);
    expect(checks(verifyOutbound(input(email("v•••"))))).toEqual([["PARAMS", "VERIFY"]]);
  });

  it("a deadline is exactly a deadlineText of the results or the message's complaint's deadline, never a fragment or another value", () => {
    const derivado = (deadline: string, overrides: Partial<VerifyInput> = {}) => {
      const params = ["R-2026-000123", deadline];
      return verifyOutbound(input({ freeText: undefined, rendered: renderTemplateBody("reclamo_derivado", params), template: { name: "reclamo_derivado", params }, ...overrides }));
    };
    expect(derivado("jueves 22/10")).toEqual([]);
    expect(derivado("Jueves  22/10 ")).toEqual([]);
    for (const loose of ["jueves 2", "22/1", "22/10", "R-2026-000123", "viernes 23/10"]) {
      const failures = derivado(loose);
      expect(checks(failures), loose).toEqual([["PARAMS", "VERIFY"]]);
      expect(failures[0]?.detail, loose).toBe("template parameter 2 is not a value of this turn's tool results");
    }
    const withoutDeadline = RESULTS.map((result) => ("deadlineText" in result ? { tool: result.tool, complaintNumber: result.complaintNumber } : result));
    expect(checks(derivado("jueves 22/10", { results: withoutDeadline }))).toEqual([["PARAMS", "VERIFY"]]);
    expect(derivado("jueves 22/10", { results: withoutDeadline, complaint: { complaintNumber: "R-2026-000123", deadlineSim: "2026-10-23T02:59:59Z" } })).toEqual([]);
    // A deadline phrase inside a longer text of the results is not a value of a deadline field.
    expect(checks(derivado("jueves 22/10", { results: [...withoutDeadline, { tool: "get_complaint", note: "vence el jueves 22/10 a la noche" }] }))).toEqual([["PARAMS", "VERIFY"]]);
  });
});

describe("verify: language", () => {
  it("a text to the customer is written in Spanish", () => {
    const failures = verifyOutbound(input({ freeText: "Your complaint is still under review and we will get back to you soon." }));
    expect(checks(failures)).toEqual([["LANGUAGE", "VERIFY"]]);
  });
});

describe("verify: a payment request by WhatsApp [FL-068]", () => {
  it("the agent's draft that tells the customer to pay to a CVU is blocked by the payment rule and the sensitive-data rule [FL-068]", () => {
    const text = "Podés pagar el saldo al CVU 0000003100099999999990 hoy mismo.";
    const failures = verifyOutbound(input({ freeText: text, rendered: text, results: [...RESULTS, { cvu: "0000003100099999999990" }] }));
    const rules = failures.map((failure) => failure.ruleId);
    expect(rules).toContain("CH-WA-NO-PAYMENT-REQUEST");
    expect(rules).toContain("CH-NO-SENSITIVE-ASK");
    expect(failureCodeOf(failures)).toBe("POLICY_DENIED");
    expect(failures.map((failure) => failure.detail).join(" ")).not.toContain("0000003100099999999990");
  });

  it("collection wording is blocked on every WhatsApp, whoever sends it, and never on an email [FL-068]", () => {
    const text = "Recordá que tenés la cuota vencida: pagala hoy para evitar recargos.";
    for (const senderClass of ["AGENT", "OPERATOR", "SYSTEM"] as const) {
      const failures = verifyOutbound(input({ senderClass, freeText: senderClass === "SYSTEM" ? undefined : text, rendered: text }));
      expect(failures[0]?.ruleId).toBe("CH-WA-NO-COLLECTION");
      expect(failures[0]?.categories?.length).toBeGreaterThan(0);
    }
    expect(verifyOutbound(input({ channel: "EMAIL", kind: "FORMAL_ANSWER", senderClass: "OPERATOR", freeText: text, rendered: text })).map((failure) => failure.ruleId)).not.toContain("CH-WA-NO-COLLECTION");
  });

  it("[FL-064] a refusal says how to rewrite (number, due date, amount, statusText), never which words matched", () => {
    const text = "El estado del préstamo es en mora y la cuota 5 aparece como impaga.";
    const [failure] = verifyOutbound(input({ freeText: text, rendered: text }));
    expect(failure).toMatchObject({ ruleId: "CH-WA-NO-COLLECTION", categories: ["DEBT_REMINDER"] });
    expect(failure?.detail).toMatch(/only by its number, due date, amount and the statusText a tool returned/);
    expect(failure?.detail).not.toMatch(/impaga|en mora/);
    const neutral = "Tu préstamo está vigente, con cuotas pendientes; la cuota 5 está pendiente.";
    expect(verifyOutbound(input({ freeText: neutral, rendered: neutral }))).toEqual([]);
  });
});

describe("verify: offers, sensitive asks and foreign contacts", () => {
  it("a credit offer is blocked on any channel", () => {
    const text = "Tenés un préstamo preaprobado con tasa preferencial.";
    expect(verifyOutbound(input({ channel: "EMAIL", kind: "FORMAL_ANSWER", senderClass: "OPERATOR", freeText: text, rendered: text })).map((failure) => failure.ruleId)).toContain("CH-NO-CREDIT-OFFER");
  });

  it("[FL-056] a refusal that names the new loan or the refinancing it refuses is not an offer", () => {
    for (const text of ["No puedo gestionar la solicitud de un nuevo préstamo ni ofrecerte créditos.", "La solicitud de un nuevo préstamo está fuera de lo que puedo gestionar.", "Refinanciar el préstamo está fuera de lo que puedo hacer por acá."]) {
      expect(verifyOutbound(input({ kind: "OUT_OF_SCOPE_REFUSAL", freeText: text, rendered: text })), text).toEqual([]);
    }
    for (const text of ["Tenemos un nuevo préstamo para vos.", "Podés refinanciar tu préstamo con nosotros."]) {
      expect(verifyOutbound(input({ freeText: text, rendered: text })).map((failure) => failure.ruleId), text).toContain("CH-NO-CREDIT-OFFER");
    }
  });

  it("asking for a password or a card is blocked; saying we never ask for it is not", () => {
    expect(verifyOutbound(input({ freeText: "Mandame tu clave y el número de tarjeta para revisarlo." })).map((failure) => failure.ruleId)).toContain("CH-NO-SENSITIVE-ASK");
    expect(verifyOutbound(input({ freeText: "Nunca te pedimos tu clave ni tu tarjeta por este medio." }))).toEqual([]);
  });

  it("a link, an email or a domain that is not the stage's is blocked; the stage's own is not", () => {
    expect(verifyOutbound(input({ freeText: "Mirá el detalle en https://pagos-rapidos.example.com/cuenta" })).map((failure) => failure.ruleId)).toContain("CH-NO-FOREIGN-LINKS");
    expect(verifyOutbound(input({ freeText: "Escribinos a ayuda@soporte-externo.com" })).map((failure) => failure.ruleId)).toContain("CH-NO-FOREIGN-LINKS");
    expect(verifyOutbound(input({ freeText: `Podés ver el estado en https://${STAGE_DOMAIN}/estado` }))).toEqual([]);
  });

  it("puts the policy's own rules first: a collection block is what the tape shows", () => {
    const text = "Pagá hoy los $ 99.999,00 que debés para evitar recargos.";
    const failures = verifyOutbound(input({ freeText: text, rendered: text }));
    expect(failures[0]?.ruleId).toBe("CH-WA-NO-COLLECTION");
    expect(failures.map((failure) => failure.check)).toContain("FIGURES");
    expect(failureCodeOf(failures)).toBe("POLICY_DENIED");
  });
});
