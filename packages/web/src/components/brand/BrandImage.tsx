// A brand image that never breaks the page: while the file is missing (or the SPA fallback answers
// with HTML instead of an image) it renders the fallback, a text wordmark. A failure is remembered
// per URL so a second render does not flash a broken image.
import { useState, type ReactNode } from "react";

const failed = new Set<string>();

interface BrandImageProps {
  readonly src: string;
  readonly alt: string;
  readonly className: string;
  readonly fallback: ReactNode;
}

export function BrandImage({ src, alt, className, fallback }: BrandImageProps) {
  const [broken, setBroken] = useState(() => failed.has(src));
  if (broken) return <>{fallback}</>;
  const markBroken = () => {
    failed.add(src);
    setBroken(true);
  };
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      decoding="async"
      onError={markBroken}
      onLoad={(event) => {
        if (event.currentTarget.naturalWidth === 0) markBroken();
      }}
    />
  );
}
