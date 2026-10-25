// The personas a scenario clones (docs/seed-spec.md §8) and what the cliente autopiloto knows about each:
// its script messages (packages/bff/src/copy/persona-scripts.ts, one source with the simulator and the
// classifier tests) and the truth of the identity challenge, read from the committed `models` template
// (scripts/seed/data/worlds/models.json) exactly as the core compares it (core-mock ledger/challenge.ts):
//
//   LAST_DUE_DATE           due date of the latest instalment already due at the world's simulated now
//   LAST_INSTALMENT_AMOUNT  amount of that instalment
//   LAST_MOVEMENT_AMOUNT    amount of the latest wallet movement at or before now
//
// A QA clone keeps its model's loans, instalments and movements (only ids, phone and email change), so
// the model's rows are the clone's truth. Nothing here reaches the stage.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PersonaScript, type ScriptMessage, personaScript } from "@reclamo/bff/copy/persona-scripts";

export type ChallengeKind = "LAST_DUE_DATE" | "LAST_INSTALMENT_AMOUNT" | "LAST_MOVEMENT_AMOUNT";

export interface PersonaTruth {
  readonly model: string;
  readonly instalments: ReadonlyArray<{ readonly loanId: string; readonly number: number; readonly dueDate: string; readonly amount: number }>;
  readonly movements: ReadonlyArray<{ readonly atSim: string; readonly amount: number }>;
}

interface ModelItem {
  readonly entity: string;
  readonly data: Record<string, unknown>;
}

const MODELS_PATH = fileURLToPath(new URL("../../seed/data/worlds/models.json", import.meta.url));
let models: Readonly<Record<string, { readonly items: readonly ModelItem[] }>> | undefined;

function modelItems(model: string): readonly ModelItem[] {
  models ??= (JSON.parse(readFileSync(MODELS_PATH, "utf8")) as { personas: Record<string, { items: ModelItem[] }> }).personas;
  const persona = models[model];
  if (persona === undefined) throw new RangeError(`the models template has no persona ${model}`);
  return persona.items;
}

/** The rows of a model persona the challenge reads. */
export function truthOf(model: string, items: readonly ModelItem[] = modelItems(model)): PersonaTruth {
  const instalments = items
    .filter((item) => item.entity === "Instalment")
    .map((item) => ({ loanId: String(item.data["loanId"]), number: Number(item.data["number"]), dueDate: String(item.data["dueDate"]), amount: Number(item.data["amount"]) }));
  const movements = items.filter((item) => item.entity === "Movement").map((item) => ({ atSim: String(item.data["atSim"]), amount: Number(item.data["amount"]) }));
  return { model, instalments, movements };
}

/** `2026-10-05` → `5/10` (the form the challenge prompt suggests). */
export function dayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day}/${month}`;
}

/** Centavos → `$ 118.640,00` (es-AR). */
export function pesos(cents: number): string {
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$ ${whole},${String(cents % 100).padStart(2, "0")}`;
}

/** The local date (UTC−3) of an instant: the core's `today`. */
export function localDateAr(instant: string): string {
  return new Date(Date.parse(instant) - 3 * 60 * 60_000).toISOString().slice(0, 10);
}

/** The right answer to a challenge of `kind` at the simulated instant `simNow`; `undefined` when none applies. */
export function challengeAnswer(truth: PersonaTruth, kind: ChallengeKind, simNow: string): string | undefined {
  if (kind === "LAST_MOVEMENT_AMOUNT") {
    const last = [...truth.movements].filter((movement) => Date.parse(movement.atSim) <= Date.parse(simNow)).sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim)).at(-1);
    return last === undefined ? undefined : pesos(last.amount);
  }
  const today = localDateAr(simNow);
  const due = truth.instalments.filter((instalment) => instalment.dueDate <= today).sort((a, b) => (a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0));
  const latest = due[0];
  if (latest === undefined) return undefined;
  return kind === "LAST_DUE_DATE" ? dayMonth(latest.dueDate) : pesos(latest.amount);
}

/** An answer that can never match (FL-004's two failures): a date nobody's instalment falls on. */
export function wrongAnswer(kind: ChallengeKind): string {
  return kind === "LAST_DUE_DATE" ? "31/2" : "$ 1,23";
}

export function scriptOf(model: string): PersonaScript {
  const script = personaScript(model as `C${string}`);
  if (script === undefined) throw new RangeError(`no script for persona ${model}`);
  return script;
}

/** Message `index` of a persona's script (0 is what the simulator preloads). */
export function scriptMessage(model: string, index = 0): ScriptMessage {
  const message = scriptOf(model).messages[index];
  if (message === undefined) throw new RangeError(`${model} has no script message ${index}`);
  return message;
}

/** The receipt of a script message as `wa.inbound` sends it (a seed image of `Seed/receipts/`). */
export function scriptReceipt(model: string, index = 0): { readonly type: "receipt"; readonly variant: string; readonly personaModel: string; readonly seq: number } | undefined {
  const attachment = scriptMessage(model, index).attachment;
  if (attachment?.kind !== "RECEIPT_IMAGE") return undefined;
  return { type: "receipt", variant: attachment.variant, personaModel: model, seq: attachment.seq };
}
