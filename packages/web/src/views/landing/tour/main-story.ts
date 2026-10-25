// The customer of the landing's main story (docs/landing-spec.md §3.1): Valeria Quiroga (`C01`) and the
// first message of her script, the one the tour's first capture shows and step 1 quotes. Its single
// source is packages/bff/src/copy/persona-scripts.ts (Spanish, with its English gloss). No React here:
// the landing's copy imports it.
import { personaScript } from "@reclamo/bff/copy/persona-scripts";
import type { Glossed } from "@reclamo/bff/copy/types";

const valeria = personaScript("C01");
if (!valeria) throw new Error("persona C01 is missing from copy/persona-scripts");

export const CUSTOMER_NAME = valeria.name;

/** What Valeria writes (her script in the phone simulator). */
export const CUSTOMER_MESSAGE: Glossed = { es: valeria.messages[0].text, en: valeria.messages[0].en };
