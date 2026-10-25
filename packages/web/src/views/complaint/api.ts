// Reads of the case (docs/tool-catalog.md "Procedimientos de la consola"): the complaint with its
// evidence, actions, approvals and notes (`complaints.get`), its timeline (`complaints.timeline`) and,
// for the roles that work the case, the customer's file (`customers.get`: name, the 24-hour window
// and the control of the conversation). Read together, so the view shows one moment of the world.
import type { ConsoleClient } from "../../lib/trpc";
import type { RouterOutputs } from "../../lib/trpc-router";

export type CaseView = RouterOutputs["complaints"]["get"];
export type CaseTimeline = RouterOutputs["complaints"]["timeline"];
export type TimelineItem = CaseTimeline["items"][number];
export type CustomerFile = RouterOutputs["customers"]["get"];

export interface CaseBundle {
  readonly view: CaseView;
  readonly timeline: CaseTimeline;
  /** Absent for a read-only role (COMPLIANCE never reads the core) or when the core did not answer. */
  readonly customer?: CustomerFile;
}

export interface CaseInput {
  readonly complaintId: string;
  readonly handsOn: boolean;
}

export async function fetchCase(trpc: ConsoleClient, input: CaseInput, signal: AbortSignal): Promise<CaseBundle> {
  const ref = { complaintId: input.complaintId };
  const [view, timeline] = await Promise.all([trpc.complaints.get.query(ref, { signal }), trpc.complaints.timeline.query(ref, { signal })]);
  if (!input.handsOn) return { view, timeline };
  // The case still opens when the core does not answer: only the composer needs the file.
  const customer = await trpc.customers.get.query({ customerId: view.complaint.customerId }, { signal }).catch(() => undefined);
  return customer === undefined ? { view, timeline } : { view, timeline, customer };
}
