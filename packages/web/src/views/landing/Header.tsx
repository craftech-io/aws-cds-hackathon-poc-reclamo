// The landing's sticky header (docs/landing-spec.md §5): "Saltar al contenido" as the first focus, the
// wordmark, the section links from 1024 px, "Hablemos" from 1280 px, the es/en switch from 768 px,
// "Ingresar" always and "Probar Reclamo en regla" from 1024 px. Below 1024 px a menu button opens the
// shared `Drawer` with the links, "Hablemos", the language and both calls to action; the focus stays
// inside it and goes back to the button when it closes. Past the top of the page the header shows a
// shadow (by opacity, nothing animates its size). Nothing in it overflows at 360 px, in either language.
import { useEffect, useRef, useState } from "react";
import { Drawer } from "../../components/Drawer";
import { ReclamoWordmark } from "../../components/brand/Brand";
import { CTA_CLASS, SignInLink, TalkLink, TryLink } from "./cta";
import { useFocusTrap } from "./focus-trap";
import { LangSwitch, useLandingCopy } from "./lang";

export const SECTION_LINKS = ["recorrido", "que-hace", "reglas", "impacto"] as const;

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function MenuContent({ onNavigate }: { readonly onNavigate: () => void }) {
  const { nav } = useLandingCopy();
  const anchor = useRef<HTMLDivElement>(null);
  useFocusTrap(anchor, true);
  return (
    <div ref={anchor} className="flex h-full flex-col gap-6">
      <nav aria-label={nav.label}>
        <ul className="flex flex-col">
          {SECTION_LINKS.map((id) => (
            <li key={id}>
              <a href={`#${id}`} onClick={onNavigate} className="flex min-h-11 items-center text-base font-semibold text-pine hover:text-seal-deep">
                {nav[id]}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-wrap items-center gap-3 border-t border-mist pt-4">
        <TalkLink placement="drawer" className={`${CTA_CLASS.link} text-pine`} />
        <LangSwitch full />
      </div>
      <div className="mt-auto flex flex-col gap-3 border-t border-mist pt-4">
        <SignInLink className={CTA_CLASS.secondaryLight} />
        <TryLink />
      </div>
    </div>
  );
}

export function Header() {
  const { nav } = useLandingCopy();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // The shadow appears once the top sentinel leaves the viewport: one observer, no scroll listener.
  useEffect(() => {
    const sentinel = document.getElementById("landing-top");
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!(entry?.isIntersecting ?? true)));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const close = () => {
    setOpen(false);
    menuButton.current?.focus();
  };

  // The drawer lives outside the header: a backdrop filter would make the header the box of its fixed layer.
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-mist bg-white/95 backdrop-blur">
        <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-seal focus:px-4 focus:text-white">
          {nav.skip}
        </a>
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 sm:gap-3 sm:px-8">
          <a href="#inicio" aria-label="Reclamo en regla" className="mr-auto inline-flex min-h-11 min-w-0 shrink items-center">
            <span className="sm:hidden">
              <ReclamoWordmark tone="light" size="sm" />
            </span>
            <span className="hidden sm:inline-flex">
              <ReclamoWordmark tone="light" size="md" />
            </span>
          </a>
          <nav aria-label={nav.label} className="hidden lg:block">
            <ul className="flex items-center">
              {SECTION_LINKS.map((id) => (
                <li key={id}>
                  <a href={`#${id}`} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-2 text-sm font-semibold text-slate hover:text-pine">
                    {nav[id]}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <span className="hidden xl:inline-flex">
            <TalkLink placement="header" className={`${CTA_CLASS.link} text-pine`} />
          </span>
          <span className="hidden md:inline-flex">
            <LangSwitch />
          </span>
          <SignInLink className={`${CTA_CLASS.link} text-pine`} />
          <span className="hidden lg:inline-flex">
            <TryLink />
          </span>
          <button
            ref={menuButton}
            type="button"
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-mist text-pine hover:bg-paper lg:hidden"
          >
            <MenuIcon />
            <span className="sr-only">{nav.menu}</span>
          </button>
        </div>
        <span aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-full h-3 bg-linear-to-b from-pine/10 to-transparent transition-opacity duration-200 ease-out ${scrolled ? "opacity-100" : "opacity-0"}`} />
      </header>
      <Drawer open={open} title={nav.menu} onClose={close} closeLabel={nav.close}>
        <MenuContent onNavigate={() => setOpen(false)} />
      </Drawer>
    </>
  );
}
