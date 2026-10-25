// The commercial close (#empezar, docs/landing-spec.md §2.10) with Craftech's credibility line, and
// the footer (§2.11): the brand line, the fictitious-lender note, the legal pages and "Hablemos".
import { BrandImage } from "../../components/brand/BrandImage";
import { BRAND_ASSETS, CRAFTECH_URL, PoweredByCraftech, ReclamoWordmark } from "../../components/brand/Brand";
import { CTA_CLASS, SignInLink, TalkLink, TryLink } from "./cta";
import { useLandingCopy, useLandingLang } from "./lang";
import { EXTERNAL_LINK } from "./links";

export function ClosingSection() {
  const { closing } = useLandingCopy();
  return (
    <section id="empezar" aria-labelledby="empezar-title" className="scroll-mt-20 bg-pine text-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <div data-reveal="" className="max-w-3xl">
          <h2 id="empezar-title" className="text-3xl font-semibold leading-tight sm:text-4xl">
            {closing.title}
          </h2>
          <p className="mt-4 text-base text-mist sm:text-lg">{closing.lead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <TryLink arrow />
            <SignInLink className={CTA_CLASS.secondaryDark} />
            <TalkLink placement="closing" className={`${CTA_CLASS.link} text-white`} />
          </div>
        </div>
        <p className="mt-12 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-pine-soft pt-6 text-sm text-mist">
          <a href={CRAFTECH_URL} {...EXTERNAL_LINK} className="inline-flex min-h-11 items-center">
            <BrandImage src={BRAND_ASSETS.craftech.dark} alt="Craftech" className="h-6 w-auto" fallback={<span className="font-bold text-white">Craftech</span>} />
          </a>
          <span>
            {closing.credibilityBefore}
            <strong className="font-semibold text-white">Craftech</strong>
            {closing.credibilityAfter}
          </span>
        </p>
      </div>
    </section>
  );
}

export function Footer() {
  const { footer } = useLandingCopy();
  // The legal pages carry both languages; the English page opens at the English text.
  const anchor = useLandingLang()?.lang === "en" ? "#en" : "";
  const link = "inline-flex min-h-11 min-w-11 items-center justify-center px-1 hover:text-pine hover:underline";
  return (
    <footer className="border-t border-mist bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-8 text-center text-xs text-slate sm:px-8">
        <ReclamoWordmark tone="light" size="md" />
        <p>{footer.brand}</p>
        <p>{footer.note}</p>
        <PoweredByCraftech tone="light" />
        <nav aria-label={`${footer.privacy} · ${footer.terms}`} className="flex flex-wrap items-center justify-center gap-x-4">
          <a className={link} href={`/legal/privacy.html${anchor}`}>
            {footer.privacy}
          </a>
          <a className={link} href={`/legal/terms.html${anchor}`}>
            {footer.terms}
          </a>
          <TalkLink placement="footer" className={`${link} gap-1`} />
        </nav>
      </div>
    </footer>
  );
}
