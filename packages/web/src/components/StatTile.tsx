// One figure with its label: the label and the value are siblings separated by a space, so the
// figure is found from its label and stays a word of its own in the tile's text (the metrics checks
// read "fuera de política" and expect its 0 next to it).
import type { ReactNode } from "react";

export type StatTone = "neutral" | "success" | "warning" | "danger" | "brand";

const VALUE_TONES: Readonly<Record<StatTone, string>> = {
  neutral: "text-pine",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  brand: "text-seal-deep",
};

interface StatTileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: StatTone;
}

export function StatTile({ label, value, hint, tone = "neutral" }: StatTileProps) {
  return (
    <div className="rounded-md border border-mist bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</p>{" "}
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${VALUE_TONES[tone]}`}>{value}</p>{" "}
      {hint ? <p className="mt-1 text-xs text-slate">{hint}</p> : null}
    </div>
  );
}

export function StatGrid({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{children}</div>;
}
