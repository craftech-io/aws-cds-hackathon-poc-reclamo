// The sections after the impact (docs/landing-spec.md §2.8, §2.9, §5, ADR-0021 §12-§13):
//   #video        the product video, only when the manifest names it: `preload="none"`, poster,
//                 controls, no autoplay; without it the section does not exist (no placeholder)
//   #integracion  the four blocks of how it plugs in and the public diagram (`npm run diagram:render`)
//   #simulado     what is real and what is simulated, with the gallery of real captures (#galeria)
//                 inside it, shown only from four captures on
import { useLandingCopy, useLandingLang } from "./lang";
import { MediaFigure } from "./MediaFigure";
import type { LandingManifest } from "./manifest";
import { architectureItem, galleryItems, type MediaState } from "./media";
import { SectionHeading, revealDelay } from "./SectionHeading";

export function VideoSection({ video }: { readonly video: NonNullable<LandingManifest["video"]> }) {
  const copy = useLandingCopy().video;
  return (
    <section id="video" aria-labelledby="video-title" className="scroll-mt-20 bg-pine-deep text-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="video-title" eyebrow={copy.eyebrow} title={copy.title} lead={copy.lead} tone="dark" />
        <div data-reveal="" className="mt-10">
          <video controls preload="none" playsInline poster={video.poster} className="aspect-video w-full rounded-card border border-pine-soft bg-pine shadow-card">
            <source src={video.src} type={video.type} />
            <a href={video.src} className="text-seal-soft underline">
              {copy.fallback}
            </a>
          </video>
        </div>
      </div>
    </section>
  );
}

export function IntegrationSection({ media }: { readonly media: MediaState }) {
  const { integration } = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  const diagram = architectureItem(media, lang);
  return (
    <section id="integracion" aria-labelledby="integracion-title" className="scroll-mt-20 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="integracion-title" eyebrow={integration.eyebrow} title={integration.title} lead={integration.lead} />
        <ul className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {integration.blocks.map((block, index) => (
            <li key={block.title} data-reveal="" style={revealDelay(index)} className="rounded-card border border-mist bg-paper p-5">
              <h3 className="text-base font-semibold text-pine">{block.title}</h3>
              <p className="mt-2 text-sm text-slate">{block.text}</p>
            </li>
          ))}
        </ul>
        {diagram ? <MediaFigure className="mt-10" caption={integration.diagramCaption} item={diagram} sizes="(min-width: 1152px) 1088px, calc(100vw - 2rem)" /> : null}
      </div>
    </section>
  );
}

export function SimulatedSection({ media }: { readonly media: MediaState }) {
  const { simulated } = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  const gallery = galleryItems(media, lang);
  const columns = Object.entries(simulated.columns);
  return (
    <section id="simulado" aria-labelledby="simulado-title" className="scroll-mt-20 bg-pine-mist">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <h2 id="simulado-title" data-reveal="" className="max-w-3xl text-3xl font-semibold leading-tight text-pine sm:text-4xl">
          {simulated.title}
        </h2>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {columns.map(([key, column], index) => (
            <div key={key} data-reveal="" style={revealDelay(index)} className="rounded-card border border-mist bg-white p-5 shadow-card">
              <h3 className="text-sm font-semibold text-pine">{column.title}</h3>
              <p className="mt-2 text-sm text-slate">{column.text}</p>
            </div>
          ))}
        </div>
        {gallery.length > 0 ? (
          <div id="galeria" className="mt-12 scroll-mt-24">
            <h3 className="font-display text-xl font-semibold text-pine">{simulated.gallery}</h3>
            <ul className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {gallery.map((item) => (
                <li key={item.id}>
                  <MediaFigure item={{ id: item.id, desktop: item.desktop, alt: item.alt }} sizes="(min-width: 1024px) 260px, (min-width: 768px) 33vw, 50vw" />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
