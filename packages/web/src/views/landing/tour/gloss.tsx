// The product speaks Spanish to the customer and to the console; on the English page every text of a
// render keeps its Spanish original and shows the fixed English gloss of packages/bff/src/copy next
// to it (docs/landing-spec.md §3.2), the pattern the console's tape banner already uses.
import type { Glossed } from "@reclamo/bff/copy/types";
import { useLandingLang } from "../lang";

export function useShowGloss(): boolean {
  return useLandingLang()?.lang === "en";
}

/** The English gloss under a Spanish text, on the English page only. */
export function Gloss({ text, className = "" }: { readonly text: Glossed; readonly className?: string }) {
  if (!useShowGloss()) return null;
  return (
    <span lang="en" className={`mt-0.5 block text-xs italic text-slate ${className}`}>
      {text.en}
    </span>
  );
}

/** "BLOQUEADO · BLOCKED" on the English page, the Spanish term alone on the Spanish one. */
export function useInlineGloss(): (text: Glossed) => string {
  const show = useShowGloss();
  return (text) => (show && text.en !== text.es ? `${text.es} · ${text.en}` : text.es);
}
