// Opt-out by keyword and the ambiguous "baja" (FL-006, CONTEXT.md "Opt-out" and "Baja"). A text that
// is exactly one of the opt-out words, after folding case, accents, punctuation and spaces, stops
// WhatsApp messages without the model. "baja" alone could mean stopping messages or closing the
// account (a right that is registered on the spot): it never does either by itself, it gets two
// buttons to choose ("No recibir mensajes" / "Baja de mi cuenta"). A longer sentence is not a
// keyword: it reaches the classifier and the agent, which can neither opt out nor close an account.
import { BUTTON_TITLES } from "../../copy";
import type { ButtonToIssue } from "./nonces";

/** Lower case, no diacritics, no punctuation, single spaces: "¡STOP!" → "stop". */
export function foldKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const OPT_OUT_TITLE = BUTTON_TITLES.OPT_OUT.INTERACTIVE ?? "";

/** Exact texts that opt out, already folded (the button's title counts: a tap whose nonce expired still means it). */
export const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set(
  ["NO RECIBIR", "STOP", "no quiero recibir más mensajes", "no quiero recibir mensajes", OPT_OUT_TITLE].filter((word) => word !== "").map(foldKeyword),
);

/** The ambiguous words: alone, they get the choice of buttons. */
export const AMBIGUOUS_BAJA: ReadonlySet<string> = new Set(["baja"]);

export type KeywordIntent = "OPT_OUT" | "BAJA_AMBIGUOUS" | undefined;

/** What a text means by itself, before any classifier: an opt-out, the ambiguous "baja", or nothing. */
export function keywordIntent(text: string): KeywordIntent {
  const folded = foldKeyword(text);
  if (OPT_OUT_KEYWORDS.has(folded)) return "OPT_OUT";
  if (AMBIGUOUS_BAJA.has(folded)) return "BAJA_AMBIGUOUS";
  return undefined;
}

/** The two buttons of the ambiguous "baja": stop messages, or close the account. */
export const BAJA_CHOICE: readonly ButtonToIssue[] = [{ action: "OPT_OUT" }, { action: "CONFIRM_CLOSURE" }];
