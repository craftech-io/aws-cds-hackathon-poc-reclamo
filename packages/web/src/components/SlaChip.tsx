// The regulatory clock of a complaint: its SLA state and the business days left to the written
// answer (10 business days, docs/architecture.md §8.4), in brass while on time.
import type { SlaState } from "@reclamo/shared";
import { Badge, type BadgeTone } from "./Badge";

const TONE: Readonly<Record<SlaState, BadgeTone>> = { ON_TIME: "success", AT_RISK: "warning", OVERDUE: "danger" };

export const SLA_LABEL: Readonly<Record<SlaState, string>> = { ON_TIME: "En plazo", AT_RISK: "En riesgo", OVERDUE: "Vencido" };

export function SlaChip({ state, businessDaysLeft }: { readonly state: SlaState; readonly businessDaysLeft?: number }) {
  const left = businessDaysLeft === undefined ? "" : ` · ${businessDaysLeft} ${businessDaysLeft === 1 ? "día hábil" : "días hábiles"}`;
  return (
    <Badge tone={TONE[state]}>
      {SLA_LABEL[state]}
      {left}
    </Badge>
  );
}
