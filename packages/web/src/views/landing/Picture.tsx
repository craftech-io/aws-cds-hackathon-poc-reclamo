// One picture of the manifest as the browser should fetch it (docs/landing-spec.md §8): AVIF, then WebP,
// each with its 1x and 2x widths in `srcset` and the `sizes` the layout gives it, then the PNG fallback;
// sized up front so nothing shifts, lazy and decoded off the main thread unless it is above the fold.
// With a phone-sized capture, narrow viewports (under 1024 px) get it instead of the desktop one.
import type { Picture as PictureData } from "./manifest";

/** Below this width a capture's phone-sized version is served (the layout's `lg` breakpoint). */
export const MOBILE_MEDIA = "(max-width: 1023px)";

function srcset(picture: PictureData, format: "avif" | "webp"): string {
  return picture[format].map((source) => `${source.src} ${source.w}w`).join(", ");
}

interface PictureProps {
  readonly desktop: PictureData;
  readonly mobile?: PictureData | undefined;
  readonly alt: string;
  /** The rendered width, as `<img sizes>` takes it. */
  readonly sizes: string;
  readonly eager?: boolean;
  readonly className?: string;
  readonly imgClassName?: string;
}

export function Picture({ desktop, mobile, alt, sizes, eager = false, className, imgClassName = "block h-auto w-full" }: PictureProps) {
  const sources = (picture: PictureData, media: string | undefined) =>
    (["avif", "webp"] as const).flatMap((format) =>
      picture[format].length === 0 ? [] : [<source key={`${media ?? "all"}-${format}`} type={`image/${format}`} srcSet={srcset(picture, format)} sizes={sizes} media={media} width={picture.width} height={picture.height} />],
    );
  return (
    <picture className={className}>
      {mobile ? sources(mobile, MOBILE_MEDIA) : null}
      {sources(desktop, undefined)}
      <img src={desktop.png} alt={alt} width={desktop.width} height={desktop.height} loading={eager ? "eager" : "lazy"} decoding="async" className={imgClassName} />
    </picture>
  );
}
