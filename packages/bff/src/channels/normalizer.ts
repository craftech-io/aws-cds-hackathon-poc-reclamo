// Every inbound text becomes data here, before anything stores it or shows it to the model
// (docs/architecture.md §13 "PII" and "Contenido no confiable", FL-058, FL-059):
//
//   1. Unicode NFC; every Unicode space becomes an ASCII space (a no-break space never hides a
//      grouped number); control and invisible format characters go (zero-width, bidi overrides,
//      BOM); line breaks are unified and runs of blank lines collapse;
//   2. DNI, CUIT/CUIL, CBU/CVU, cards (Luhn) and secrets next to "clave/PIN/código" become typed
//      markers (`[DNI]`, `[CUIT]`, `[CBU]`, `[TARJETA]`, `[CLAVE]`) with the patterns of lib/mask.ts,
//      the only source (also of lib/log.ts and of G1's regexes). In a self-signup world (`gs-*`)
//      emails and phone numbers too, E.164 or local of 8 to 15 digits (`[EMAIL]`, `[TELEFONO]`): a
//      visitor may type their own, and the register and the tape are append-only
//      (docs/architecture-guests.md §10);
//   3. the text is capped at 4,000 characters; the caller records the cut (`truncated`).
//
// The turn envelope then carries the text escaped (`&`, `<`, `>`, quotes) inside a block whose tag
// has a random suffix per turn, so a customer can never close it and forge an `<event>`, a
// `<facts>` or a `<tool-result>` (docs/architecture.md §9).
import { randomBytes } from "node:crypto";
import { guestOriginOf } from "@reclamo/shared";
import { type MaskLabel, asciiSpaces, maskLabels } from "../lib/mask";

/** Longest inbound text that is stored and shown to the model. */
export const INBOUND_MAX_CHARS = 4_000;

/** What is masked in every world. */
export const BASE_MASK_LABELS: readonly MaskLabel[] = ["TARJETA", "CBU", "CUIT", "DNI", "CLAVE"];

/** What a self-signup world adds: emails, E.164 numbers and local numbers of 8 to 15 digits, all `[TELEFONO]`. */
export const SIGNUP_MASK_LABELS: readonly MaskLabel[] = ["EMAIL", "TELEFONO", "LOCAL_PHONE"];

export function maskLabelsFor(worldId: string): ReadonlySet<MaskLabel> {
  return new Set<MaskLabel>(guestOriginOf(worldId) === "SIGNUP" ? [...BASE_MASK_LABELS, ...SIGNUP_MASK_LABELS] : BASE_MASK_LABELS);
}

export interface NormalizedText {
  /** Masked text, at most `INBOUND_MAX_CHARS` characters. */
  readonly text: string;
  /** The text was cut; the caller records it. */
  readonly truncated: boolean;
  /** Characters of the masked text before the cut. */
  readonly originalChars: number;
  /** How many values of each kind were masked. */
  readonly maskCounts: Readonly<Partial<Record<MaskLabel, number>>>;
}

// C0 and C1 controls except tab and line feed, plus the invisible format characters used to hide or
// reorder text (zero-width, bidi overrides and isolates, word joiners, BOM).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// A cut in the middle of a marker leaves "[TARJ": drop the partial marker.
const PARTIAL_MARKER = /\[[A-Z]{0,8}$/;

function cleanWhitespace(raw: string): string {
  return asciiSpaces(raw.normalize("NFC"))
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Steps 1-3 for any inbound text of `worldId` (a WhatsApp text, a caption, a button's title). */
export function normalizeInboundText(raw: string, worldId: string, maxChars: number = INBOUND_MAX_CHARS): NormalizedText {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  const { text: masked, counts } = maskLabels(cleanWhitespace(raw), maskLabelsFor(worldId));
  const chars = [...masked];
  if (chars.length <= maxChars) return { text: masked, truncated: false, originalChars: chars.length, maskCounts: counts };
  const cut = chars.slice(0, maxChars).join("").replace(PARTIAL_MARKER, "").trimEnd();
  return { text: cut, truncated: true, originalChars: chars.length, maskCounts: counts };
}

// ---- The untrusted block of the turn envelope --------------------------------------------------

/** `inbound-<12 hex>`: the tag of the untrusted block, new every turn and named by that turn's prompt. */
export const TURN_DELIMITER_PATTERN = /^inbound-[0-9a-f]{12}$/;

export function newTurnDelimiter(random: (size: number) => Uint8Array = randomBytes): string {
  const delimiter = `inbound-${Buffer.from(random(6)).toString("hex")}`;
  if (!TURN_DELIMITER_PATTERN.test(delimiter)) throw new RangeError("a turn delimiter needs 6 random bytes");
  return delimiter;
}

/** `&`, `<`, `>` and both quotes as entities: the text can hold no tag and close no attribute. */
export function escapeUntrusted(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export type BlockAttributes = Readonly<Record<string, string | number | boolean>>;

/**
 * `<inbound-7f3a9c0b1d2e channel="WHATSAPP" kind="TEXT" truncated="false">…</inbound-7f3a9c0b1d2e>`:
 * the text (already normalized) escaped inside the turn's delimiter.
 */
export function untrustedBlock(delimiter: string, text: string, attributes: BlockAttributes = {}): string {
  if (!TURN_DELIMITER_PATTERN.test(delimiter)) throw new RangeError("not a turn delimiter");
  const rendered = Object.entries(attributes).map(([name, value]) => {
    if (!ATTRIBUTE_NAME.test(name)) throw new RangeError(`invalid attribute name "${name}"`);
    return ` ${name}="${escapeUntrusted(String(value))}"`;
  });
  return `<${delimiter}${rendered.join("")}>\n${escapeUntrusted(text)}\n</${delimiter}>`;
}
