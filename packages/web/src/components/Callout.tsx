// A short message inside a view: the outcome of an action ("Plan aprobado"), a rule the view
// applies ("Canales desactivados") or a warning before a decision. Failures of a BFF call use
// ApiErrorNotice instead, which knows the refusal reasons.
import type { ReactNode } from "react";

export type CalloutTone = "info" | "success" | "warning" | "danger" | "neutral";

const TONES: Readonly<Record<CalloutTone, string>> = {
  info: "border-info bg-info-soft text-info",
  success: "border-success bg-success-soft text-success",
  warning: "border-warning bg-warning-soft text-warning",
  danger: "border-danger bg-danger-soft text-danger",
  neutral: "border-mist bg-paper text-slate",
};

interface CalloutProps {
  readonly tone?: CalloutTone;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}

export function Callout({ tone = "info", title, children, action }: CalloutProps) {
  const urgent = tone === "danger" || tone === "warning";
  return (
    <div role={urgent ? "alert" : "status"} className={`rounded-card border px-4 py-3 text-sm ${TONES[tone]}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={`${title ? "mt-1" : ""} text-ink`}>{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
