// The landing's three calls to action (ADR-0021 §2) and what they need from the page around them:
// whether the visitor is already signed in, the address's parameters and the router's navigation,
// given once by LandingView (so the sections render without the session or the router, as the unit
// tests do). "Probar Reclamo en regla" is a full page load of `/signup`; "Ingresar" goes to `/login`
// (or the console, already signed in); "Hablemos" leaves for Craftech's contact form in a new tab.
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { CONSOLE_HOME } from "../../routes";
import { useLandingCopy, useLandingLang } from "./lang";
import { EXTERNAL_LINK, contactHref, loginHref, signupHref, type ContactPlacement } from "./links";

export interface LandingEnv {
  readonly signedIn: boolean;
  readonly search: URLSearchParams;
  /** The SPA's navigation; without it "Ingresar" is a plain link. */
  readonly navigate?: (to: string) => void;
}

const LandingEnvContext = createContext<LandingEnv>({ signedIn: false, search: new URLSearchParams() });

export function LandingEnvProvider({ value, children }: { readonly value: LandingEnv; readonly children: ReactNode }) {
  return <LandingEnvContext.Provider value={value}>{children}</LandingEnvContext.Provider>;
}

export function useLandingEnv(): LandingEnv {
  return useContext(LandingEnvContext);
}

const BASE = "inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 text-sm font-semibold transition-colors duration-150 ease-out";

export const CTA_CLASS = {
  primary: `${BASE} bg-seal text-white hover:bg-seal-deep`,
  secondaryDark: `${BASE} border border-white/40 text-white hover:bg-white/10`,
  secondaryLight: `${BASE} border border-mist bg-white text-pine hover:bg-paper`,
  link: "inline-flex min-h-11 items-center gap-1 whitespace-nowrap px-1 text-sm font-semibold underline-offset-4 hover:underline",
} as const;

/** "Probar Reclamo en regla": always `/signup` by a full page load, with the visit's campaign parameters. */
export function TryLink({ className = CTA_CLASS.primary, arrow = false }: { readonly className?: string; readonly arrow?: boolean }) {
  const { cta } = useLandingCopy();
  const { search } = useLandingEnv();
  const lang = useLandingLang()?.lang ?? "es";
  return (
    <a href={signupHref(search, lang)} data-cta="try" className={className}>
      {cta.try}
      {arrow ? <span aria-hidden="true">→</span> : null}
    </a>
  );
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** "Ingresar" to `/login`, or "Ir a la consola" for a visitor already signed in. */
export function SignInLink({ className = CTA_CLASS.link }: { readonly className?: string }) {
  const { cta } = useLandingCopy();
  const { signedIn, navigate } = useLandingEnv();
  const lang = useLandingLang()?.lang ?? "es";
  const to = signedIn ? CONSOLE_HOME : loginHref(lang);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigate || !isPlainLeftClick(event)) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} data-cta="sign-in" className={className}>
      {signedIn ? cta.toConsole : cta.signIn}
    </a>
  );
}

/** "Hablemos": Craftech's contact form with the UTM parameters of `placement`, in a new tab. */
export function TalkLink({ placement, className = CTA_CLASS.link }: { readonly placement: ContactPlacement; readonly className?: string }) {
  const { cta } = useLandingCopy();
  return (
    <a href={contactHref(placement)} {...EXTERNAL_LINK} data-cta="talk" data-placement={placement} className={className}>
      {cta.talk}
      <span aria-hidden="true">↗</span>
      <span className="sr-only">{cta.newTab}</span>
    </a>
  );
}
