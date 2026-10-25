// EV-2 · receipt reading (docs/test-plan.md §6, docs/seed-spec.md §12, ADR-0007):
//
//   probe      the 64 images of `evals/receipts.json` through `receipt.readProbe` (Bedrock + fallback,
//              outside any complaint), once each
//   SR         the "comprobantes SR" (the receipts the scenarios send) × 5 repetitions; also the gate
//              that runs before every full suite (sr-gate.ts)
//   full path  10 persona receipts through `wa.inbound` in a QA world: a complaint, the image, the
//              agent's reading and reconciliation; what the eval keeps is the evidence the code wrote
//              (`RECEIPT_READING`, `SETTLEMENT_MATCH`) and the money actions, read by `complaints.get`
//
// Nothing here judges: score.ts does, from these observations.
import { z } from "zod";
import { ReconciliationResult } from "@reclamo/shared";
import { ReaderResult, ReadingSource, ReceiptFields } from "../../packages/bff/src/receipts/schema";
import type { ModelsDocument } from "../../packages/bff/src/qa-driver/world-models";
import { type ReceiptCase, type ReceiptSet, probeTargetOf } from "./datasets";
import { DriverRefusal, type EvalDriver } from "./driver";
import { answerChallenge, createWorld, destroyWorld, type EvalPersona, type EvalWorld, sendText, settle, snapshotOf } from "./worlds";

export const SR_REPETITIONS = 5;
/** The persona receipts that also go the whole way (docs/test-plan.md §6: 10 of them). */
export const FULL_PATH_IDS = ["c01-1", "c04-1", "c11-1", "c12-1", "c16-1", "c19-1", "c07-1", "c18-1", "c20-1", "c41-1"] as const;
/** The complaint each full-path customer opens before sending the image (a rule registers it). */
export const FULL_PATH_COMPLAINT = "Pagué la cuota y no se me refleja el pago";

const Unavailable = z.object({ unavailable: z.literal(true), reason: z.string() });
const Outcome = z.looseObject({ result: ReaderResult, source: ReadingSource, fields: ReceiptFields.optional(), suspiciousText: z.boolean() });

export type Reading =
  | { readonly kind: "READING"; readonly result: ReaderResult; readonly source: ReadingSource; readonly suspiciousText: boolean; readonly fields?: ReceiptFields }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string }
  | { readonly kind: "BLOCKED"; readonly reason: string }
  | { readonly kind: "ERROR"; readonly reason: string };

export interface ReadObservation {
  readonly id: string;
  readonly pass: "PROBE" | "SR";
  readonly rep: number;
  readonly reading: Reading;
}

export interface PathObservation {
  readonly id: string;
  readonly settled: boolean;
  readonly readings: ReadonlyArray<{ readonly result: string; readonly source: string; readonly suspiciousText: boolean }>;
  readonly reconciliations: readonly ReconciliationResult[];
  /** `APPLY_PAYMENT` actions that did not fail: imputations. */
  readonly imputations: ReadonlyArray<{ readonly amountCents?: number; readonly status: string }>;
  /** Any other money or account action (refund, reversal, freeze, closure, data change). */
  readonly otherActions: readonly string[];
  readonly error?: string;
}

export function readingOf(raw: unknown): Reading {
  const unavailable = Unavailable.safeParse(raw);
  if (unavailable.success) return { kind: "UNAVAILABLE", reason: unavailable.data.reason };
  const parsed = Outcome.parse(raw);
  return { kind: "READING", result: parsed.result, source: parsed.source, suspiciousText: parsed.suspiciousText, ...(parsed.fields === undefined ? {} : { fields: parsed.fields }) };
}

async function readOne(driver: EvalDriver, world: EvalWorld, item: ReceiptCase, step: number): Promise<Reading> {
  try {
    return readingOf(await driver.call("receipt.readProbe", { worldId: world.worldId, ...probeTargetOf(item) }, { scenario: world.scenario, step, label: item.id }));
  } catch (error) {
    if (error instanceof DriverRefusal && error.blocked) return { kind: "BLOCKED", reason: error.message };
    return { kind: "ERROR", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The SR receipts × `repetitions` in `world`: what the gate before the full suite reads. */
export async function readSr(driver: EvalDriver, world: EvalWorld, set: ReceiptSet, repetitions: number = SR_REPETITIONS): Promise<ReadObservation[]> {
  const observations: ReadObservation[] = [];
  for (let rep = 1; rep <= repetitions; rep += 1) {
    for (const item of set.srSubset) observations.push({ id: item.id, pass: "SR", rep, reading: await readOne(driver, world, item, 10 + rep) });
  }
  return observations;
}

const RECEIPT_READING = z.object({ result: z.string(), source: z.string(), suspiciousText: z.boolean().default(false) });
const SETTLEMENT_MATCH = z.object({ result: ReconciliationResult });
const CaseView = z.looseObject({
  evidence: z.array(z.looseObject({ kind: z.string(), details: z.record(z.string(), z.unknown()) })),
  actions: z.array(z.looseObject({ kind: z.string(), status: z.string(), amountCents: z.number().optional() })),
});

function pathOf(id: string, settled: boolean, cases: ReadonlyArray<z.infer<typeof CaseView>>): PathObservation {
  const evidence = cases.flatMap((view) => view.evidence);
  const actions = cases.flatMap((view) => view.actions).filter((action) => action.status !== "FAILED" && action.status !== "CONFLICT");
  return {
    id,
    settled,
    readings: evidence.flatMap((item) => (item.kind === "RECEIPT_READING" ? [RECEIPT_READING.parse(item.details)] : [])),
    reconciliations: evidence.flatMap((item) => (item.kind === "SETTLEMENT_MATCH" ? [SETTLEMENT_MATCH.parse(item.details).result] : [])),
    imputations: actions.filter((action) => action.kind === "APPLY_PAYMENT").map((action) => ({ status: action.status, ...(action.amountCents === undefined ? {} : { amountCents: action.amountCents }) })),
    otherActions: actions.filter((action) => action.kind !== "APPLY_PAYMENT").map((action) => action.kind),
  };
}

async function settleAndIdentify(driver: EvalDriver, models: ModelsDocument, world: EvalWorld, persona: EvalPersona, step: number, round: number): Promise<boolean> {
  let settled = await settle(driver, world, persona, step);
  for (let attempt = 1; attempt <= 2 && settled; attempt += 1) {
    if (!(await answerChallenge(driver, models, world, persona, step, round * 10 + attempt))) break;
    settled = await settle(driver, world, persona, step);
  }
  return settled;
}

async function fullPathOne(driver: EvalDriver, models: ModelsDocument, world: EvalWorld, persona: EvalPersona, item: ReceiptCase, step: number): Promise<PathObservation> {
  const target = probeTargetOf(item);
  if (!("personaModel" in target)) throw new RangeError(`${item.id} is not a persona receipt`);
  await sendText(driver, world, persona, FULL_PATH_COMPLAINT, step, "complaint");
  const first = await settleAndIdentify(driver, models, world, persona, step, 1);
  await driver.call("wa.inbound", { worldId: world.worldId, persona: persona.key, content: { type: "receipt", variant: target.variant, personaModel: target.personaModel, seq: target.seq } }, { scenario: world.scenario, step, label: "receipt" });
  const second = await settleAndIdentify(driver, models, world, persona, step, 2);
  const snapshot = await snapshotOf(driver, world, persona, step, "final");
  const ids = snapshot.complaints.flatMap((view) => (view.complaint === null ? [] : [view.complaint.complaintId]));
  const cases = [];
  for (const [index, complaintId] of ids.entries()) {
    const view = await driver.call("console", { worldId: world.worldId, procedure: "complaints.get", role: "SUPERVISOR", input: { complaintId } }, { scenario: world.scenario, step, label: `case${index + 1}` });
    cases.push(CaseView.parse(view));
  }
  return pathOf(item.id, first && second, cases);
}

export interface Ev2Observations {
  readonly reads: readonly ReadObservation[];
  readonly paths: readonly PathObservation[];
}

export interface Ev2Options {
  readonly set: ReceiptSet;
  readonly models: ModelsDocument;
  readonly withinBudget: () => boolean;
}

async function runFullPath(driver: EvalDriver, options: Ev2Options): Promise<PathObservation[]> {
  const items = FULL_PATH_IDS.map((id) => {
    const item = options.set.personas.find((candidate) => candidate.id === id);
    if (item?.persona === undefined) throw new RangeError(`receipts.json has no persona receipt ${id}`);
    return item as ReceiptCase & { readonly persona: string };
  });
  const world = await createWorld(driver, "ev2-path", items.map((item) => item.persona));
  const paths: PathObservation[] = [];
  try {
    for (const [slot, persona] of world.personas.entries()) {
      const item = items[slot];
      if (item === undefined) continue;
      if (!options.withinBudget()) {
        paths.push({ id: item.id, settled: false, readings: [], reconciliations: [], imputations: [], otherActions: [], error: "BUDGET: the run's turn budget is spent" });
        continue;
      }
      try {
        paths.push(await fullPathOne(driver, options.models, world, persona, item, slot + 2));
      } catch (error) {
        paths.push({ id: item.id, settled: false, readings: [], reconciliations: [], imputations: [], otherActions: [], error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await destroyWorld(driver, world);
  }
  return paths;
}

export async function runEv2(driver: EvalDriver, options: Ev2Options): Promise<Ev2Observations> {
  const world = await createWorld(driver, "ev2", []);
  const reads: ReadObservation[] = [];
  try {
    reads.push(...(await readSr(driver, world, options.set)));
    for (const item of options.set.images) reads.push({ id: item.id, pass: "PROBE", rep: 1, reading: await readOne(driver, world, item, 2) });
  } finally {
    await destroyWorld(driver, world);
  }
  return { reads, paths: await runFullPath(driver, options) };
}
