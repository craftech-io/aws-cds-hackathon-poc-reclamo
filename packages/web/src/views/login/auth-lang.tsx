// Language of the access screens: Spanish by default, English with `?lang=en` (the landing's own
// convention, views/landing/lang.tsx), remembered for the tab so the screens that follow (the code,
// the provisioning wait inside the console) keep it. The document's `lang` and title follow the
// choice. React context, no state library; storage is optional (a private window still works).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AUTH_COPY, type AuthCopy, type AuthLang } from "./auth-copy";

const LANG_KEY = "reclamo.lang";

function storedLang(): AuthLang | undefined {
  try {
    const value = window.sessionStorage.getItem(LANG_KEY);
    return value === "es" || value === "en" ? value : undefined;
  } catch {
    return undefined;
  }
}

function storeLang(lang: AuthLang): void {
  try {
    window.sessionStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not remembered: the next screen falls back to its address or Spanish.
  }
}

/** `?lang=` of the address when it names a language, else the tab's choice, else Spanish. */
export function initialAuthLang(search: URLSearchParams = new URLSearchParams(window.location.search)): AuthLang {
  const asked = search.get("lang");
  if (asked === "en" || asked === "es") return asked;
  return storedLang() ?? "es";
}

/** `path` with `?lang=en` when the screens are in English (Spanish is the default and needs nothing). */
export function withLang(path: string, lang: AuthLang): string {
  if (lang === "es") return path;
  return `${path}${path.includes("?") ? "&" : "?"}lang=en`;
}

interface AuthLangValue {
  readonly lang: AuthLang;
  readonly copy: AuthCopy;
  setLang(lang: AuthLang): void;
}

const AuthLangContext = createContext<AuthLangValue | undefined>(undefined);

export function AuthLangProvider({ children }: { readonly children: ReactNode }) {
  const [lang, setCurrent] = useState<AuthLang>(() => initialAuthLang());

  useEffect(() => {
    storeLang(lang);
    const root = document.documentElement;
    const previous = { lang: root.lang, title: document.title };
    root.lang = AUTH_COPY[lang].meta.code;
    document.title = AUTH_COPY[lang].meta.title;
    return () => {
      root.lang = previous.lang;
      document.title = previous.title;
    };
  }, [lang]);

  const setLang = useCallback((next: AuthLang) => {
    setCurrent(next);
    const { pathname, search, hash } = window.location;
    const params = new URLSearchParams(search);
    if (next === "en") params.set("lang", "en");
    else params.delete("lang");
    const text = params.toString();
    window.history.replaceState(window.history.state, "", `${pathname}${text ? `?${text}` : ""}${hash}`);
  }, []);

  const value = useMemo<AuthLangValue>(() => ({ lang, copy: AUTH_COPY[lang], setLang }), [lang, setLang]);
  return <AuthLangContext.Provider value={value}>{children}</AuthLangContext.Provider>;
}

/** The screens' language and texts; outside a provider, the tab's choice (no switch). */
export function useAuthLang(): AuthLangValue {
  const value = useContext(AuthLangContext);
  if (value) return value;
  const lang = initialAuthLang();
  return { lang, copy: AUTH_COPY[lang], setLang: () => undefined };
}

/** The es/en switch: a short label named for assistive technology; 44 px tall. */
export function AuthLangSwitch() {
  const value = useContext(AuthLangContext);
  if (!value) return null;
  const next: AuthLang = value.lang === "es" ? "en" : "es";
  return (
    <button
      type="button"
      lang={next}
      aria-label={`${value.copy.lang.label}: ${value.copy.lang.switchTo}`}
      onClick={() => value.setLang(next)}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-mist bg-white px-2 text-xs font-semibold text-pine hover:bg-paper"
    >
      {value.copy.lang.short}
    </button>
  );
}
