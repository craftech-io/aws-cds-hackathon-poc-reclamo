// EV-1's thresholds (docs/seed-spec.md §12, `evals/grounding.json` `threshold`) over its observations,
// and the calibration of the grounding threshold that ADR-0008 records. Pure.
//
//   clauses    every expected clause id among the clause ids the question's turns read  ≥ clauseRecall
//   grounding  the question was answered (ALWAYS_ANSWER) and every grounded reply that reached the
//              customer scored at least `groundingScore`                                  100 %
//   forbidden  outbound bodies matching a forbidden pattern                               ≤ forbidden
import type { GroundingSet } from "./datasets";
import type { GroundingObservation, ScoredReply } from "./ev1-grounding";
import { type Calibration, type EvalResult, countGate, overall, percentile, ratioGate } from "./gates";

const PROPOSAL_FLOOR = 0.5;
const PROPOSAL_CEILING = 0.9;

function blockedReason(observation: GroundingObservation): string | undefined {
  if (observation.error !== undefined) return `${observation.id}: ${observation.error}`;
  return observation.inspection.kind === "BLOCKED" ? `${observation.id}: ${observation.inspection.reason}` : undefined;
}

function clausesComplete(observation: GroundingObservation, expected: readonly string[]): boolean | undefined {
  if (observation.inspection.kind !== "READ") return undefined;
  const read = new Set(observation.inspection.clauseIds);
  return expected.every((clauseId) => read.has(clauseId));
}

function sentScored(replies: readonly ScoredReply[]): number[] {
  return replies.flatMap((reply) => (reply.sent && reply.groundingScore !== undefined ? [reply.groundingScore] : []));
}

/**
 * Grounding scores of every reply G2 judged on grounding: sent, or refused FOR GROUNDING. A calibration
 * over the sent ones alone would only see scores the current threshold already let through, and could
 * only ever propose a stricter one.
 */
function judgedScored(replies: readonly ScoredReply[]): number[] {
  return replies.flatMap((reply) => (reply.groundingScore !== undefined && (reply.sent || reply.failure === "GROUNDING") ? [reply.groundingScore] : []));
}

/** The good questions: their expected clauses were read and nothing forbidden reached the customer. */
function goodQuestions(set: GroundingSet, observations: readonly GroundingObservation[]): GroundingObservation[] {
  const expected = new Map(set.entries.map((entry) => [entry.id, entry.expectedClauseIds]));
  return observations.filter((observation) => clausesComplete(observation, expected.get(observation.id) ?? []) === true && observation.forbiddenHits.length === 0);
}

const floorTo = (value: number, step: number): number => Math.floor(value / step + 1e-9) * step;

export function calibrate(set: GroundingSet, observations: readonly GroundingObservation[]): Calibration {
  const replies = observations.flatMap((observation) => (observation.inspection.kind === "READ" ? observation.inspection.replies : []));
  const scores = replies.flatMap((reply) => (reply.groundingScore === undefined ? [] : [reply.groundingScore]));
  const good = goodQuestions(set, observations);
  const goodReplies = good.flatMap((observation) => (observation.inspection.kind === "READ" ? observation.inspection.replies : []));
  const goodSent = sentScored(goodReplies);
  const goodJudged = judgedScored(goodReplies);
  const refused = (list: readonly ScoredReply[]) => list.filter((reply) => !reply.sent && reply.failure === "GROUNDING").length;
  const p05 = percentile(goodJudged, 5);
  const proposed = p05 === undefined ? undefined : Math.min(PROPOSAL_CEILING, Math.max(PROPOSAL_FLOOR, Number(floorTo(p05, 0.05).toFixed(2))));
  const below = (threshold: number) => goodJudged.filter((score) => score < threshold).length;
  const current = set.threshold.groundingScore;
  const min = scores.length === 0 ? undefined : Math.min(...scores);
  const max = scores.length === 0 ? undefined : Math.max(...scores);
  const scorePercentiles = { p05: percentile(scores, 5), p50: percentile(scores, 50) };
  return {
    currentThreshold: current,
    scores: {
      n: scores.length,
      ...(min === undefined ? {} : { min }),
      ...(scorePercentiles.p05 === undefined ? {} : { p05: scorePercentiles.p05 }),
      ...(scorePercentiles.p50 === undefined ? {} : { p50: scorePercentiles.p50 }),
      ...(max === undefined ? {} : { max }),
    },
    ...(goodSent.length === 0 ? {} : { goodSentMin: Math.min(...goodSent) }),
    refusedForGrounding: refused(replies),
    refusedInGoodQuestions: refused(goodReplies),
    goodJudged: goodJudged.length,
    goodBelowCurrent: below(current),
    ...(proposed === undefined ? {} : { proposedThreshold: proposed, goodBelowProposed: below(proposed) }),
  };
}

export function scoreGrounding(set: GroundingSet, observations: readonly GroundingObservation[]): EvalResult {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const clause = { passed: [] as string[], failed: [] as string[], blocked: [] as string[] };
  const grounded = { passed: [] as string[], failed: [] as string[], blocked: [] as string[] };
  const forbidden: string[] = [];
  const forbiddenBlocked: string[] = [];
  let measuredTexts = 0;
  let factsFound = 0;
  let factsTotal = 0;
  let identified = 0;
  for (const entry of set.entries) {
    const observation = byId.get(entry.id);
    if (observation === undefined) {
      for (const list of [clause.blocked, grounded.blocked, forbiddenBlocked]) list.push(`${entry.id}: not run`);
      continue;
    }
    const blocked = blockedReason(observation);
    if (observation.error === undefined) {
      measuredTexts += 1;
      if (observation.forbiddenHits.length > 0) forbidden.push(`${entry.id} (${observation.forbiddenHits.length} pattern(s))`);
      factsFound += observation.factsFound;
      factsTotal += observation.factsTotal;
      if (observation.identified) identified += 1;
    } else forbiddenBlocked.push(blocked ?? entry.id);
    const complete = clausesComplete(observation, entry.expectedClauseIds);
    if (complete === undefined) clause.blocked.push(blocked ?? entry.id);
    else (complete ? clause.passed : clause.failed).push(entry.id);
    if (observation.inspection.kind !== "READ" || observation.error !== undefined) grounded.blocked.push(blocked ?? entry.id);
    else if (!observation.answered) grounded.failed.push(`${entry.id} (no answer)`);
    else if (sentScored(observation.inspection.replies).some((score) => score < set.threshold.groundingScore)) grounded.failed.push(`${entry.id} (score below threshold)`);
    else grounded.passed.push(entry.id);
  }
  const gates = [
    ratioGate({ id: "clauses", label: "expected clauses read in TURN#", minRatio: set.threshold.clauseRecall, passedIds: clause.passed, failedIds: clause.failed, blocked: clause.blocked }),
    ratioGate({ id: "grounding", label: `answered, every grounded reply ≥ ${set.threshold.groundingScore}`, minRatio: 1, passedIds: grounded.passed, failedIds: grounded.failed, blocked: grounded.blocked }),
    countGate({ id: "forbidden", label: "questions with a forbidden pattern in an outbound message", max: set.threshold.forbidden, offenders: forbidden, n: measuredTexts, blocked: forbiddenBlocked }),
  ];
  return {
    evalId: "EV-1",
    title: "Grounding",
    n: set.entries.length,
    verdict: overall(gates),
    gates,
    info: { datasetVersion: set.version, identified: `${identified}/${measuredTexts}`, requiredFacts: factsTotal === 0 ? "—" : `${factsFound}/${factsTotal} (informative: the wording is the model's)` },
    calibration: calibrate(set, observations),
  };
}
