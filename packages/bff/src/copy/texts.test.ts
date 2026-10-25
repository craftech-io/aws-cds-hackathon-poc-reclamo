import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ComplaintType, MessageKind } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { BLOCK_SOURCE_REASON, GATE_FAILURE_CODES, REROUTE_LABEL, gateFailureGloss, tapeBanner } from "./block-reasons";
import * as gloss from "./en-gloss";
import * as es from "./es-AR";
import { CopyParamError, capitalize, charCount, fill, placeholdersOf } from "./helpers";
import { PDF_CHANNEL_LABEL, PDF_COMMON, PDF_DOC, PDF_INSTALMENT_STATUS } from "./pdf-texts";
import { BlockSource, ChallengeKind, DocKind } from "./types";

type TextRecord = Readonly<Record<string, string>>;

/** Each Spanish record with its English gloss. */
const PAIRS: ReadonlyArray<readonly [string, TextRecord, TextRecord]> = [
  ["WHATSAPP_TEXT", es.WHATSAPP_TEXT, gloss.WHATSAPP_GLOSS],
  ["EMAIL_TEXT", es.EMAIL_TEXT, gloss.EMAIL_GLOSS],
  ["STAFF_TEXT", es.STAFF_TEXT, gloss.STAFF_GLOSS],
  ["CONSOLE_ES", es.CONSOLE_ES, gloss.CONSOLE_EN],
  ["COMPLAINT_TYPE_LABEL", es.COMPLAINT_TYPE_LABEL, gloss.COMPLAINT_TYPE_GLOSS],
  ["COMPLAINT_OUTCOME_LABEL", es.COMPLAINT_OUTCOME_LABEL, gloss.COMPLAINT_OUTCOME_GLOSS],
  ["COMPLAINT_STATUS_LABEL", es.COMPLAINT_STATUS_LABEL, gloss.COMPLAINT_STATUS_GLOSS],
  ["SLA_STATE_LABEL", es.SLA_STATE_LABEL, gloss.SLA_STATE_GLOSS],
  ["HANDOFF_REASON_LABEL", es.HANDOFF_REASON_LABEL, gloss.HANDOFF_REASON_GLOSS],
  ["MESSAGE_KIND_LABEL", es.MESSAGE_KIND_LABEL, gloss.MESSAGE_KIND_GLOSS],
  ["ACCOUNT_BLOCK_CATEGORY_TEXT", es.ACCOUNT_BLOCK_CATEGORY_TEXT, gloss.ACCOUNT_BLOCK_CATEGORY_GLOSS],
  ["DATA_CHANGE_FIELD_LABEL", es.DATA_CHANGE_FIELD_LABEL, gloss.DATA_CHANGE_FIELD_GLOSS],
  ["LOAN_STATUS_TEXT", es.LOAN_STATUS_TEXT, gloss.LOAN_STATUS_GLOSS],
  ["INSTALMENT_STATUS_TEXT", es.INSTALMENT_STATUS_TEXT, gloss.INSTALMENT_STATUS_GLOSS],
];

const spanishTexts = () => PAIRS.flatMap(([name, record]) => Object.entries(record).map(([key, text]) => [`${name}.${key}`, text] as const));

describe("es-AR fixed texts", () => {
  it("carries the fixed texts the design quotes, word for word where it quotes them", () => {
    const { WHATSAPP_TEXT: wa, STAFF_TEXT: staff } = es;
    expect(es.AUTOMATED_DISCLOSURE).toMatch(/^Soy el asistente automatizado de Jarilla \(ficticio\)\./);
    expect(wa.IMAGE_NOT_PROCESSED).toBe("No pudimos procesar la imagen; mandala de nuevo o hablá con alguien.");
    expect(wa.MEDIA_TOO_LARGE).toMatch(/mandame una foto más liviana/i);
    expect(wa.RECEIPT_REQUEST).toMatch(/^Mandame una foto del comprobante/);
    expect(es.HOLDING_NOTICE).toMatch(/^Estamos revisando tu reclamo \{\{complaintNumber\}\}; te escribimos apenas tengamos novedades\.$/);
    expect(wa.HANDOFF_NOTICE).toMatch(/^Una persona de Jarilla sigue tu reclamo \{\{complaintNumber\}\}/);
    expect(wa.UNKNOWN_SENDER).toMatch(/no está asociado a una cuenta de Jarilla.*podés hablar con una persona/);
    expect(wa.EMAIL_UNDELIVERED).toBe("No pudimos entregar la respuesta a tu email; una persona te contacta.");
    expect(wa.HANDOFF_GUARDRAIL).toBe("No puedo seguir con ese mensaje; te paso con una persona.");
    expect(wa.SAFETY_GUIDANCE).toMatch(/nunca te vamos a pedir claves, PIN, códigos de verificación ni datos de tarjetas/);
    expect(wa.OPT_OUT_CONFIRMATION).toMatch(/esto no es una baja/);
    expect(wa.OUT_OF_SCOPE_ADVICE).toMatch(/BCRA/);
    expect(staff.WORLD_NOT_READY).toBe("Tu mundo todavía no está listo; probá de nuevo en un minuto o usá otra cuenta.");
    expect(staff.WORLD_RESETTING).toBe("Estamos reiniciando tu mundo; tarda unos minutos.");
    expect(staff.SIMULATOR_UPLOAD_NOTICE).toMatch(/^Solo comprobantes sintéticos o de prueba; no subas documentos reales\./);
    expect(es.EMAIL_TEXT.FROM_NAME).toBe("Jarilla (ficticio) vía Reclamo en regla");
    expect(es.EMAIL_TEXT.SUBJECT_ANSWER).toBe("Reclamo {{complaintNumber}} · Respuesta escrita");
    expect(es.EMAIL_TEXT.SUBJECT_ACK).toBe("Reclamo {{complaintNumber}} · Acuse de recibo");
    expect(es.EMAIL_TEXT.SUBJECT_COLLECTION_NOTICE).toBe("Aviso formal de deuda · Jarilla (ficticio)");
    expect(wa.LIVE_PROFILE).toBe("Reclamo en regla (demo) · Jarilla es un prestamista ficticio");
    expect(es.CONSOLE_ES.RECENT_LOGIN_TITLE).toBe("Aprobar dinero exige un login reciente");
    expect(gloss.CONSOLE_EN.RECENT_LOGIN_TITLE).toBe("Approving money requires a recent sign-in");
  });

  it("acknowledges with number, type and deadline and never with account data", () => {
    for (const key of ["COMPLAINT_ACK", "CONSULTA_ACK", "COMPLAINT_ACK_EXISTING"] as const) {
      expect(placeholdersOf(es.WHATSAPP_TEXT[key]), key).toEqual(["complaintNumber", "complaintType", "deadlineText"]);
    }
    expect(fill(es.WHATSAPP_TEXT.COMPLAINT_ACK, { complaintNumber: "R-2026-000123", complaintType: es.COMPLAINT_TYPE_LABEL.PAYMENT_NOT_REFLECTED, deadlineText: "jueves 22/10" })).toBe(
      "Registré tu reclamo R-2026-000123 (pago no reflejado). La respuesta escrita te llega a más tardar el jueves 22/10.",
    );
  });

  it("has a challenge prompt for every kind the core checks, none asking for a document or a secret", () => {
    for (const kind of ChallengeKind.options) {
      const prompt = es.WHATSAPP_TEXT[es.CHALLENGE_PROMPT[kind]];
      expect(prompt, kind).toMatch(/^Para ver tu cuenta, decime /);
      expect(prompt, kind).not.toMatch(/documento|dni|clave|pin|c[oó]digo|tarjeta|cbu|cvu/i);
      // A copy of the prompt can never be an answer: no example date or amount in it.
      expect(prompt, kind).not.toMatch(/\d/);
      expect(gloss.WHATSAPP_GLOSS[es.CHALLENGE_PROMPT[kind]], kind).not.toMatch(/\d/);
    }
  });

  it("labels every complaint type and message kind", () => {
    expect(Object.keys(es.COMPLAINT_TYPE_LABEL).sort()).toEqual([...ComplaintType.options].sort());
    expect(Object.keys(es.MESSAGE_KIND_LABEL).sort()).toEqual([...MessageKind.options].sort());
    expect(es.MESSAGE_KIND_LABEL.COLLECTION_REMINDER).toBe("Recordatorio de mora");
  });

  it("is tidy Rioplatense Spanish: trimmed, single spaces, balanced ¿? and ¡!, voseo, no 'bot' or 'IA'", () => {
    const tuteo = /(?<![\p{L}])(?:puedes|tienes|quieres|debes|necesitas|dime|envíame|mándame|cuéntame|escríbenos|sabes|eres)(?![\p{L}])/iu;
    for (const [source, text] of spanishTexts()) {
      expect(text.trim(), source).toBe(text);
      expect(text, source).not.toMatch(/ {2,}|\n/);
      expect((text.match(/¿/g) ?? []).length, source).toBe((text.match(/\?/g) ?? []).length);
      expect((text.match(/¡/g) ?? []).length, source).toBe((text.match(/!/g) ?? []).length);
      expect(text, source).not.toMatch(tuteo);
      expect(text, source).not.toMatch(/(?<![\p{L}])(?:bot|IA|ticket|asistente virtual|deudor)(?![\p{L}])/u);
    }
  });
});

describe("English gloss", () => {
  it("glosses every Spanish key with the same placeholders", () => {
    for (const [name, spanish, english] of PAIRS) {
      expect(Object.keys(english).sort(), name).toEqual(Object.keys(spanish).sort());
      for (const [key, text] of Object.entries(spanish)) {
        const en = english[key] ?? "";
        expect(en.trim().length, `${name}.${key}`).toBeGreaterThan(0);
        expect(placeholdersOf(en), `${name}.${key}`).toEqual(placeholdersOf(text));
        expect(en, `${name}.${key}`).not.toMatch(/[¿¡ñ]/);
      }
    }
  });

  it("glosses the navigation, headings, key buttons and the recent-login modal of the console", () => {
    const prefixes = new Set(Object.keys(es.CONSOLE_ES).map((key) => key.split("_")[0]));
    expect([...prefixes].sort()).toEqual(["BUTTON", "HEADING", "NAV", "RECENT"]);
  });
});

describe("compliance tape banner and block reasons", () => {
  it("renders the red banner of the design for the collection block, with its gloss", () => {
    expect(tapeBanner("BLOCKED", "CH-WA-NO-COLLECTION")).toEqual({
      es: "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · Política comercial de WhatsApp (cobro de deudas)",
      en: "BLOCKED · CH-WA-NO-COLLECTION · WhatsApp Commerce Policy (debt collection)",
    });
    expect(tapeBanner("ALLOWED")).toEqual({ es: "PERMITIDO · ALLOWED", en: "ALLOWED" });
  });

  it("explains every rule, the guardrail and the deterministic check, in both languages", () => {
    for (const source of BlockSource.options) {
      expect(BLOCK_SOURCE_REASON[source].short.length, source).toBeGreaterThan(0);
      expect(BLOCK_SOURCE_REASON[source].detail.length, source).toBeGreaterThan(BLOCK_SOURCE_REASON[source].short.length);
      expect(gloss.BLOCK_SOURCE_GLOSS[source].detail.length, source).toBeGreaterThan(0);
    }
    for (const code of GATE_FAILURE_CODES) expect(gateFailureGloss(code).en.length, code).toBeGreaterThan(0);
  });

  it("names the two allowed paths as the console offers them (FL-064)", () => {
    expect(REROUTE_LABEL).toEqual({ HUMAN_QUEUE: "Derivar a la cola humana", FORMAL_EMAIL: "Enviar aviso formal por email" });
    expect(Object.keys(gloss.REROUTE_GLOSS).sort()).toEqual(Object.keys(REROUTE_LABEL).sort());
  });
});

// WinAnsi (cp1252) = Latin-1 without the C1 controls, plus these 27 characters.
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const isWinAnsi = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(char);
};

describe("PDF texts", () => {
  const pdfTexts = () => [PDF_COMMON, PDF_CHANNEL_LABEL, PDF_INSTALMENT_STATUS, ...Object.values(PDF_DOC)].flatMap((record) => Object.values(record));

  it("are WinAnsi-encodable as written, so pdf/winansi.ts never degrades them", () => {
    for (const text of pdfTexts()) expect([...text].filter((char) => !isWinAnsi(char)), text).toEqual([]);
  });

  it("carry the letterhead, the brand, the synthetic-data legend and the payoff sentence", () => {
    expect(PDF_COMMON.LETTERHEAD).toBe("Jarilla — préstamos y billetera (prestamista ficticio)");
    expect(PDF_COMMON.BRAND).toBe("Reclamo en regla · Powered by Craftech");
    expect(PDF_COMMON.SYNTHETIC_LEGEND).toBe("Documento de demostración con datos sintéticos");
    expect(PDF_COMMON.PRODUCER).toBe("reclamo-en-regla");
    expect(PDF_DOC.PAYOFF_CERTIFICATE.STATEMENT).toMatch(/no registra deuda por este préstamo/i);
    for (const kind of DocKind.options) {
      expect(PDF_DOC[kind].TITLE.length, kind).toBeGreaterThan(0);
      expect(PDF_DOC[kind].SUBJECT.length, kind).toBeGreaterThan(0);
    }
  });
});

describe("helpers", () => {
  it("fills every placeholder and refuses a missing, unused or control-character value", () => {
    expect(fill("Reclamo {{complaintNumber}}", { complaintNumber: "R-2026-000123" })).toBe("Reclamo R-2026-000123");
    expect(() => fill("Reclamo {{complaintNumber}}", {})).toThrow(CopyParamError);
    expect(() => fill("Reclamo", { complaintNumber: "R-2026-000123" })).toThrow(CopyParamError);
    expect(() => fill("Reclamo {{complaintNumber}}", { complaintNumber: "R-1\r\nBcc: x" })).toThrow(CopyParamError);
    expect(placeholdersOf("{{b}} {{a}} {{b}} {{1}}")).toEqual(["1", "a", "b"]);
  });

  it("counts characters as Meta does and capitalizes accented words", () => {
    expect(charCount("Sí, a ese email")).toBe(15);
    expect(charCount("Sí, a ese email".normalize("NFD"))).toBe(15);
    expect(capitalize("débito duplicado")).toBe("Débito duplicado");
  });
});

describe("module boundaries of copy/", () => {
  it("imports only zod, @reclamo/shared and itself, so the console and the seed can import it", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "testing.ts");
    expect(sources.length).toBeGreaterThanOrEqual(11);
    for (const file of sources) {
      const specifiers = [...readFileSync(`${dir}/${file}`, "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const specifier of specifiers) expect(specifier, file).toMatch(/^(?:\.\/[a-z-]+(?:-AR)?|zod|@reclamo\/shared)$/);
    }
  });
});
