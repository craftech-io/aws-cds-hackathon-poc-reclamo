// A real capture of the landing, from the manifest: AVIF/WebP with `srcset` (Picture.tsx), lazy-loaded,
// sized up front (no layout shift), with its alternative text in the page's language and a button that
// opens it in the zoom viewer, with a visible "Ampliar" chip. Renders and placeholders never reach this component: a render is its own
// React visual and a placeholder is never shown.
import type { CSSProperties } from "react";
import { useGallery } from "./gallery";
import { useLandingCopy } from "./lang";
import type { GalleryItem } from "./media";
import { Picture } from "./Picture";

interface MediaFigureProps {
  readonly item: GalleryItem;
  /** The rendered width, as `<img sizes>` takes it. */
  readonly sizes: string;
  readonly caption?: string;
  readonly className?: string;
  /** Above the fold: load at once instead of lazily. */
  readonly eager?: boolean;
}

/** The visible "Ampliar" affordance: always shown (touch screens have no hover), never read twice. */
function ZoomChip({ label }: { readonly label: string }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full border border-mist bg-white/95 px-2.5 py-1 text-xs font-medium text-pine shadow-card transition-colors group-hover:bg-pine group-hover:text-white group-focus-visible:bg-pine group-focus-visible:text-white">
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14M7 5v4M5 7h4" />
      </svg>
      {label}
    </span>
  );
}

export function MediaFigure({ item, sizes, caption, className = "", eager = false }: MediaFigureProps) {
  const copy = useLandingCopy();
  const gallery = useGallery();
  // A phone-sized capture is drawn at a phone's width on narrow screens, not stretched to the column; a
  // cropped capture (the phone of the tour's first steps) is never drawn wider than its own 1x width.
  const frame = item.mobile ? " max-lg:mx-auto max-lg:max-w-xs" : "";
  const natural = { "--natural-width": `${Math.round(item.desktop.width / 2)}px` } as CSSProperties;
  const image = <Picture desktop={item.desktop} mobile={item.mobile} alt={item.alt} sizes={sizes} eager={eager} imgClassName="block h-auto w-full transition-opacity duration-150 ease-out group-hover:opacity-95" />;
  return (
    <figure data-media={item.id} className={className}>
      <div style={natural} className={`relative mx-auto max-w-(--natural-width) overflow-hidden rounded-card border border-mist bg-white shadow-card${frame}`}>
        {gallery ? (
          <button type="button" onClick={() => gallery.open(item.id)} aria-label={`${copy.zoom.open}: ${item.alt}`} className="group relative block w-full cursor-zoom-in">
            {image}
            <ZoomChip label={copy.zoom.chip} />
          </button>
        ) : (
          image
        )}
      </div>
      {caption ? <figcaption className="mt-2 text-center text-xs text-slate">{caption}</figcaption> : null}
    </figure>
  );
}
