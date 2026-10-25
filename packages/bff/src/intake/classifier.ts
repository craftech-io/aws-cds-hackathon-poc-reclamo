// `classify_intake` (docs/tool-catalog.md, docs/architecture-integrations.md §10, ADR-0015, ADR-0016):
// what a customer's message is, decided BEFORE any turn, so a complaint gets its number on the spot.
//
//   1. the deterministic rules of rules.ts (buttons, a person, small talk, the complaint patterns, an
//      open complaint, account questions); a rule's decision is final and never calls the model;
//   2. otherwise the small model (model.ts), behind the kill switch, the world's turn caps and the
//      pool's global cap (guard.ts); blocked, unavailable or with an answer outside its schema → `UNCLEAR`;
//   3. the decision that follows (accept.ts) is code: `RECLAMO` registers only by rule or with
//      `confidence ≥ 0.7` and a type; everything else opens a turn without a number (the agent can
//      register with `register_complaint`, FL-012).
import type { ComplaintType } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { Logger } from "../lib/log";
import { type ModelBlock, modelBlock } from "./guard";
import type { IntakeModel, ModelUnavailable } from "./model";
import { type RuleInput, applyRules } from "./rules";

/** A model's `RECLAMO` registers a number only at or above this confidence. */
export const RECLAMO_MIN_CONFIDENCE = 0.7;

export type IntakeKind = "CONSULTA" | "RECLAMO" | "OUT_OF_SCOPE" | "UNCLEAR" | "FOLLOW_UP" | "HUMAN";

export interface Classification {
  readonly kind: IntakeKind;
  readonly type?: ComplaintType;
  readonly confidence: number;
  readonly source: "RULE" | "MODEL" | "FALLBACK";
  /** The rule that decided (`RULE`). */
  readonly rule?: string;
  /** The complaint a follow-up, a button or a request for a person is about. */
  readonly complaintId?: string;
  /** A status question about an open complaint: its acknowledgement repeats the existing number (FL-013). */
  readonly repeatAck?: boolean;
  /** Why the model gave nothing (`FALLBACK`). */
  readonly fallback?: ModelBlock | ModelUnavailable | "INVALID_OUTPUT" | "NOT_LINKED" | "NO_TEXT";
  /** Real milliseconds the model call took (`MODEL`, and a `FALLBACK` after a call). */
  readonly modelMs?: number;
}

export interface ClassifierDeps {
  readonly data: Pick<Connector, "runtime" | "write" | "worlds">;
  /** Absent while the model is not linked (the rules still decide what they can). */
  readonly model?: IntakeModel;
  /** Real time: the world's and the pool's buckets. */
  readonly realNow: () => Date;
  readonly log: Logger;
}

export interface ClassifyInput extends RuleInput {
  readonly worldId: string;
  /** The world's epoch: a self-signup world's turn cap is per epoch. */
  readonly epoch: number;
}

const SKIP_METRICS: Readonly<Record<ModelBlock, string>> = { KILLED: "AgentKilled", TURN_CAP: "TurnCapHits", GLOBAL_CAP: "GlobalCapHits" };

function fallback(reason: NonNullable<Classification["fallback"]>): Classification {
  return { kind: "UNCLEAR", confidence: 0, source: "FALLBACK", fallback: reason };
}

/** Rules first, then the model if it may be called; never throws for the model's sake. */
export async function classifyIntake(deps: ClassifierDeps, input: ClassifyInput): Promise<Classification> {
  const ruled = applyRules(input);
  if (ruled !== undefined) {
    const { rule, kind } = ruled;
    return {
      kind,
      confidence: 1,
      source: "RULE",
      rule,
      ...("type" in ruled ? { type: ruled.type } : {}),
      ...("complaintId" in ruled && ruled.complaintId !== undefined ? { complaintId: ruled.complaintId } : {}),
      ...(ruled.kind === "FOLLOW_UP" ? { repeatAck: ruled.repeatAck } : {}),
    };
  }
  if (input.text.trim() === "") return fallback("NO_TEXT");
  if (deps.model === undefined) return fallback("NOT_LINKED");
  const blocked = await modelBlock(deps.data, { worldId: input.worldId, epoch: input.epoch }, deps.realNow());
  if (blocked !== undefined) {
    deps.log.info("intake.model_skipped", { reason: blocked, metric: SKIP_METRICS[blocked] });
    return fallback(blocked);
  }
  const calledAt = deps.realNow().getTime();
  const answer = await deps.model.classify(input.text);
  const modelMs = Math.max(0, deps.realNow().getTime() - calledAt);
  if (answer.kind === "INVALID_OUTPUT") return { ...fallback("INVALID_OUTPUT"), modelMs };
  if (answer.kind === "UNAVAILABLE") return { ...fallback(answer.reason), modelMs };
  const { kind, type, confidence } = answer.result;
  return { kind, confidence, source: "MODEL", modelMs, ...(type === undefined ? {} : { type }) };
}

/** The model's or a rule's `RECLAMO` that the code registers with a number now. */
export function registersNow(classification: Classification): classification is Classification & { readonly type: ComplaintType } {
  if (classification.kind !== "RECLAMO" || classification.type === undefined) return false;
  return classification.source === "RULE" || classification.confidence >= RECLAMO_MIN_CONFIDENCE;
}
