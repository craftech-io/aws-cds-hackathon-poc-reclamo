// The heading of a landing section: eyebrow, one h2 and an optional lead, revealed on entering the
// viewport (docs/landing-spec.md §4). `tone` follows the section's background.
import type { CSSProperties, ReactNode } from "react";

interface SectionHeadingProps {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly tone?: "light" | "dark";
}

export function SectionHeading({ id, eyebrow, title, lead, tone = "light" }: SectionHeadingProps) {
  const dark = tone === "dark";
  return (
    <header data-reveal="" className="max-w-3xl">
      <p className={`text-sm font-semibold uppercase tracking-widest ${dark ? "text-seal-soft" : "text-seal-deep"}`}>{eyebrow}</p>
      <h2 id={id} className={`mt-3 text-3xl font-semibold leading-tight sm:text-4xl ${dark ? "text-white" : "text-pine"}`}>
        {title}
      </h2>
      {lead ? <div className={`mt-4 text-base sm:text-lg ${dark ? "text-mist" : "text-slate"}`}>{lead}</div> : null}
    </header>
  );
}

/** The stagger of a grid's cards: +80 ms per index, at most 320 ms (docs/landing-spec.md §4). */
export function revealDelay(index: number): CSSProperties {
  // A custom property: React's style type does not list it, the cast only names it.
  return { "--reveal-delay": `${Math.min(index, 4) * 80}ms` } as CSSProperties;
}
