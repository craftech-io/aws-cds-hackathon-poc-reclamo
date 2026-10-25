import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-mist text-slate",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  brand: "bg-seal-soft text-seal-deep",
};

export function Badge({ tone = "neutral", children }: { readonly tone?: BadgeTone; readonly children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}
