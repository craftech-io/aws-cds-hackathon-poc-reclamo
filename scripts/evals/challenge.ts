// The customer's side of the identity challenge in an eval world (docs/design-brief.md §5): the answer a
// cloned model persona knows, read from the same `models` template the world was cloned from, and the
// personas an eval may clone. Pure: the template and the world's local date in, text out.
//
//   LAST_DUE_DATE         the due date of the last instalment already due ("10/09/2026")
//   LAST_MOVEMENT_AMOUNT  the amount of the last wallet operation, customers without a due instalment
//
// The core picks LAST_DUE_DATE whenever an instalment is due (agent-tools/identity/challenge.ts) and
// never asks LAST_INSTALMENT_AMOUNT before it, so these two answers cover every model persona.
import { ComplaintStatus } from "@reclamo/shared";
import { INBOX_CLOSED_STATUSES } from "../../packages/bff/src/domain/complaint";
import type { ModelsDocument } from "../../packages/bff/src/qa-driver/world-models";

/** Models an eval never clones: an open complaint (a new message would be its follow-up), a frozen or
 * fraud-flagged account, a customer without WhatsApp opt-in, the persona of the agent's limits. */
export const EXCLUDED_MODELS: ReadonlySet<string> = new Set(["C06", "C17", "C35", "C38", "C40"]);

type ModelItems = ModelsDocument["personas"][string]["items"];

function datesOf(items: ModelItems, entity: string, field: string): Array<{ readonly at: string; readonly data: Record<string, unknown> }> {
  return items.flatMap((item) => {
    const at = item.data[field];
    return item.entity === entity && typeof at === "string" ? [{ at, data: item.data }] : [];
  });
}

/** `YYYY-MM-DD` of the template's start in Argentina (the clock of a QA world starts paused there). */
export function worldToday(models: Pick<ModelsDocument, "startAtSim">): string {
  return models.startAtSim.slice(0, 10);
}

function pesos(cents: number): string {
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$ ${whole},${String(cents % 100).padStart(2, "0")}`;
}

/** What the persona answers to its challenge, or undefined when it can answer none (a person verifies it). */
export function challengeAnswer(models: ModelsDocument, model: string, today: string = worldToday(models)): string | undefined {
  const entry = models.personas[model];
  if (entry === undefined) throw new RangeError(`no model persona ${model}`);
  const due = datesOf(entry.items, "Instalment", "dueDate")
    .map((item) => item.at)
    .filter((date) => date <= today)
    .sort();
  const last = due[due.length - 1];
  if (last !== undefined) {
    const [year, month, day] = last.split("-");
    return `${day}/${month}/${year}`;
  }
  const movement = datesOf(entry.items, "Movement", "atSim")
    .filter((item) => item.at.slice(0, 10) <= today)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .pop();
  const amount = movement?.data.amount;
  return typeof amount === "number" ? pesos(amount) : undefined;
}

/** Model personas an eval may clone: no open complaint, outside EXCLUDED_MODELS, able to answer a challenge. */
export function eligibleModels(models: ModelsDocument): string[] {
  return Object.keys(models.personas)
    .filter((model) => !EXCLUDED_MODELS.has(model))
    .filter((model) => {
      const items = models.personas[model]?.items ?? [];
      return !items.some((item) => {
        const status = ComplaintStatus.safeParse(item.data.status);
        return item.entity === "Complaint" && status.success && !INBOX_CLOSED_STATUSES.has(status.data);
      });
    })
    .filter((model) => challengeAnswer(models, model) !== undefined)
    .sort();
}

/** Spreads `count` conversations over worlds of at most `perWorld` personas, each model once per world. */
export function spreadOverWorlds(models: readonly string[], count: number, perWorld: number): string[][] {
  const width = Math.min(perWorld, models.length);
  if (width === 0) throw new RangeError("no model persona to clone");
  const worlds: string[][] = [];
  for (let index = 0; index < count; index += 1) {
    const world = Math.floor(index / width);
    (worlds[world] ??= []).push(models[(index + world) % models.length] ?? "");
  }
  return worlds;
}
