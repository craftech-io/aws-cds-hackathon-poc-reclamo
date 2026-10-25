// A titled block of a view, and the bar that jumps between the blocks of a long view (Operación,
// Gobierno). Every block stays rendered: the bar only scrolls, so what a block shows never depends
// on having clicked it first.
import type { ReactNode } from "react";

interface SectionProps {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function Section({ id, title, description, actions, children }: SectionProps) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-6 rounded-card border border-mist bg-white p-5 shadow-card">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-lg font-semibold text-pine">
            {title}
          </h2>
          {description ? <p className="mt-1 max-w-3xl text-sm text-slate">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export interface SectionLink {
  readonly id: string;
  readonly label: string;
}

export function SectionNav({ label, links }: { readonly label: string; readonly links: readonly SectionLink[] }) {
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <nav aria-label={label} className="sticky top-0 z-10 -mx-6 mb-6 border-b border-mist bg-paper/95 px-6 py-2 backdrop-blur">
      <ul className="flex flex-wrap gap-1">
        {links.map((link) => (
          <li key={link.id}>
            <button type="button" className="rounded-md px-3 py-1.5 text-sm font-medium text-pine hover:bg-mist" onClick={() => jump(link.id)}>
              {link.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
