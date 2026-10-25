import { ComplaintType } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { containsCard, maskSensitive } from "../lib/mask";
import { PERSONA_SCRIPTS, UNLINKED_NUMBER_SCRIPT, personaScript } from "./persona-scripts";
import type { PersonaId, PersonaScript } from "./persona-scripts";
import { readRepoFile } from "./testing";
import { ReceiptVariant } from "./types";

/** `FL-076…FL-080` → FL-076, FL-077, …, FL-080. */
function expandFlows(cell: string): string[] {
  return cell.split(",").flatMap((part) => {
    const range = /FL-(\d{3})…FL-(\d{3})/.exec(part);
    if (!range) return [part.trim()];
    const [from, to] = [Number(range[1]), Number(range[2])];
    return Array.from({ length: to - from + 1 }, (_, index) => `FL-${String(from + index).padStart(3, "0")}`);
  });
}

/** Persona rows of docs/seed-spec.md §8: id → name, scenario and flows. */
function seedSpecPersonas(): Map<string, { name: string; scenario: string; flows: string[] }> {
  const spec = readRepoFile("docs/seed-spec.md");
  const section = spec.slice(spec.indexOf("## 8."), spec.indexOf("## 9."));
  const rows = section.split("\n").filter((line) => /^\| C\d{2} \|/.test(line));
  return new Map(
    rows.map((line) => {
      const [id = "", name = "", scenario = "", , flows = ""] = line.slice(2, -2).split(" | ");
      return [id, { name, scenario, flows: expandFlows(flows) }];
    }),
  );
}

/** Quoted texts of the "Disparador" of each flow of docs/flows-catalog.md, unescaped. */
function flowTriggers(): Map<string, string[]> {
  const catalog = readRepoFile("docs/flows-catalog.md");
  const triggers = new Map<string, string[]>();
  for (const block of catalog.split(/\n(?=### FL-\d{3} · )/)) {
    const id = /^### (FL-\d{3})/.exec(block)?.[1];
    const line = block.split("\n").find((text) => text.includes("Disparador:")) ?? "";
    const trigger = line.slice(line.indexOf("Disparador:"));
    if (id) triggers.set(id, [...trigger.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] ?? "").replace(/\\"/g, '"')));
  }
  return triggers;
}

const lower = (text: string) => text.normalize("NFC").toLowerCase();
const script = (id: PersonaId): PersonaScript => {
  const found = personaScript(id);
  if (!found) throw new Error(`no persona ${id}`);
  return found;
};

describe("persona scripts of the phone simulator", () => {
  it("has the 41 personas C01…C41 of docs/seed-spec.md §8 with their name, scenario and flows", () => {
    const spec = seedSpecPersonas();
    expect(PERSONA_SCRIPTS.map((persona) => persona.id)).toEqual(Array.from({ length: 41 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`));
    expect(spec.size).toBe(41);
    for (const persona of PERSONA_SCRIPTS) {
      const row = spec.get(persona.id);
      expect(row, persona.id).toBeDefined();
      expect(persona.name, persona.id).toBe(row?.name);
      expect(persona.scenario, persona.id).toBe(row?.scenario);
      expect([...persona.flows].sort(), persona.id).toEqual([...(row?.flows ?? [])].sort());
    }
    expect(new Set(PERSONA_SCRIPTS.map((persona) => persona.name)).size).toBe(41);
  });

  it("cites only flows of docs/flows-catalog.md", () => {
    const flows = flowTriggers();
    for (const persona of PERSONA_SCRIPTS) for (const flow of persona.flows) expect(flows.has(flow), `${persona.id} ${flow}`).toBe(true);
    for (const flow of UNLINKED_NUMBER_SCRIPT.flows) expect(flows.has(flow)).toBe(true);
  });

  it("keeps the customer's words of each flow trigger it drives", () => {
    const flows = flowTriggers();
    const pairs: ReadonlyArray<readonly [PersonaId, string]> = [
      ["C01", "FL-010"], ["C02", "FL-033"], ["C05", "FL-030"], ["C06", "FL-049"], ["C06", "FL-050"], ["C08", "FL-008"],
      ["C08", "FL-009"], ["C10", "FL-005"], ["C15", "FL-026"], ["C22", "FL-032"], ["C25", "FL-037"], ["C27", "FL-041"],
      ["C31", "FL-045"], ["C32", "FL-046"], ["C35", "FL-051"], ["C36", "FL-052"], ["C36", "FL-053"], ["C37", "FL-054"],
      ["C37", "FL-055"], ["C40", "FL-056"], ["C40", "FL-057"], ["C40", "FL-058"],
    ];
    for (const [id, flow] of pairs) {
      const quotes = flows.get(flow) ?? [];
      expect(quotes.length, flow).toBeGreaterThan(0);
      const texts = script(id).messages.map((message) => lower(message.text));
      for (const quote of quotes) expect(texts.some((text) => text.includes(lower(quote))), `${id} ${flow}: "${quote}"`).toBe(true);
    }
  });

  it("gives every message a Spanish text, an English gloss and the expected intake decision", () => {
    for (const persona of PERSONA_SCRIPTS) {
      expect(persona.scenarioEn.length, persona.id).toBeGreaterThan(0);
      for (const message of persona.messages) {
        expect(message.text.trim(), persona.id).toBe(message.text);
        expect(message.en.trim().length, persona.id).toBeGreaterThan(0);
        if (message.intake.kind === "RECLAMO") expect(ComplaintType.options, persona.id).toContain(message.intake.type);
      }
      expect(persona.messages[0].intake.kind, persona.id).not.toBe("FOLLOW_UP");
    }
  });

  it("scripts a reclamo for every complaint type the customer can raise", () => {
    const types = new Set(PERSONA_SCRIPTS.flatMap((persona) => persona.messages.flatMap((message) => (message.intake.kind === "RECLAMO" ? [message.intake.type] : []))));
    expect([...types].sort()).toEqual(ComplaintType.options.filter((type) => type !== "INFORMATION_REQUEST").sort());
  });

  it("attaches the synthetic receipt variant each scenario needs (docs/seed-spec.md §9 and §12)", () => {
    const variants = (id: PersonaId) => script(id).messages.flatMap((message) => (message.attachment?.kind === "RECEIPT_IMAGE" ? [`${message.attachment.variant}#${message.attachment.seq}`] : []));
    for (const id of ["C01", "C04", "C11", "C12", "C13", "C14", "C15", "C17"] as const) expect(variants(id), id).toEqual(["legible#1"]);
    expect(variants("C16")).toEqual(["blurry#1", "blurry#2"]);
    expect(variants("C07")).toEqual(["fake-check#1"]);
    expect(variants("C18")).toEqual(["fake-unknown#1"]);
    expect(variants("C19")).toEqual(["injection#1"]);
    expect(variants("C20")).toEqual(["not-receipt#1"]);
    expect(variants("C41")).toEqual(["other-payer#1"]);
    expect(script("C20").messages.some((message) => message.attachment?.kind === "PDF_DOCUMENT")).toBe(true);
    for (const persona of PERSONA_SCRIPTS) {
      for (const message of persona.messages) if (message.attachment?.kind === "RECEIPT_IMAGE") expect(ReceiptVariant.options).toContain(message.attachment.variant);
    }
  });

  it("carries no card, document, account number, email or phone, not even synthetic", () => {
    const texts = [...PERSONA_SCRIPTS.flatMap((persona) => persona.messages.map((message) => message.text)), UNLINKED_NUMBER_SCRIPT.text];
    for (const text of texts) {
      expect(containsCard(text), text).toBe(false);
      expect(maskSensitive(text), text).toBe(text);
    }
  });
});
