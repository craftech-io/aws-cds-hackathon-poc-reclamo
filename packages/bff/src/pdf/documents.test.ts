import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { describe, expect, it } from "vitest";
import { PDF_COMMON, PDF_DOC, type DocKind } from "../copy";
import { renderDocument } from "./documents";
import { dateAr, dateTimeAr } from "./format";
import { type DocumentInput, cuitCheckDigit } from "./schemas";

const FILED_HASH = "a".repeat(63) + "1";
const FINAL_HASH = "b".repeat(63) + "2";
const ISSUED = "2026-10-09T14:05:00-03:00";
const ISSUED_LATER = "2026-11-19T09:47:00-03:00";

const FIXTURES: { readonly [K in DocKind]: Extract<DocumentInput, { docKind: K }> } = {
  ACK: {
    docKind: "ACK",
    complaintNumber: "R-2026-000001",
    issuedAtSim: ISSUED,
    customerName: "Valeria Quiroga",
    type: "PAYMENT_NOT_REFLECTED",
    channel: "WHATSAPP",
    filedAtSim: "2026-10-07T10:12:00-03:00",
    deadlineSim: "2026-10-22T23:59:59-03:00",
    filedHash: FILED_HASH,
  },
  ANSWER: {
    docKind: "ANSWER",
    complaintNumber: "R-2026-000001",
    issuedAtSim: ISSUED,
    customerName: "Valeria Quiroga",
    type: "PAYMENT_NOT_REFLECTED",
    filedAtSim: "2026-10-07T10:12:00-03:00",
    outcome: "IN_FAVOUR",
    facts: ["La cuota 4 de $ 118.640,00 vencía el 05/10/2026.", "La rendición de la Red de cobro Norte del 07/10 tiene la línea de tu pago."],
    resolution: "Imputamos tu pago a la cuota 4. La cuota figura pagada desde hoy.",
    actions: [{ label: "Imputación del pago a la cuota 4", amountCents: 11_864_000 }],
    attachments: ["STATEMENT"],
    registerHashes: { filed: FILED_HASH, finalAnswer: FINAL_HASH },
  },
  PAYOFF_CERTIFICATE: {
    docKind: "PAYOFF_CERTIFICATE",
    complaintNumber: "R-2026-000005",
    issuedAtSim: ISSUED,
    customerName: "Ana Belén Ruiz",
    loan: { label: "Préstamo personal L-0005", principalCents: 72_000_000, cancelledAtSim: "2026-09-15T11:00:00-03:00" },
  },
  CREDIT_NOTE: {
    docKind: "CREDIT_NOTE",
    complaintNumber: "R-2026-000002",
    issuedAtSim: ISSUED,
    customerName: "Diego Arrieta",
    creditNoteId: "NC-0002",
    concept: "Reversión del cargo FEE-CARD-REPL del 01/10/2026",
    amountCents: 250_000,
    interestCents: 4_521,
    annualRate: 0.95,
    creditedAtSim: "2026-10-07T10:30:00-03:00",
  },
  STATEMENT: {
    docKind: "STATEMENT",
    complaintNumber: "R-2026-000001",
    issuedAtSim: ISSUED,
    customerName: "Valeria Quiroga",
    loan: { label: "Préstamo personal L-0001", outstandingCents: 94_912_000 },
    instalments: [
      { number: 4, dueDate: "2026-10-05", amountCents: 11_864_000, paidCents: 11_864_000, outstandingCents: 0, status: "PAID" },
      { number: 5, dueDate: "2026-11-05", amountCents: 11_864_000, paidCents: 0, outstandingCents: 11_864_000, status: "DUE" },
    ],
    payments: [{ instalment: 4, appliedAtSim: "2026-10-08T08:31:00-03:00", amountCents: 11_864_000 }],
  },
  CLOSURE: {
    docKind: "CLOSURE",
    complaintNumber: "R-2026-000013",
    issuedAtSim: ISSUED,
    requestedAtSim: "2026-10-07T11:00:00-03:00",
    conditions: ["Saldo de la billetera transferido a la cuenta de destino"],
  },
  DATA_CHANGE: {
    docKind: "DATA_CHANGE",
    complaintNumber: "R-2026-000014",
    issuedAtSim: ISSUED,
    field: "EMAIL",
    requestedAtSim: "2026-10-07T11:20:00-03:00",
    status: "PENDING_CONFIRMATION",
  },
  COLLECTION_NOTICE: {
    docKind: "COLLECTION_NOTICE",
    issuedAtSim: ISSUED,
    customerName: "Martín Olmedo",
    creditor: { cuit: "30-99999999-5", address: "Av. de los Tilos 1400, Ciudad Ficticia" },
    loan: { label: "Préstamo personal L-0009" },
    overdue: [{ number: 3, dueDate: "2026-09-25", amountCents: 6_421_000 }],
  },
};

const KINDS = Object.keys(FIXTURES) as DocKind[];

async function pagesText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((page) => page.replace(/\s+/g, " "));
}

async function fullText(bytes: Uint8Array): Promise<string> {
  return (await pagesText(bytes)).join(" ");
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("renderDocument: the eight documents are deterministic", () => {
  it.each(KINDS)("%s gives the same bytes for the same input", (kind) => {
    const first = renderDocument(FIXTURES[kind]);
    const second = renderDocument(structuredClone(FIXTURES[kind]));
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.sha256).toBe(createHash("sha256").update(first.bytes).digest("hex"));
  });

  it.each(KINDS)("%s changes only in the issue date when the issue date changes", (kind) => {
    const a = latin1(renderDocument(FIXTURES[kind]).bytes);
    const b = latin1(renderDocument({ ...FIXTURES[kind], issuedAtSim: ISSUED_LATER }).bytes);
    expect(a).not.toBe(b);
    expect(a.length).toBe(b.length);
    const blank = (text: string, issued: string) => text.replaceAll(dateTimeAr(issued), "<issued>").replaceAll(dateAr(issued), "<issued>");
    expect(blank(a, ISSUED)).toBe(blank(b, ISSUED_LATER));
  });

  it.each(KINDS)("%s parses as a PDF, with fixed metadata and no author or dates", async (kind) => {
    const doc = renderDocument(FIXTURES[kind]);
    const { info } = await getMeta(await getDocumentProxy(new Uint8Array(doc.bytes)));
    expect(info.Title).toBe(PDF_DOC[kind].TITLE);
    expect(info.Subject).toBe(doc.subject);
    expect(info.Producer).toBe("reclamo-en-regla");
    expect(info.Author ?? "").toBe("");
    expect(latin1(doc.bytes)).not.toMatch(/\/(?:Author|Creator|CreationDate|ModDate)\b/);
    expect(doc.contentType).toBe("application/pdf");
    expect(doc.pageCount).toBe(1);
    expect(doc.fileName).toMatch(/^[A-Za-z0-9._-]{1,100}\.pdf$/);
  });

  it.each(KINDS)("%s uses only the standard fonts, never an embedded or system font", (kind) => {
    const raw = latin1(renderDocument(FIXTURES[kind]).bytes);
    expect(raw).not.toMatch(/\/FontFile|\/FontDescriptor/);
    const fonts = [...raw.matchAll(/\/BaseFont \/([A-Za-z-]+)/g)].map((match) => match[1]);
    expect(new Set(fonts)).toEqual(new Set(["Helvetica", "Helvetica-Bold", "Courier"]));
  });

  it.each(KINDS)("%s carries the letterhead, the product line, the number, the issue date and the synthetic-data legend", async (kind) => {
    const text = await fullText(renderDocument(FIXTURES[kind]).bytes);
    for (const fixed of [PDF_COMMON.LETTERHEAD, PDF_COMMON.BRAND, PDF_COMMON.SYNTHETIC_LEGEND, PDF_DOC[kind].TITLE, dateTimeAr(ISSUED)]) expect(text).toContain(fixed);
    const number = FIXTURES[kind].complaintNumber;
    if (number !== undefined) expect(text).toContain(number);
  });

  it("never reads files: no module of pdf/ imports the file system", () => {
    const dir = import.meta.dirname;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/node:fs|from "fs"|readFile/);
    }
  });
});

describe("[FL-011] ACK: acknowledgement with the hash of the FILED entry", () => {
  it("prints the FILED hash exactly as the register stores it, the deadline and the channel", async () => {
    const doc = renderDocument(FIXTURES.ACK);
    const text = await fullText(doc.bytes);
    expect(text).toContain(FILED_HASH);
    expect(text).toContain("22/10/2026 (10 días hábiles)");
    expect(text).toContain("07/10/2026 10:12");
    expect(text).toContain("Pago no reflejado");
    expect(text).toContain("WhatsApp");
    expect(doc.subject).toBe("Acuse de recibo del reclamo R-2026-000001");
    expect(doc.fileName).toBe("R-2026-000001-acuse-de-recibo.pdf");
  });

  it("rejects a hash that is not a 64-character hex hash", () => {
    expect(() => renderDocument({ ...FIXTURES.ACK, filedHash: "not-a-hash" })).toThrow();
  });
});

describe("[FL-025] [FL-030] PAYOFF_CERTIFICATE and the written answer", () => {
  it("[FL-030] the certificate has the loan, its principal, the cancellation date and the no-debt statement", async () => {
    const text = await fullText(renderDocument(FIXTURES.PAYOFF_CERTIFICATE).bytes);
    expect(text).toContain("Préstamo personal L-0005");
    expect(text).toContain("$ 720.000,00");
    expect(text).toContain("15/09/2026");
    expect(text).toContain("No registra deuda por este préstamo.");
  });

  it("[FL-025] the written answer has the number, type, filing date, resolution, actions, attachments, BCRA right and both register hashes", async () => {
    const text = await fullText(renderDocument(FIXTURES.ANSWER).bytes);
    for (const expected of [
      "R-2026-000001",
      "Pago no reflejado",
      "07/10/2026 10:12",
      "A favor del cliente",
      "Imputamos tu pago a la cuota 4.",
      "Imputación del pago a la cuota 4",
      "$ 118.640,00",
      PDF_DOC.STATEMENT.TITLE,
      PDF_COMMON.BCRA_RIGHT,
      PDF_COMMON.SIGNATURE,
      `FILED ${FILED_HASH}`,
      `FINAL_ANSWER ${FINAL_HASH}`,
    ]) expect(text).toContain(expected);
  });

  it("[FL-025] the statement lists the instalments, the applied payment and the loan balance", async () => {
    const text = await fullText(renderDocument(FIXTURES.STATEMENT).bytes);
    for (const expected of ["05/10/2026", "05/11/2026", "Pagada", "A vencer", "08/10/2026 08:31", "$ 949.120,00", PDF_DOC.STATEMENT.PAYMENTS]) expect(text).toContain(expected);
  });

  it("the credit note adds the compensatory interest and labels the synthetic rate as an assumption", async () => {
    const text = await fullText(renderDocument(FIXTURES.CREDIT_NOTE).bytes);
    for (const expected of ["$ 2.500,00", "$ 45,21", "$ 2.545,21", "95,00 % nominal anual (supuesto)", "NC-0002"]) expect(text).toContain(expected);
  });
});

describe("[FL-065] COLLECTION_NOTICE: formal debt notice rendered by code only", () => {
  it("identifies the creditor with its synthetic CUIT and details the overdue instalment and the total", async () => {
    const doc = renderDocument(FIXTURES.COLLECTION_NOTICE);
    const text = await fullText(doc.bytes);
    for (const expected of ["CUIT 30-99999999-5 (sintético)", "Av. de los Tilos 1400, Ciudad Ficticia", "Préstamo personal L-0009", "25/09/2026", "$ 64.210,00", `Total al ${dateAr(ISSUED)}`]) expect(text).toContain(expected);
    expect(doc.fileName).toBe("aviso-formal-de-deuda.pdf");
  });

  it("adds up the total of several overdue instalments in code", async () => {
    const overdue = [
      { number: 3, dueDate: "2026-09-25", amountCents: 6_421_000 },
      { number: 2, dueDate: "2026-08-25", amountCents: 6_421_000 },
    ];
    expect(await fullText(renderDocument({ ...FIXTURES.COLLECTION_NOTICE, overdue }).bytes)).toContain("$ 128.420,00");
  });

  it("accepts no free text and no total from the caller", () => {
    expect(() => renderDocument({ ...FIXTURES.COLLECTION_NOTICE, message: "Pagá hoy" })).toThrow();
    expect(() => renderDocument({ ...FIXTURES.COLLECTION_NOTICE, totalCents: 1 })).toThrow();
  });

  it("rejects a CUIT with a wrong check digit", () => {
    expect(cuitCheckDigit("3099999999")).toBe(5);
    expect(() => renderDocument({ ...FIXTURES.COLLECTION_NOTICE, creditor: { ...FIXTURES.COLLECTION_NOTICE.creditor, cuit: "30-99999999-4" } })).toThrow();
  });
});

describe("text normalized to WinAnsi", () => {
  const resolution = "Año, acción: ¿qué pasó? ¡Listo! • Cuota 4 · Red de cobro Norte — hecho. Mora ≤ 3 días → resuelto ✓ 👍 “sí” ‘ok’ ‐ fin.";

  it("keeps ñ, á, ¿, ¡, •, · and — and maps ≤, →, ✓ and dashes outside WinAnsi, dropping emojis", async () => {
    const text = await fullText(renderDocument({ ...FIXTURES.ANSWER, resolution }).bytes);
    for (const kept of ["Año", "acción", "¿qué pasó?", "¡Listo!", "• Cuota 4", "· Red", "— hecho", "<= 3 días", "-> resuelto OK", "“sí”", "‘ok’", "- fin."]) expect(text).toContain(kept);
    for (const gone of ["≤", "→", "✓", "👍", "‐"]) expect(text).not.toContain(gone);
  });

  it("escapes PDF syntax inside the text instead of interpreting it", async () => {
    const hostile = "Texto (con paréntesis) y \\barra ) Tj ET BT /F1 72 Tf (inyectado";
    const doc = renderDocument({ ...FIXTURES.ANSWER, resolution: hostile });
    expect(await fullText(doc.bytes)).toContain("Texto (con paréntesis) y \\barra ) Tj ET BT /F1 72 Tf (inyectado");
    expect(latin1(doc.bytes)).not.toContain("/F1 72 Tf (inyectado)");
  });

  it("rejects control characters in a one-line field", () => {
    expect(() => renderDocument({ ...FIXTURES.ANSWER, facts: ["línea\u0007"] })).toThrow();
  });
});

describe("long documents", () => {
  it("repeats the letterhead, the legend and the page number on every page", async () => {
    const facts = Array.from({ length: 20 }, (_, index) => `Hecho ${index + 1}: la operación ${index + 1} figura en el core con su fecha y su importe, sin diferencias.`);
    const resolution = Array.from({ length: 30 }, (_, index) => `Párrafo ${index + 1} de la resolución, con el detalle de lo revisado y lo resuelto en tu reclamo.`).join("\n");
    const doc = renderDocument({ ...FIXTURES.ANSWER, facts, resolution });
    const pages = await pagesText(doc.bytes);
    expect(doc.pageCount).toBeGreaterThan(1);
    expect(pages).toHaveLength(doc.pageCount);
    pages.forEach((page, index) => {
      expect(page).toContain(PDF_COMMON.LETTERHEAD);
      expect(page).toContain(PDF_COMMON.SYNTHETIC_LEGEND);
      expect(page).toContain(`Página ${index + 1} de ${doc.pageCount}`);
    });
    expect(pages.at(-1)).toContain(`FINAL_ANSWER ${FINAL_HASH}`);
  });

  it("wraps a long action label inside its column", async () => {
    const label = "Reintegro del débito duplicado de la cuota 6 debitada dos veces, acreditado en la billetera con su interés compensatorio";
    const text = await fullText(renderDocument({ ...FIXTURES.ANSWER, actions: [{ label, amountCents: 14_630_000 }] }).bytes);
    expect(text).toContain("$ 146.300,00");
    expect(text).toContain("Reintegro del débito duplicado");
    expect(text).toContain("interés compensatorio");
  });
});
