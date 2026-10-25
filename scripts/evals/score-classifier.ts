// EV-3's thresholds (docs/seed-spec.md §12, ADR-0016) over its observations. Pure.
//
//   recall        a RECLAMO message registered a complaint                              ≥ 95 %
//   type          a registered RECLAMO has the expected type                            ≥ 90 %
//   out-of-scope  an OUT_OF_SCOPE message registered a complaint                        = 0
//   model-p95     latency of the model path (Haiku), messages the rules did not decide  < 3000 ms
//   intake-only   no agent turn ran in the intakeOnly worlds (precondition: BLOCKED otherwise)
import type { ClassifierSet } from "./datasets";
import type { ClassifierObservation } from "./ev3-classifier";
import { type EvalResult, type Gate, countGate, overall, percentile, ratioGate } from "./gates";

export const RECALL_MIN = 0.95;
export const TYPE_MIN = 0.9;
export const MODEL_P95_MAX_MS = 3_000;

function notRunReason(observation: ClassifierObservation): string | undefined {
  return observation.error === undefined ? undefined : `${observation.id}: ${observation.error}`;
}

function latencyGate(observations: readonly ClassifierObservation[]): Gate {
  const ran = observations.filter((observation) => observation.error === undefined);
  const blocked = ran.flatMap((observation) => (observation.classified.kind === "BLOCKED" ? [`${observation.id}: ${observation.classified.reason}`] : []));
  const samples = ran.flatMap((observation) => (observation.classified.kind === "READ" && observation.classified.source === "MODEL" && observation.classified.modelMs !== undefined ? [observation.classified.modelMs] : []));
  const p95 = percentile(samples, 95);
  const base = { id: "model-p95", label: "p95 of the model path (Haiku)", threshold: `< ${MODEL_P95_MAX_MS} ms`, n: samples.length };
  if (p95 === undefined) {
    return { ...base, measured: "—", verdict: "BLOCKED", notes: [blocked[0] ?? "no message took the model path, or its latency is not recorded"] };
  }
  const notRun = observations.length - ran.length;
  const verdict = p95 >= MODEL_P95_MAX_MS ? "FAIL" : blocked.length > 0 || notRun > 0 ? "BLOCKED" : "PASS";
  return { ...base, measured: `${Math.round(p95)} ms over ${samples.length}`, verdict, notes: verdict === "BLOCKED" ? [`${blocked.length + notRun} message(s) without a classification read`] : [] };
}

export function scoreClassifier(set: ClassifierSet, observations: readonly ClassifierObservation[]): EvalResult {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const recall = { passed: [] as string[], failed: [] as string[], blocked: [] as string[] };
  const type = { passed: [] as string[], failed: [] as string[], blocked: [] as string[] };
  const outOfScope: string[] = [];
  const outOfScopeBlocked: string[] = [];
  let outOfScopeN = 0;
  for (const entry of set.entries) {
    const observation = byId.get(entry.id);
    const reason = observation === undefined ? `${entry.id}: not run` : notRunReason(observation);
    if (entry.expected.kind === "RECLAMO") {
      if (observation === undefined || reason !== undefined) {
        recall.blocked.push(reason ?? entry.id);
        type.blocked.push(reason ?? entry.id);
        continue;
      }
      (observation.registered ? recall.passed : recall.failed).push(entry.id);
      if (observation.registered) (observation.registeredType === entry.expected.type ? type.passed : type.failed).push(`${entry.id}${observation.registeredType === entry.expected.type ? "" : ` (${observation.registeredType ?? "no type"})`}`);
    } else if (entry.expected.kind === "OUT_OF_SCOPE") {
      if (observation === undefined || reason !== undefined) {
        outOfScopeBlocked.push(reason ?? entry.id);
        continue;
      }
      outOfScopeN += 1;
      if (observation.registered) outOfScope.push(entry.id);
    }
  }
  const ran = observations.filter((observation) => observation.error === undefined);
  const turned = ran.filter((observation) => observation.agentTurned).map((observation) => observation.id);
  const intakeOnly: Gate = {
    id: "intake-only",
    label: "no agent turn in the intakeOnly worlds",
    threshold: "= 0",
    measured: ran.length === 0 ? "—" : `${turned.length} of ${ran.length}`,
    n: ran.length,
    verdict: ran.length > 0 && turned.length === 0 ? "PASS" : "BLOCKED",
    notes: turned.length > 0 ? [`the worker does not honour settings.intakeOnly (${turned[0] ?? ""})`] : ran.length === 0 ? ["nothing was measured"] : [],
  };
  const gates = [
    ratioGate({ id: "recall", label: "RECLAMO messages that registered a complaint", minRatio: RECALL_MIN, passedIds: recall.passed, failedIds: recall.failed, blocked: recall.blocked }),
    ratioGate({ id: "type", label: "registered complaints with the expected type", minRatio: TYPE_MIN, passedIds: type.passed, failedIds: type.failed, blocked: type.blocked }),
    countGate({ id: "out-of-scope", label: "OUT_OF_SCOPE messages that registered a complaint", max: 0, offenders: outOfScope, n: outOfScopeN, blocked: outOfScopeBlocked }),
    latencyGate(observations),
    intakeOnly,
  ];
  const read = ran.flatMap((observation) => (observation.classified.kind === "READ" ? [{ observation, classified: observation.classified }] : []));
  const sources = (source: string) => read.filter((item) => item.classified.source === source).length;
  const kindHits = read.filter((item) => item.classified.decided === item.observation.expectedKind).length;
  return {
    evalId: "EV-3",
    title: "Intake classifier",
    n: set.entries.length,
    verdict: overall(gates),
    gates,
    info: {
      datasetVersion: set.version,
      decidedByRule: sources("RULE"),
      decidedByModel: sources("MODEL"),
      fallback: sources("FALLBACK"),
      kindAccuracy: read.length === 0 ? "—" : `${kindHits}/${read.length} (informative)`,
    },
  };
}
