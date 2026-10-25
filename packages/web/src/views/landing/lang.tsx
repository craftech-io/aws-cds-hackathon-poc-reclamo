// Language of the landing: Spanish by default, English with `?lang=en` so a shared link opens in the
// same language, and a switch on the page that keeps the address in step (the other parameters and
// the anchor kept). The document's `lang` and title follow the choice, so a screen reader reads each
// version in its own language. React context, no state library.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LANDING_COPY, type LandingCopy, type LandingLang } from "./copy";

interface LandingLangValue {
  readonly lang: LandingLang;
  readonly copy: LandingCopy;
  setLang(lang: LandingLang): void;
}

const LandingLangContext = createContext<LandingLangValue | undefined>(undefined);

export function langFromSearch(search: URLSearchParams): LandingLang {
  return search.get("lang") === "en" ? "en" : "es";
}

/** `search` with `lang` set for English and dropped for Spanish (the default), every other parameter kept. */
export function searchWithLang(search: URLSearchParams, lang: LandingLang): string {
  const next = new URLSearchParams(search);
  if (lang === "en") next.set("lang", "en");
  else next.delete("lang");
  const text = next.toString();
  return text ? `?${text}` : "";
}

export function LandingLangProvider({ initial, children }: { readonly initial: LandingLang; readonly children: ReactNode }) {
  const [lang, setCurrent] = useState<LandingLang>(initial);

  useEffect(() => {
    const root = document.documentElement;
    const previous = { lang: root.lang, title: document.title };
    root.lang = LANDING_COPY[lang].meta.code;
    document.title = LANDING_COPY[lang].meta.title;
    return () => {
      root.lang = previous.lang;
      document.title = previous.title;
    };
  }, [lang]);

  const setLang = useCallback((next: LandingLang) => {
    setCurrent(next);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${searchWithLang(new URLSearchParams(search), next)}${hash}`);
  }, []);

  const value = useMemo<LandingLangValue>(() => ({ lang, copy: LANDING_COPY[lang], setLang }), [lang, setLang]);
  return <LandingLangContext.Provider value={value}>{children}</LandingLangContext.Provider>;
}

/** Spanish outside a provider, so a reused figure never renders without text. */
export function useLandingCopy(): LandingCopy {
  return useContext(LandingLangContext)?.copy ?? LANDING_COPY.es;
}

export function useLandingLang(): LandingLangValue | undefined {
  return useContext(LandingLangContext);
}

/** The es/en switch: a short label ("EN", or the full name with `full`) named for assistive technology; 44 px tall. */
export function LangSwitch({ className = "", full = false }: { readonly className?: string; readonly full?: boolean }) {
  const value = useLandingLang();
  if (!value) return null;
  const next: LandingLang = value.lang === "es" ? "en" : "es";
  return (
    <button
      type="button"
      lang={next}
      aria-label={`${value.copy.lang.label}: ${value.copy.lang.switchTo}`}
      onClick={() => value.setLang(next)}
      className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-mist px-2 text-xs font-semibold text-pine hover:bg-paper ${className}`}
    >
      {full ? value.copy.lang.switchTo : value.copy.lang.short}
    </button>
  );
}
