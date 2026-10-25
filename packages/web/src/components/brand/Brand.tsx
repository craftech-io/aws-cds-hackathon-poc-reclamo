// Brand of the product: the "Reclamo en regla" wordmark (serif text next to a stamped seal drawn in
// SVG, no logo file) and a discreet "Powered by Craftech" with Craftech's logos. Logo files live in
// public/brand/ (light backgrounds: color SVG; dark: white SVG); every mark falls back to text. No
// other brand appears anywhere: the lender of the demo is fictitious and has no logo (ADR-0010).
import { BrandImage } from "./BrandImage";

export type BrandTone = "light" | "dark";

export const BRAND_ASSETS = {
  craftech: { light: "/brand/logo-craftech-color.svg", dark: "/brand/logo-craftech-blanco.svg" },
} as const;

export const CRAFTECH_URL = "https://craftech.io";

type Size = "sm" | "md" | "lg" | "xl";

const WORDMARK_TEXT: Readonly<Record<Size, string>> = { sm: "text-sm", md: "text-base", lg: "text-xl", xl: "text-3xl" };
const SEAL_SIZE: Readonly<Record<Size, string>> = { sm: "h-4 w-4", md: "h-5 w-5", lg: "h-6 w-6", xl: "h-9 w-9" };

/** The stamped seal of the brand: a ring with a check, "on record". Decorative. */
export function RegisterSeal({ tone, size = "md" }: { readonly tone: BrandTone; readonly size?: Size }) {
  const ring = tone === "dark" ? "stroke-seal-soft" : "stroke-seal";
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${SEAL_SIZE[size]}`}>
      <circle cx="16" cy="16" r="13.5" fill="none" strokeWidth="2.5" className={ring} />
      <circle cx="16" cy="16" r="9.5" fill="none" strokeWidth="1" strokeDasharray="2 2" className={ring} />
      <path d="M10.5 16.5l3.6 3.6 7.4-8" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={ring} />
    </svg>
  );
}

/** The product: "Reclamo en regla", serif, with its seal. */
export function ReclamoWordmark({ tone, size = "md" }: { readonly tone: BrandTone; readonly size?: Size }) {
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap font-display ${WORDMARK_TEXT[size]} ${tone === "dark" ? "text-white" : "text-pine"}`}>
      <RegisterSeal tone={tone} size={size} />
      <span className="font-semibold tracking-tight">
        Reclamo <span className={`italic ${tone === "dark" ? "text-seal-soft" : "text-seal"}`}>en regla</span>
      </span>
    </span>
  );
}

/** "Powered by" + the Craftech logo, linking to craftech.io. */
export function PoweredByCraftech({ tone, className = "" }: { readonly tone: BrandTone; readonly className?: string }) {
  const fallback = <span className={`font-bold ${tone === "dark" ? "text-white" : "text-craftech"}`}>Craftech</span>;
  return (
    <a
      href={CRAFTECH_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 text-xs transition-opacity hover:opacity-80 ${tone === "dark" ? "text-mist" : "text-slate"} ${className}`}
    >
      <span>Powered by</span>
      <BrandImage src={BRAND_ASSETS.craftech[tone]} alt="Craftech" className="h-5 w-auto" fallback={fallback} />
    </a>
  );
}

/** "Reclamo en regla · Powered by Craftech", the public brand line. */
export function BrandLine({ tone, size = "md" }: { readonly tone: BrandTone; readonly size?: Size }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <ReclamoWordmark tone={tone} size={size} />
      <span aria-hidden="true" className={`h-5 w-px ${tone === "dark" ? "bg-pine-soft" : "bg-mist"}`} />
      <PoweredByCraftech tone={tone} />
    </span>
  );
}
