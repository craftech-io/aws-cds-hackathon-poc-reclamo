// Frame of every access screen (docs/landing-spec.md §9): the brand panel on the left on desktop (on
// top on a phone), the white card with the flow on the right, the es/en switch, and the footer with
// "Powered by Craftech" and the legal pages. Inside an AuthLangProvider.
import type { ReactNode } from "react";
import { PoweredByCraftech, ReclamoWordmark } from "../../components/brand/Brand";
import { AuthLangSwitch, useAuthLang } from "./auth-lang";

function BrandPanel() {
  const { panel } = useAuthLang().copy;
  return (
    <section className="relative flex flex-col justify-between gap-10 overflow-hidden bg-pine px-6 py-8 text-white sm:px-10 lg:min-h-screen lg:py-12">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-pine-soft/60" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-seal/10" />
      <div className="relative">
        <a href="/" className="inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
          <ReclamoWordmark tone="dark" size="xl" />
        </a>
        <p className="mt-3 text-sm text-seal-soft">{panel.tagline}</p>
      </div>
      <div className="relative hidden max-w-md lg:block">
        <p className="text-4xl font-semibold leading-tight">{panel.title}</p>
        <p className="mt-4 text-base text-mist">{panel.lead}</p>
        <ul className="mt-6 space-y-2 text-sm text-seal-soft">
          {panel.points.map((point) => (
            <li key={point} className="flex items-center gap-2">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-seal" />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <div className="relative hidden lg:block">
        <PoweredByCraftech tone="dark" />
      </div>
    </section>
  );
}

interface AuthLayoutProps {
  readonly children: ReactNode;
  /** Shown under the card (e.g. what the guest will try while the world is prepared). */
  readonly below?: ReactNode;
}

export function AuthLayout({ children, below }: AuthLayoutProps) {
  const { copy } = useAuthLang();
  return (
    <div className="min-h-screen bg-paper lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <BrandPanel />
      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-3 flex justify-end">
            <AuthLangSwitch />
          </div>
          <div className="rounded-card bg-white p-6 shadow-card sm:p-8">{children}</div>
          {below}
          <footer className="mt-8 flex flex-col items-center gap-3 text-xs text-slate">
            <PoweredByCraftech tone="light" className="lg:hidden" />
            <nav aria-label={`${copy.legal.privacy} · ${copy.legal.terms}`} className="flex gap-4">
              <a className="inline-flex min-h-11 items-center hover:text-pine hover:underline" href="/legal/privacy.html">
                {copy.legal.privacy}
              </a>
              <a className="inline-flex min-h-11 items-center hover:text-pine hover:underline" href="/legal/terms.html">
                {copy.legal.terms}
              </a>
            </nav>
          </footer>
        </div>
      </main>
    </div>
  );
}
