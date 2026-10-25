// The "seeded history (not measured)" box of a template (docs/seed-spec.md §14, invariant 17): what the
// console shows about the presentations the template brings, computed from its `Complaint` items.
// Everything seeded is `origin SEED`, so the measured KPIs of a fresh world have N = 0.
import type { WorldTemplateFile } from "./template";

export interface SeededHistoryBox {
  readonly total: number;
  readonly byStatus: Record<string, number>;
  readonly byType: Record<string, number>;
  readonly answered: number;
  readonly answeredOnTime: number;
  readonly withDeliveryProof: number;
  readonly measuredN: number;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export function seededHistoryBox(template: Pick<WorldTemplateFile, "items">): SeededHistoryBox {
  const complaints = template.items.filter((item) => item.entity === "Complaint").map((item) => item.data);
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let answered = 0;
  let answeredOnTime = 0;
  let withDeliveryProof = 0;
  for (const complaint of complaints) {
    bump(byStatus, String(complaint.status));
    bump(byType, String(complaint.type));
    const answer = complaint.answer as { sentAtSim?: string; deliveryProof?: string } | undefined;
    if (answer?.sentAtSim) {
      answered += 1;
      if (Date.parse(answer.sentAtSim) <= Date.parse(String(complaint.deadlineSim))) answeredOnTime += 1;
      if (answer.deliveryProof === "DELIVERED") withDeliveryProof += 1;
    }
  }
  const live = complaints.filter((complaint) => complaint.origin !== "SEED").length;
  const metrics = template.items.filter((item) => item.entity === "ComplaintKpi").length;
  return { total: complaints.length, byStatus, byType, answered, answeredOnTime, withDeliveryProof, measuredN: live + metrics };
}
