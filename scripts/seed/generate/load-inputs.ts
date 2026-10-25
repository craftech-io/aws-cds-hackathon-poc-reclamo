// Inputs of the simulated load and of the real batch (docs/seed-spec.md §13): presentations to run,
// never results. `simulated-complaints.jsonl` has 300 presentations from 01/07 to 30/09/2026
// (business days) with the assumed type distribution; `batch-inputs.jsonl` has 30, three per
// complaint type, for `batch.run` on the stage. Each one names the model persona it clones and
// carries that persona's script message (copy/persona-scripts.ts).
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import type { ComplaintType } from "@reclamo/shared";
import { businessDaysAfter, isBusiness, localInstant } from "./calendar";
import { TYPE_DISTRIBUTION, apportion } from "./history-plan";
import type { Rng } from "./rng";

/** Model personas of each type, in rotation. */
const MODELS: Readonly<Record<ComplaintType, readonly string[]>> = {
  PAYMENT_NOT_REFLECTED: ["C01", "C04", "C11", "C12", "C13", "C14", "C15", "C16", "C17", "C18", "C19", "C41"],
  PAYOFF_CERTIFICATE: ["C05", "C21", "C39"],
  UNRECOGNIZED_CHARGE: ["C02", "C22", "C23", "C24", "C38"],
  DUPLICATE_DEBIT: ["C03", "C25", "C26"],
  TRANSFER_NOT_CREDITED: ["C27", "C28", "C29", "C30", "C31"],
  DISBURSEMENT_NOT_RECEIVED: ["C32", "C33", "C34"],
  UNKNOWN_OPERATION: ["C06"],
  ACCOUNT_BLOCKED: ["C35"],
  CLOSURE_OR_EARLY_PAYOFF: ["C36"],
  DATA_CHANGE: ["C37"],
  INFORMATION_REQUEST: ["C08"],
};

export interface LoadInput {
  readonly id: string;
  readonly filedAtSim: string;
  readonly modelPersona: string;
  readonly kind: "RECLAMO" | "CONSULTA";
  readonly type: ComplaintType;
  readonly message: string;
  readonly receiptVariant?: string;
  readonly params: { readonly networkDelayBusinessDays: number; readonly amountScale: number };
}

function scriptFor(personaId: string, type: ComplaintType): { text: string; receiptVariant?: string } {
  const script = PERSONA_SCRIPTS.find((candidate) => candidate.id === personaId);
  const message =
    script?.messages.find((candidate) => candidate.intake.kind === "RECLAMO" && candidate.intake.type === type) ??
    (type === "INFORMATION_REQUEST" ? script?.messages.at(-1) : undefined);
  if (!message) throw new Error(`persona ${personaId} has no script message of type ${type}`);
  return { text: message.text, ...(message.attachment?.kind === "RECEIPT_IMAGE" ? { receiptVariant: message.attachment.variant } : {}) };
}

function input(id: string, filedAtSim: string, type: ComplaintType, index: number, rng: Rng): LoadInput {
  const models = MODELS[type];
  const modelPersona = models[index % models.length] ?? "C01";
  const script = scriptFor(modelPersona, type);
  return {
    id,
    filedAtSim,
    modelPersona,
    kind: type === "INFORMATION_REQUEST" ? "CONSULTA" : "RECLAMO",
    type,
    message: script.text,
    ...(script.receiptVariant ? { receiptVariant: script.receiptVariant } : {}),
    params: { networkDelayBusinessDays: rng.int(0, 2), amountScale: rng.int(80, 120) / 100 },
  };
}

function businessDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let cursor = isBusiness(from) ? from : businessDaysAfter(from, 1); cursor <= to; cursor = businessDaysAfter(cursor, 1)) out.push(cursor);
  return out;
}

export function simulatedComplaints(rng: Rng): LoadInput[] {
  const counts = apportion(300);
  const days = businessDays("2026-07-01", "2026-09-30");
  const types = rng.shuffle(TYPE_DISTRIBUTION.flatMap(([type]) => Array.from({ length: counts.get(type) ?? 0 }, () => type)));
  const seen = new Map<ComplaintType, number>();
  return types
    .map((type, index) => {
      const nth = seen.get(type) ?? 0;
      seen.set(type, nth + 1);
      const hour = String(rng.int(9, 18)).padStart(2, "0");
      const minute = String(rng.int(0, 59)).padStart(2, "0");
      return input(`sim-${String(index + 1).padStart(3, "0")}`, localInstant(days[Math.floor((index * days.length) / types.length)] ?? "2026-07-01", `${hour}:${minute}`), type, nth, rng);
    })
    .sort((a, b) => Date.parse(a.filedAtSim) - Date.parse(b.filedAtSim) || (a.id < b.id ? -1 : 1));
}

/** Three presentations of each of the ten complaint types (a consulta is not a complaint type). */
export function batchInputs(rng: Rng): LoadInput[] {
  const types = TYPE_DISTRIBUTION.map(([type]) => type).filter((type) => type !== "INFORMATION_REQUEST");
  return types.flatMap((type, typeIndex) => [0, 1, 2].map((nth) => input(`batch-${String(typeIndex * 3 + nth + 1).padStart(2, "0")}`, localInstant("2026-10-07", "10:10"), type, nth, rng)));
}
