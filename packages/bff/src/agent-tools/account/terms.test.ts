import { describe, expect, it } from "vitest";
import { gatewayContext } from "../common/principal";
import { createAccountTarget } from "./target";
import { CLAUSE_LABEL, FEES_REFERENCE, TERMS_REFERENCE, TOPIC_CLAUSES } from "./reference";
import { MAX_CLAUSES } from "./schema";
import { requestedClauseIds } from "./terms";
import { CUSTOMER, WORLD, codeOf, okOf, targetsKit } from "./testing";

// A synthetic excerpt of `Reference/TERMS#v001` and `FEES#v001` in the seed's own row shapes.
const CLAUSES = [
  { id: "D-1", topic: "Derechos del reclamo", text: "Todo reclamo recibe un número en el momento en que se presenta." },
  { id: "D-2", topic: "Derechos del reclamo", text: "Jarilla responde por escrito dentro de los 10 días hábiles de presentado el reclamo." },
  { id: "D-3", topic: "Derechos del reclamo", text: "La respuesta escrita puede llegar por email si el cliente lo acepta." },
  { id: "D-4", topic: "Derechos del reclamo", text: "El cliente puede pedir en cualquier momento que lo atienda una persona." },
  { id: "T-3.2", topic: "Atraso", text: "Sobre el saldo de una cuota no pagada a su vencimiento corre un interés punitorio diario del 50 % de la tasa compensatoria." },
  { id: "T-3.4", topic: "Atraso", text: "Si el pago se hizo dentro de los 2 días corridos posteriores al vencimiento no corre interés punitorio." },
  { id: "T-1.6", topic: "Préstamo", text: "El desembolso se acredita neto de la comisión de otorgamiento." },
  { id: "T-4.6", topic: "Billetera", text: "La reposición de la tarjeta prepaga cuesta $ 2.500 y se cobra solo si el cliente la pidió <b>." },
];
const FEES = [
  { code: "FEE-ORIG", concept: "Comisión de otorgamiento", base: "3 % del capital (+ IVA)", when: "Una vez, al desembolsar", clauseIds: ["T-1.6"] },
  { code: "FEE-PUNIT", concept: "Interés punitorio", base: "50 % de la tasa compensatoria, diario", when: "Desde el día siguiente al vencimiento, salvo la tolerancia de 2 días", clauseIds: ["T-3.2", "T-3.4"] },
];

async function setup({ identified = false, seed = true } = {}) {
  const kit = await targetsKit([{ customerId: CUSTOMER }]);
  if (seed) {
    for (const clause of CLAUSES) await kit.connector.write({ kind: "put", table: "Reference", item: { pk: `REF#${TERMS_REFERENCE.type}#${TERMS_REFERENCE.scope}`, sk: clause.id, entity: "ProductTerms", ...clause } });
    for (const fee of FEES) await kit.connector.write({ kind: "put", table: "Reference", item: { pk: `REF#${FEES_REFERENCE.type}#${FEES_REFERENCE.scope}`, sk: fee.code, entity: "FeeSchedule", ...fee } });
  }
  if (identified) await kit.identify();
  const account = createAccountTarget(kit.toolDeps, { core: kit.core });
  const turn = await kit.openTurn();
  const call = (tool: "get_terms" | "get_fee_rules", input: Record<string, unknown>) => account.handle({ sessionToken: turn.token, ...input }, gatewayContext(`account___${tool}`));
  return { kit, call, turn };
}


describe("[FL-063] question about the rights of the complaint", () => {
  it("[FL-063] get_terms(COMPLAINT_RIGHTS) answers the D-* clauses labelled as our reading, without identification, and keeps them in TURN#", async () => {
    const { kit, call, turn } = await setup();
    const answer = okOf(await call("get_terms", { topic: "COMPLAINT_RIGHTS" }));
    expect(answer["termsVersion"]).toBe("v001");
    const clauses = answer["clauses"] as Array<Record<string, string>>;
    expect(clauses.map((clause) => clause["clauseId"])).toEqual(["D-1", "D-2", "D-3", "D-4"]);
    expect(clauses[1]).toEqual({ clauseId: "D-2", title: "Derechos del reclamo", text: expect.stringContaining("10 días hábiles"), label: CLAUSE_LABEL.RIGHTS });
    expect(CLAUSE_LABEL.RIGHTS).toMatch(/no asesoramiento legal/);
    const [row] = await kit.connector.sessions.listTurnResults(WORLD, turn.turnId);
    expect(row).toMatchObject({ tool: "get_terms", result: { clauses: expect.arrayContaining([expect.objectContaining({ clauseId: "D-2" })]) } });
  });

  it("[FL-063] reads clauses by id (the ones get_fee_rules or check_charge cite), labels the synthetic ones and escapes their text", async () => {
    const { call } = await setup();
    const clauses = okOf(await call("get_terms", { clauseIds: ["T-3.4", "T-4.6", "D-4"] }))["clauses"] as Array<Record<string, string>>;
    expect(clauses.map((clause) => [clause["clauseId"], clause["label"]])).toEqual([
      ["T-3.4", CLAUSE_LABEL.SYNTHETIC],
      ["T-4.6", CLAUSE_LABEL.SYNTHETIC],
      ["D-4", CLAUSE_LABEL.RIGHTS],
    ]);
    expect(clauses[1]?.["text"]).toContain("&lt;b&gt;");
  });

  it("[FL-063] returns at most 8 clauses; asks for a topic or ids; an unknown id finds nothing", async () => {
    expect(requestedClauseIds({ topic: "LOANS", clauseIds: ["D-1", "D-2"] })).toHaveLength(MAX_CLAUSES);
    for (const ids of Object.values(TOPIC_CLAUSES)) expect(ids.length).toBeLessThanOrEqual(MAX_CLAUSES);
    // A payment's crediting and the automatic debit have their own topics (EV-1 gnd-28, gnd-30).
    expect(TOPIC_CLAUSES.PAYMENTS).toEqual(expect.arrayContaining(["T-2.3", "T-2.4", "T-2.5"]));
    expect(TOPIC_CLAUSES.AUTO_DEBIT).toEqual(["T-5.1", "T-5.2", "T-5.3", "T-5.4"]);
    const { call } = await setup();
    expect(codeOf(await call("get_terms", {}))).toBe("INVALID");
    expect(codeOf(await call("get_terms", { clauseIds: ["T-9.9"] }))).toBe("NOT_FOUND");
    expect(codeOf(await call("get_terms", { topic: "INVESTMENTS" }))).toBe("INVALID");
    expect(codeOf(await call("get_terms", { clauseIds: Array.from({ length: 9 }, (_, index) => `D-${index + 1}`) }))).toBe("INVALID");
  });

  it("[FL-063] a stage without the terms loaded answers NOT_FOUND, never an invented clause", async () => {
    const { call } = await setup({ seed: false });
    expect(codeOf(await call("get_terms", { topic: "COMPLAINT_RIGHTS" }))).toBe("NOT_FOUND");
  });
});

describe("[FL-032] correct charge: grounded explanation (the fee schedule)", () => {
  it("[FL-032] get_fee_rules answers the schedule with its clauses for an identified customer, one fee by code", async () => {
    const { call } = await setup({ identified: true });
    const all = okOf(await call("get_fee_rules", {}));
    expect(all["scheduleVersion"]).toBe("v001");
    expect(all["fees"]).toHaveLength(2);
    expect(okOf(await call("get_fee_rules", { feeCode: "FEE-PUNIT" }))["fees"]).toEqual([
      { feeCode: "FEE-PUNIT", label: "Interés punitorio", basis: "50 % de la tasa compensatoria, diario", whenApplies: "Desde el día siguiente al vencimiento, salvo la tolerancia de 2 días", clauseIds: ["T-3.2", "T-3.4"] },
    ]);
    expect(codeOf(await call("get_fee_rules", { feeCode: "FEE-NOPE" }))).toBe("NOT_FOUND");
  });

  it("[FL-032] get_fee_rules needs the customer identified", async () => {
    const { call } = await setup();
    expect(codeOf(await call("get_fee_rules", {}))).toBe("NOT_IDENTIFIED");
  });
});
