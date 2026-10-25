import { createHash } from "node:crypto";
import { WaButtonAction } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { maskSensitive } from "../lib/mask";
import { BUTTON_TITLES, ButtonFormError, buttonGloss, buttonTitle } from "./buttons";
import { CURRENT_EMAIL_CONSENT, EMAIL_CONSENT_VERSIONS } from "./consent";
import { BUTTON_GLOSS, CONSENT_GLOSS, STATUS_PHRASE_GLOSS, TEMPLATE_GLOSS } from "./en-gloss";
import { CopyParamError, beyondLabel, charCount, placeholdersOf } from "./helpers";
import { STATUS_PHRASE_IDS, TEMPLATE_STATUS_PHRASES, statusPhrase } from "./template-status";
import { TemplateParamNotAllowedError, WHATSAPP_TEMPLATES, renderTemplateBody, templateButtonTitles, templateParameters } from "./templates";
import { CORPUS_FILE, customerTexts, guardFindings, loadCollectionCorpus, readRepoFile } from "./testing";
import { BUTTON_TITLE_LIMIT, ButtonForm, TemplateName } from "./types";

const DOC_FORMS = ["INTERACTIVE", "LIST_ROW", "QUICK_REPLY"] as const satisfies readonly ButtonForm[];

/** Rows of a markdown table that follow `heading` in docs/architecture-integrations.md §3.3. */
function docRows(heading: string): string[][] {
  const doc = readRepoFile("docs/architecture-integrations.md");
  const section = doc.slice(doc.indexOf("### 3.3"), doc.indexOf("## 4."));
  const lines = section.slice(section.indexOf(heading)).split("\n");
  const start = lines.findIndex((line) => line.startsWith("|"));
  const end = lines.findIndex((line, index) => index > start && !line.startsWith("|"));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split(" | ").map((cell) => cell.replace(/^\| ?| ?\|$/g, "")));
}

const quoted = (cell: string) => [...cell.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");

describe("[FL-060] button titles by form: the derivation to a person fits every form", () => {
  it("[FL-060] keeps every title within Meta's cap for its form (interactive ≤ 20, list row ≤ 24, quick_reply ≤ 25)", () => {
    for (const [action, forms] of Object.entries(BUTTON_TITLES)) {
      for (const [form, title] of Object.entries(forms)) {
        expect(charCount(title), `${action}.${form} "${title}"`).toBeLessThanOrEqual(BUTTON_TITLE_LIMIT[ButtonForm.parse(form)]);
        expect(title.trim()).toBe(title);
      }
    }
    expect(BUTTON_TITLE_LIMIT).toMatchObject({ INTERACTIVE: 20, LIST_ROW: 24, QUICK_REPLY: 25 });
  });

  it("[FL-060] says 'Hablar con alguien' on an interactive button and 'Hablar con una persona' in templates and list rows", () => {
    expect(buttonTitle("TALK_TO_HUMAN", "INTERACTIVE")).toBe("Hablar con alguien");
    expect(buttonTitle("TALK_TO_HUMAN", "LIST_ROW")).toBe("Hablar con una persona");
    expect(buttonTitle("TALK_TO_HUMAN", "QUICK_REPLY")).toBe("Hablar con una persona");
    expect(charCount("Hablar con una persona")).toBeGreaterThan(BUTTON_TITLE_LIMIT.INTERACTIVE);
  });

  it("[FL-060] offers the derivation in every template that has buttons", () => {
    for (const template of Object.values(WHATSAPP_TEMPLATES)) {
      if (template.buttons.length > 0) expect(templateButtonTitles(template.name), template.name).toContain("Hablar con una persona");
    }
  });

  it("matches the title table of docs/architecture-integrations.md §3.3", () => {
    const rows = docRows("**Títulos de botón**");
    expect(rows.length).toBe(5);
    for (const [actionsCell = "", ...cells] of rows) {
      const actions = [...actionsCell.matchAll(/`([A-Z_]+)`/g)].map((match) => WaButtonAction.parse(match[1]));
      DOC_FORMS.forEach((form, index) => {
        const titles = quoted(cells[index] ?? "");
        if (titles.length === 0) return;
        expect(titles).toHaveLength(actions.length);
        actions.forEach((action, position) => expect(BUTTON_TITLES[action][form], `${action}.${form}`).toBe(titles[position]));
      });
    }
  });

  it("titles every action in at least one form, with an English gloss for each title and none for a missing one", () => {
    for (const action of WaButtonAction.options) {
      const forms = Object.keys(BUTTON_TITLES[action]);
      expect(forms.length, action).toBeGreaterThan(0);
      expect(Object.keys(BUTTON_GLOSS[action]).sort()).toEqual([...forms].sort());
      for (const form of forms) expect(buttonGloss(action, ButtonForm.parse(form)).en.length).toBeGreaterThan(0);
    }
  });

  it("refuses a form an action is never rendered in", () => {
    expect(() => buttonTitle("ACCEPT_EMAIL", "QUICK_REPLY")).toThrow(ButtonFormError);
  });
});

describe("WhatsApp UTILITY templates", () => {
  it("are the four templates of docs/architecture-integrations.md §3.3, word for word", () => {
    const rows = docRows("| Nombre | Cuerpo | Botones |");
    expect(rows.map(([name = ""]) => name.replace(/`/g, ""))).toEqual(TemplateName.options);
    for (const [nameCell = "", body = "", buttons = ""] of rows) {
      const template = WHATSAPP_TEMPLATES[TemplateName.parse(nameCell.replace(/`/g, ""))];
      expect(template.body).toBe(quoted(body)[0]);
      expect(templateButtonTitles(template.name)).toEqual(quoted(buttons));
      expect(template.category).toBe("UTILITY");
      expect(template.language).toBe("es_AR");
    }
  });

  it("never starts or ends a body with a parameter", () => {
    for (const template of Object.values(WHATSAPP_TEMPLATES)) {
      expect(template.body.trim().startsWith("{{"), template.name).toBe(false);
      expect(template.body.trim().endsWith("}}"), template.name).toBe(false);
    }
  });

  it("numbers the parameters 1..n, one kind and one example per parameter, and renders the examples", () => {
    for (const template of Object.values(WHATSAPP_TEMPLATES)) {
      const expected = template.params.map((_, index) => String(index + 1)).sort();
      expect(placeholdersOf(template.body), template.name).toEqual(expected);
      expect(template.examples).toHaveLength(template.params.length);
      expect(template.body.length).toBeLessThanOrEqual(1024);
      expect(template.buttons.length).toBeLessThanOrEqual(3);
      expect(placeholdersOf(TEMPLATE_GLOSS[template.name])).toEqual(expected);
    }
    expect(renderTemplateBody("reclamo_novedad", ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"])).toBe(
      "Hola Valeria, hay una novedad en tu reclamo R-2026-000123: ya tenemos la rendición de la red. Podés responder por acá.",
    );
  });

  it("accepts {{3}} of reclamo_novedad only from the closed list of status phrases", () => {
    expect(() => templateParameters("reclamo_novedad", ["Valeria", "R-2026-000123", "tu cuota está vencida"])).toThrow(TemplateParamNotAllowedError);
    try {
      templateParameters("reclamo_novedad", ["Valeria", "R-2026-000123", "cualquier texto"]);
    } catch (error) {
      expect(error).toMatchObject({ code: "TEMPLATE_PARAM_NOT_ALLOWED", position: 3 });
    }
  });

  it("refuses a wrong number of values, an empty value and a value with a line break or a tab", () => {
    expect(() => templateParameters("reclamo_resuelto", ["R-2026-000123"])).toThrow(CopyParamError);
    expect(() => templateParameters("reclamo_resuelto", ["R-2026-000123", "v•••@…", "extra"])).toThrow(CopyParamError);
    expect(() => templateParameters("reclamo_derivado", ["R-2026-000123", " "])).toThrow(CopyParamError);
    expect(() => templateParameters("reclamo_derivado", ["R-2026-000123", "jueves\n22/10"])).toThrow(CopyParamError);
    expect(() => templateParameters("reclamo_derivado", ["R-2026-000123", "jueves\t22/10"])).toThrow(CopyParamError);
  });
});

describe("status phrases of reclamo_novedad {{3}}", () => {
  it("is a closed list with the examples of the design", () => {
    expect(Object.keys(TEMPLATE_STATUS_PHRASES)).toEqual([...STATUS_PHRASE_IDS]);
    const phrases = Object.values(TEMPLATE_STATUS_PHRASES);
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(phrases).toEqual(expect.arrayContaining(["ya tenemos la rendición de la red", "la transferencia ya figura acreditada", "una persona revisó tu caso"]));
    expect(statusPhrase("ya tenemos la rendición de la red")).toBeUndefined();
    expect(statusPhrase("HUMAN_REVIEWED")).toBe("una persona revisó tu caso");
  });

  it("reads inside the template: lower case first, one line, no final punctuation, short", () => {
    for (const [id, phrase] of Object.entries(TEMPLATE_STATUS_PHRASES)) {
      expect(phrase, id).toMatch(/^\p{Ll}/u);
      expect(phrase, id).not.toMatch(/[.,;:!?¿¡]$|[\n\r\t]| {2,}/);
      expect(charCount(phrase)).toBeLessThanOrEqual(80);
      expect(STATUS_PHRASE_GLOSS[id as keyof typeof STATUS_PHRASE_GLOSS].length).toBeGreaterThan(0);
    }
  });
});

describe("outbound texts never collect, ask for a payment, offer credit or ask for sensitive data", () => {
  it("the guard catches the collection, offer and sensitive-data examples of the design and passes service texts", () => {
    const blocked: ReadonlyArray<readonly [string, string]> = [
      ["pagá la cuota hoy", "PAYMENT_EXHORTATION"],
      ["aboná lo que debés", "PAYMENT_EXHORTATION"],
      ["regularizá tu situación", "PAYMENT_EXHORTATION"],
      ["cancelá tu deuda", "PAYMENT_EXHORTATION"],
      ["evitá recargos", "CONSEQUENCE_THREAT"],
      ["si no, informaremos la situación", "CONSEQUENCE_THREAT"],
      ["vamos a iniciar acciones legales", "CONSEQUENCE_THREAT"],
      ["Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos", "DEBT_REMINDER"],
      ["podés pagar el saldo al CVU 9990 0000 0000 0000 0000 00", "PAYMENT_INSTRUMENT"],
      ["te mandamos el link de pago", "PAYMENT_INSTRUMENT"],
      ["te ofrecemos un plan de pagos con quita", "NEGOTIATION"],
      ["¿Querés un préstamo nuevo con tasa preferencial?", "CREDIT_OFFER"],
      ["mandame tu clave", "SENSITIVE_ASK"],
      ["decime el número de tu tarjeta", "SENSITIVE_ASK"],
      ["necesitamos tu DNI", "SENSITIVE_ASK"],
    ];
    for (const [text, category] of blocked) expect(guardFindings(text), text).toContain(category);
    for (const text of ["tu cuota ya no figura atrasada", "tu saldo pendiente es $ 118.640,00", "nunca te vamos a pedir claves ni tarjetas"]) expect(guardFindings(text), text).toEqual([]);
  });

  it("no customer-facing text of copy/ trips the guard (the formal debt notice may only state the debt)", () => {
    const texts = customerTexts();
    expect(texts.length).toBeGreaterThan(100);
    for (const { source, text, formalDebtNotice } of texts) {
      const findings = guardFindings(text).filter((category) => !(formalDebtNotice && category === "DEBT_REMINDER"));
      expect(findings, `${source}: ${text}`).toEqual([]);
    }
  });

  it("no customer-facing text carries personal data, a link or a foreign contact", () => {
    for (const { source, text } of customerTexts()) {
      expect(maskSensitive(text), source).toBe(text);
      expect(text, source).not.toMatch(/https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]{2,}|\.(?:com|net|org|io)(?![\p{L}])/iu);
    }
  });

  const corpus = loadCollectionCorpus();

  it.skipIf(!corpus)(`the guard catches every collection phrase of ${CORPUS_FILE} (0 false negatives)`, () => {
    if (!corpus) return;
    expect(corpus.collection.length - corpus.adversarial.length).toBe(80);
    expect(corpus.service).toHaveLength(80);
    const missed = corpus.collection.filter((entry) => guardFindings(entry.text).length === 0).map((entry) => entry.id ?? entry.text);
    expect(missed).toEqual([]);
  });

  it.skipIf(!corpus)(`no customer-facing text contains a collection phrase of ${CORPUS_FILE}`, () => {
    if (!corpus) return;
    const normalize = (text: string) => text.normalize("NFC").toLowerCase().replace(/[.,;:!?¿¡]/g, "").trim();
    for (const { source, text } of customerTexts()) {
      for (const entry of corpus.collection) expect(normalize(text).includes(normalize(entry.text)), `${source} ⊇ ${String(entry.id ?? entry.text)}`).toBe(false);
    }
  });
});

describe("email-channel consent", () => {
  it("pins the SHA-256 of every published version, so a wording change needs a new version", () => {
    for (const [id, version] of Object.entries(EMAIL_CONSENT_VERSIONS)) {
      expect(version.version).toBe(id);
      expect(createHash("sha256").update(version.question, "utf8").digest("hex"), id).toBe(version.sha256);
      expect(placeholdersOf(version.question)).toEqual(["emailMasked"]);
      expect(placeholdersOf(CONSENT_GLOSS[id as keyof typeof CONSENT_GLOSS])).toEqual(["emailMasked"]);
    }
    expect(CURRENT_EMAIL_CONSENT.version in EMAIL_CONSENT_VERSIONS).toBe(true);
  });
});

describe("beyondLabel", () => {
  it("drops a text that only repeats its label (case, spacing and final period aside) and keeps one that says more", () => {
    expect(beyondLabel("débito duplicado", "Débito duplicado")).toBeUndefined();
    expect(beyondLabel("débito duplicado", "  débito   duplicado. ")).toBeUndefined();
    expect(beyondLabel("débito duplicado", "")).toBeUndefined();
    expect(beyondLabel("débito duplicado", undefined)).toBeUndefined();
    expect(beyondLabel("débito duplicado", "Débito duplicado de la cuota 2.")).toBe("Débito duplicado de la cuota 2.");
  });
});
