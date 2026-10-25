// What the guided tour reads and runs (docs/tool-catalog.md, `tour.steps`, `tour.run`, `customers.get`),
// parsed with zod at the edge: a missing field degrades the panel to the expected values of steps.ts
// instead of breaking it. A persona's complaint ("Avanzar al próximo hito de este reclamo", "Responder
// por escrito") is the latest one of the customer in this world, read from its file.
import { IsoInstant } from "@reclamo/shared";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import { announceClockMoved } from "../../lib/clock-events";
import type { TourAction, TourPersona } from "./steps";

export const TourStepsAnswer = z.looseObject({
  worldId: z.string().min(1),
  simNow: IsoInstant,
  mode: z.enum(["PAUSED", "RUNNING"]),
  startAtSim: IsoInstant,
  pristine: z.looseObject({ ok: z.boolean(), clockAtStart: z.boolean(), mainStoryFiled: z.boolean() }),
  mainStory: z.looseObject({ complaintId: z.string().min(1), complaintNumber: z.string().min(1), status: z.string().min(1), deadlineSim: IsoInstant }).nullable(),
  nextEvents: z.array(z.looseObject({ kind: z.string().min(1), dueAtSim: IsoInstant, ownerKey: z.string().nullable() })),
});
export type TourStepsAnswer = z.infer<typeof TourStepsAnswer>;

/** The epoch of the world (a reset starts a new one, and with it a new tour). */
export const ClockEpoch = z.looseObject({ worldEpoch: z.number().int().nonnegative() });

const CustomerComplaints = z.looseObject({
  complaints: z.array(z.looseObject({ complaintId: z.string().min(1), complaintNumber: z.string().min(1), open: z.boolean() })),
});

export interface PersonaComplaint {
  readonly complaintId: string;
  readonly complaintNumber: string;
}

/** `Cnn` is customer `cus-00nn` (docs/seed-spec.md §5). */
export function customerIdOf(persona: TourPersona): string {
  return `cus-${persona.slice(1).padStart(4, "0")}`;
}

/** The persona's latest complaint in this world, open first: the one the guest just filed. */
export function latestComplaint(answer: unknown): PersonaComplaint | undefined {
  const parsed = CustomerComplaints.safeParse(answer);
  if (!parsed.success) return undefined;
  const byNumber = [...parsed.data.complaints].sort((a, b) => b.complaintNumber.localeCompare(a.complaintNumber));
  const chosen = byNumber.find((complaint) => complaint.open) ?? byNumber[0];
  return chosen === undefined ? undefined : { complaintId: chosen.complaintId, complaintNumber: chosen.complaintNumber };
}

export async function personaComplaint(trpc: ConsoleClient, persona: TourPersona): Promise<PersonaComplaint | undefined> {
  return latestComplaint(await trpc.customers.get.query({ customerId: customerIdOf(persona) }));
}

/** Thrown when a move needs a persona's complaint that the guest has not filed yet. */
export class MissingComplaintError extends Error {
  override readonly name = "MissingComplaintError";

  constructor(readonly persona: TourPersona) {
    super(`${persona} has no complaint yet`);
  }
}

/** Runs a `run` move through `tour.run` and announces it to the shell's clock bar. */
export async function runTourAction(trpc: ConsoleClient, action: TourAction): Promise<unknown> {
  try {
    return await tourAction(trpc, action);
  } finally {
    announceClockMoved();
  }
}

/** One `run` move, resolving a persona's complaint to its number first. */
async function tourAction(trpc: ConsoleClient, action: TourAction): Promise<unknown> {
  switch (action.kind) {
    case "advanceToNext": {
      if (action.persona === undefined) return trpc.tour.run.mutate({ action: { kind: "advanceToNext" } });
      const complaint = await personaComplaint(trpc, action.persona);
      if (complaint === undefined) throw new MissingComplaintError(action.persona);
      return trpc.tour.run.mutate({ action: { kind: "advanceToNext", complaintNumber: complaint.complaintNumber } });
    }
    case "tapButton":
      return trpc.tour.run.mutate({ action: { kind: "tapButton", persona: action.persona, action: action.action } });
    case "sendText":
      return trpc.tour.run.mutate({ action: { kind: "sendText", persona: action.persona, text: action.text } });
    case "sendScript":
      return trpc.tour.run.mutate({ action: { kind: "sendScript", persona: action.persona } });
    case "setRunning":
      return trpc.tour.run.mutate({ action: { kind: "setRunning" } });
    case "exportRegister":
      return trpc.tour.run.mutate({ action: { kind: "exportRegister" } });
  }
}
