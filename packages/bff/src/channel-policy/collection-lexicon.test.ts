import { describe, expect, it } from "vitest";
import { CORPUS_FILE, customerTexts, loadCollectionCorpus, readRepoFile } from "../copy/testing";
import { CollectionCategory } from "../copy/types";
import { COLLECTION_LEXICON, COLLECTION_LEXICON_VERSION, classifyCollection, isCollection } from "./collection-lexicon";
import { creditOfferFindings, foreignContactFindings, sensitiveFindings } from "./content-lexicons";
import { POLICY_VERSION, evaluate } from "./engine";
import { foldText } from "./lexicon-match";
import { OPERATOR, OPERATOR_STAFF, agentReply, takenAt } from "./testing";
import { STAGE_DOMAIN } from "./types";

const operatorTaken = { conversation: takenAt("2026-10-07T10:08:00-03:00"), request: { sender: OPERATOR, auth: { staff: OPERATOR_STAFF } } } as const;

describe("[FL-067] the operator's free text with collection content", () => {
  const TEXT = "Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos";

  it("[FL-067] reads a payment exhortation and a consequence threat", () => {
    const { categories } = classifyCollection(TEXT);
    expect(categories).toEqual(expect.arrayContaining(["PAYMENT_EXHORTATION", "CONSEQUENCE_THREAT", "DEBT_REMINDER"]));
  });

  it("[FL-067] blocks it by WhatsApp with CH-WA-NO-COLLECTION, the categories on the decision, even with the conversation taken", () => {
    const decision = evaluate(agentReply({ ...operatorTaken, request: { ...operatorTaken.request, text: TEXT } }));
    expect(decision).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"], errorCode: "POLICY_DENIED" });
    expect(decision.collectionCategories).toEqual(expect.arrayContaining(["PAYMENT_EXHORTATION", "CONSEQUENCE_THREAT"]));
    expect(decision.reroutes).toEqual([{ route: "HUMAN_QUEUE" }, { route: "FORMAL_EMAIL", previewKind: "COLLECTION_NOTICE_EMAIL" }]);
    expect(decision.ruleSetVersion).toBe(POLICY_VERSION);
    expect(decision.ruleSetVersion).toContain(COLLECTION_LEXICON_VERSION);
  });

  it("[FL-067] the rule details name categories, never the text", () => {
    const decision = evaluate(agentReply({ ...operatorTaken, request: { ...operatorTaken.request, text: TEXT } }));
    for (const entry of decision.evaluated) expect(entry.detail).not.toContain("pagala");
    expect(classifyCollection(TEXT).findings.every((finding) => !Object.values(finding).some((value) => value.includes("pagala")))).toBe(true);
  });
});

describe("[FL-023] [FL-031] neutral service texts pass", () => {
  const SERVICE = [
    "Tu cuota ya no figura atrasada",
    "Tu saldo pendiente es $ 192.630,00",
    "Tu pago de $ 50.000 quedó imputado a la cuota 4; el saldo de la cuota es $ 68.640,00",
    "Tu préstamo tiene 3 cuotas pendientes por $ 192.630,00; el certificado de libre deuda se emite cuando canceles el préstamo",
    "Tu préstamo no registra deuda: te mandamos el libre deuda por email",
    "Tu pago ya se refleja en tu cuenta",
    "Ese pago cancela la cuota 4",
    "Te recordamos que tu reclamo R-2026-000001 vence el 22/10",
    "El importe para cancelar el préstamo hoy es $ 500.000,00",
    "Por este canal no ofrecemos refinanciaciones ni planes de pago",
  ];

  it("[FL-023] [FL-031] none of them reads as collection", () => {
    for (const text of SERVICE) expect(classifyCollection(text).categories, text).toEqual([]);
  });

  it("[FL-023] the partial-payment explanation goes out by WhatsApp", () => {
    expect(evaluate(agentReply({ request: { text: SERVICE[2] } })).decision).toBe("ALLOWED");
  });

  it("[FL-031] the balance explanation of a loan with instalments left goes out by WhatsApp", () => {
    expect(evaluate(agentReply({ request: { text: SERVICE[3] } })).decision).toBe("ALLOWED");
  });
});

describe("the collection lexicon", () => {
  const BY_CATEGORY: Readonly<Record<CollectionCategory, readonly string[]>> = {
    PAYMENT_EXHORTATION: ["Pagá tu cuota antes del viernes", "Aboná la cuota 3 cuanto antes", "Regularizá tu situación", "Tenés que pagar la cuota", "Le pedimos que abone lo adeudado", "Por favor realizá el pago"],
    CONSEQUENCE_THREAT: ["Evitá recargos", "Informaremos tu situación a las centrales de riesgo", "Iniciaremos acciones legales", "Si no pagás, vamos a suspender tu cuenta", "Último aviso"],
    DEBT_REMINDER: ["Tu cuota 3 está vencida", "Tenés una deuda de $ 64.210", "Hola Martín, tu cuota vence hoy", "Seguís en mora", "Debés $ 64.210"],
    PAYMENT_INSTRUMENT: ["Podés pagar con este link", "Transferí al CVU 9990000000000000000012", "Te mandamos el link de pago", "Ingresá a la app para pagar"],
    NEGOTIATION: ["Te ofrecemos un plan de pagos", "Accedé a una quita del 30%", "Refinanciá tu deuda en 12 cuotas", "Te bonificamos los punitorios"],
  };

  it("covers every category of docs/design-brief.md §7 with its examples", () => {
    expect(new Set(COLLECTION_LEXICON.map((entry) => entry.category))).toEqual(new Set(CollectionCategory.options));
    for (const [category, texts] of Object.entries(BY_CATEGORY)) {
      for (const text of texts) expect(classifyCollection(text).categories, text).toContain(category);
    }
  });

  it("reads accents, case, usted and tú forms alike", () => {
    for (const text of ["PAGA TU CUOTA HOY", "pagá tu cuota hoy", "Pague su cuota hoy", "Regularice su deuda", "abonala ya"]) expect(isCollection(text), text).toBe(true);
    expect(foldText("¿Pagá ya? Sí.")).toBe(" | paga ya | si | ");
  });

  it("does not let a negation elsewhere in the clause rescue a collection phrase", () => {
    expect(isCollection("Tu cuota vencida no fue abonada")).toBe(true);
    expect(isCollection("No te olvides de pagar")).toBe(true);
    expect(isCollection("Si no regularizás, iniciaremos acciones legales")).toBe(true);
  });

  it("reads through hidden format characters, full-width letters and digits for letters", () => {
    for (const text of ["Pa\u00adgá hoy la cuota", "Pa\u200bgá hoy la cuota", "Pa\u2060gá hoy la cuota", "\uff50\uff41\uff47á hoy la cuota", "P4gá hoy la cuota", "Ab0ná la cuota"]) {
      expect(classifyCollection(text).categories, JSON.stringify(text)).toContain("PAYMENT_EXHORTATION");
    }
    expect(foldText("Pa\u00adgá\u200b hoy\u0007")).toBe(" paga hoy ");
    expect(foldText("una\nlínea")).toBe(" una | linea ");
    expect(isCollection("Tu reclamo R-2026-000001 vence el 22/10 a las 18hs; la cuota 4 quedó imputada")).toBe(false);
  });

  it("reads Cyrillic and Greek look-alikes as Latin, deletes invisible fillers and reads @ and $ inside a word as letters", () => {
    const disguised = [
      "P\u0430gá hoy la cuota",
      "Ab\u043ená la cuota hoy",
      "Ab\u03bfná la cuota hoy",
      "\u0420\u0410G\u0410 HOY LA CUOTA",
      "Pa\u3164gá hoy la cuota",
      "Pa\u115fgá hoy la cuota",
      "Pa\u1160gá hoy la cuota",
      "Pa\uffa0gá hoy la cuota",
      "Pa\u2800gá hoy la cuota",
      "Pa\u180egá hoy la cuota",
      "P@gá hoy la cuota",
      "Ab\u03bfn@ la cuota hoy",
    ];
    for (const text of disguised) expect(classifyCollection(text).categories, JSON.stringify(text)).toContain("PAYMENT_EXHORTATION");
    expect(isCollection("\u0415vitá recargos pagando hoy")).toBe(true);
    expect(foldText("P\u0430g\u03b1 hoy\u3164\u2800")).toBe(" paga hoy ");
    expect(isCollection("Escribinos a ayuda@jarilla.example si tenés dudas")).toBe(false);
    expect(isCollection("Te devolvimos $ 64.210 a tu cuenta")).toBe(false);
  });

  it("finds a shared card or CBU grouped with no-break spaces or with a CVV glued to the card", () => {
    expect(sensitiveFindings("tarjeta 4111\u00a01111\u00a01111\u00a01111")).toContain("SHARES-TARJETA");
    expect(sensitiveFindings("tarjeta 4111 1111 1111 1111 123")).toContain("SHARES-TARJETA");
    expect(sensitiveFindings("cbu 0110\u202f5995\u202f2000\u202f0012\u202f3456\u202f78")).toContain("SHARES-CBU");
    expect(sensitiveFindings("CBU 4111 1111 1111 1111 0000 00")).toEqual(["SHARES-CBU"]);
  });

  it("never lets a negation the phrase itself spells cancel it", () => {
    for (const text of ["No te olvides de tu cuota de este mes", "No olvides la cuota de octubre", "No queremos que tu deuda siga creciendo", "Tu cuota está sin pagar"]) {
      expect(classifyCollection(text).categories, text).toContain("DEBT_REMINDER");
    }
    expect(isCollection("Recordá la cuota de octubre")).toBe(true);
    expect(isCollection("Tu cuota ya no figura atrasada")).toBe(false);
    expect(isCollection("Tu préstamo quedó sin tu deuda anterior")).toBe(false);
  });

  it("lets every fixed customer text of copy/ through, so SYSTEM's own messages are never blocked", () => {
    const texts = customerTexts();
    expect(texts.length).toBeGreaterThan(100);
    for (const { source, text, formalDebtNotice } of texts) {
      // The formal debt notice states the debt by design: it only goes by email, outside CH-WA-NO-COLLECTION.
      if (!formalDebtNotice) expect(classifyCollection(text).findings, source).toEqual([]);
      expect([...creditOfferFindings(text), ...sensitiveFindings(text), ...foreignContactFindings(text, [STAGE_DOMAIN])], source).toEqual([]);
    }
  });

  it("has unique pattern ids and a version", () => {
    const ids = COLLECTION_LEXICON.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COLLECTION_LEXICON_VERSION).toMatch(/^lex-\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/);
  });
});

describe(`the single corpus of the seed (${CORPUS_FILE})`, () => {
  const corpus = loadCollectionCorpus();
  // The corpus is written by the seed generator (WP-14); CI never runs without it.
  const required = process.env.CI === "true";

  it.runIf(required && corpus === undefined)("exists", () => {
    expect(corpus, `${CORPUS_FILE} is missing`).toBeDefined();
  });

  it.skipIf(corpus === undefined)("[FL-067] catches every collection phrase: 0 false negatives", () => {
    if (corpus === undefined) return;
    expect(corpus.collection.length).toBeGreaterThanOrEqual(80);
    const missed = corpus.collection.filter((entry) => !isCollection(entry.text)).map((entry) => String(entry.id ?? entry.text));
    expect(missed).toEqual([]);
  });

  it.skipIf(corpus === undefined)("[FL-023] [FL-031] lets the service phrases through: at most 5 % false positives", () => {
    if (corpus === undefined) return;
    expect(corpus.service.length).toBeGreaterThanOrEqual(80);
    const flagged = corpus.service.filter((entry) => isCollection(entry.text)).map((entry) => String(entry.id ?? entry.text));
    expect(flagged.length / corpus.service.length, flagged.join(" · ")).toBeLessThanOrEqual(0.05);
  });
});

describe("[FL-064] the lender's own terms read as service", () => {
  const reference = JSON.parse(readRepoFile("scripts/seed/data/reference.json")) as { terms: { clauses: { id: string; text: string }[] }; fees: { fees: { code: string; concept: string; base: string; when: string }[] } };

  it("[FL-064] every clause and fee of the seed passes the WhatsApp lexicons, so quoting the terms is never a collection or an offer", () => {
    const texts = [...reference.terms.clauses.map((clause) => [clause.id, clause.text]), ...reference.fees.fees.map((fee) => [fee.code, `${fee.concept}: ${fee.base}. ${fee.when}.`])];
    expect(texts.length).toBeGreaterThan(40);
    for (const [id, text = ""] of texts) {
      expect(classifyCollection(text).findings, id).toEqual([]);
      expect(creditOfferFindings(text), id).toEqual([]);
    }
  });
});

describe("[FL-052] the right to pay a loan off early, stated as the clause states it", () => {
  it("[FL-052] answering \"¿puedo cancelar antes?\" with the clause is service; urging or pointing to a way to pay is not", () => {
    expect(isCollection("Podés cancelar tu préstamo en forma total o parcial en cualquier momento.")).toBe(false);
    expect(classifyCollection("Podés cancelar tu préstamo hoy mismo.").categories).toContain("PAYMENT_INSTRUMENT");
    expect(classifyCollection("Podés cancelar tu cuota en la red de cobro.").categories).toContain("PAYMENT_INSTRUMENT");
  });

  it("[FL-052] paying the loan off before it falls due is the same right, not urgency; a deadline on an instalment still is", () => {
    expect(classifyCollection("Sí, se puede pagar el préstamo antes de su vencimiento").findings).toEqual([]);
    expect(classifyCollection("Podés pagar tu préstamo antes de su vencimiento, en forma total o parcial.").findings).toEqual([]);
    expect(classifyCollection("Es importante pagar la cuota antes del vencimiento").categories).toContain("PAYMENT_EXHORTATION");
    expect(classifyCollection("Podés cancelar tu préstamo hoy mismo.").categories).toContain("PAYMENT_EXHORTATION");
  });
});

describe("[FL-064] where instalments are paid, stated as the clause states it", () => {
  it("[FL-064] the impersonal form of the clause is service whatever the verb form; an invitation or an instrument is not", () => {
    for (const text of ["Las cuotas se pagan en las redes de cobro.", "Las cuotas se pueden pagar de tres formas: en las redes de cobro, desde la billetera o por transferencia al CVU de la billetera."]) {
      expect(classifyCollection(text).findings, text).toEqual([]);
    }
    expect(classifyCollection("Podés pagar la cuota en las redes de cobro.").categories).toContain("PAYMENT_INSTRUMENT");
    expect(classifyCollection("Se puede pagar con este link").categories).toContain("PAYMENT_INSTRUMENT");
    expect(classifyCollection("Se puede pagar al CVU 9990000000000000000012").categories).toContain("PAYMENT_INSTRUMENT");
  });
});

describe("[FL-056] a refusal names what it refuses", () => {
  it("[FL-056] a refinancing or a plan inside a refusal frame is not a negotiation; offering one still is", () => {
    expect(isCollection("Refinanciar el préstamo está fuera de lo que puedo hacer por acá.")).toBe(false);
    expect(isCollection("No puedo gestionar planes de pago por este canal.")).toBe(false);
    expect(classifyCollection("Podés refinanciar tu deuda con un plan de pagos.").categories).toContain("NEGOTIATION");
    expect(classifyCollection("No podemos esperar más: refinanciá tu deuda hoy.").categories).toContain("NEGOTIATION");
  });
});

describe("[FL-031] a temporal subjunctive with an object pronoun describes, it does not exhort", () => {
  it("[FL-031] \"cuando lo cancelés\" and \"una vez que lo canceles\" are service", () => {
    for (const text of ["Cuando lo cancelés, lo emitimos.", "Una vez que lo canceles, te lo mandamos.", "Apenas la canceles, te mandamos el libre deuda."]) {
      expect(classifyCollection(text).findings, text).toEqual([]);
      expect(evaluate(agentReply({ request: { text } })).decision, text).toBe("ALLOWED");
    }
  });

  it("[FL-031] without the temporal word, or with an imperative after it, it is still an exhortation", () => {
    for (const text of ["Necesito que lo canceles hoy.", "Cuando puedas, cancelá la cuota.", "Te pedimos que lo canceles cuanto antes."]) {
      expect(classifyCollection(text).categories, text).toContain("PAYMENT_EXHORTATION");
    }
  });
});
