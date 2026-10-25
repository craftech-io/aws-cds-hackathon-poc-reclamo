import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalSets } from "./datasets";
import type { GroundingObservation } from "./ev1-grounding";
import { FULL_PATH_IDS, type PathObservation, type ReadObservation, type Reading } from "./ev2-receipts";
import type { ClassifierObservation } from "./ev3-classifier";
import { blockedEval, countGate, overall, percentile, ratioGate } from "./gates";
import { planOf } from "./plan";
import { buildReport, renderMarkdown, writeReport } from "./report";
import { scoreClassifier } from "./score-classifier";
import { calibrate, scoreGrounding } from "./score-grounding";
import { scoreReceipts, scoreSr, undueImputations } from "./score-receipts";

const sets = loadEvalSets();
const REPS = 5;

// ---- Perfect observations, derived from the sets' own expectations --------------------------------

function groundingOk(score = 0.92): GroundingObservation[] {
  return sets.grounding.entries.map((entry) => ({
    id: entry.id,
    identified: true,
    settled: true,
    answered: true,
    forbiddenHits: [],
    factsFound: entry.requiredFacts.length,
    factsTotal: entry.requiredFacts.length,
    inspection: { kind: "READ", clauseIds: [...entry.expectedClauseIds, "T-1.1"], replies: [{ kind: "REPLY", sent: true, groundingScore: score, relevanceScore: 0.9 }] },
  }));
}

function readingFor(expected: (typeof sets.receipts.images)[number]["expected"]): Reading {
  return { kind: "READING", result: expected.result, source: "BOTH_AGREE", suspiciousText: expected.suspiciousText ?? false, ...(expected.fields === undefined ? {} : { fields: expected.fields }) };
}

function readsOk(): ReadObservation[] {
  const sr = Array.from({ length: REPS }, (_, index) => sets.receipts.srSubset.map((item) => ({ id: item.id, pass: "SR" as const, rep: index + 1, reading: readingFor(item.expected) }))).flat();
  return [...sr, ...sets.receipts.images.map((item) => ({ id: item.id, pass: "PROBE" as const, rep: 1, reading: readingFor(item.expected) }))];
}

function pathsOk(): PathObservation[] {
  return FULL_PATH_IDS.map((id) => {
    const item = sets.receipts.personas.find((candidate) => candidate.id === id);
    const matched = item?.expected.reconciliation === "MATCHED";
    return {
      id,
      settled: true,
      readings: [{ result: item?.expected.result ?? "READ", source: "BOTH_AGREE", suspiciousText: item?.variant === "injection" }],
      reconciliations: item?.expected.reconciliation === undefined ? [] : [item.expected.reconciliation],
      imputations: matched ? [{ status: "EXECUTED", amountCents: item?.expected.fields?.amount ?? 0 }] : [],
      otherActions: [],
    };
  });
}

function classifierOk(): ClassifierObservation[] {
  return sets.classifier.entries.map((entry, index) => ({
    id: entry.id,
    expectedKind: entry.expected.kind,
    ...(entry.expected.type === undefined ? {} : { expectedType: entry.expected.type }),
    registered: entry.expected.kind === "RECLAMO",
    ...(entry.expected.kind === "RECLAMO" && entry.expected.type !== undefined ? { registeredType: entry.expected.type } : {}),
    agentTurned: false,
    settled: true,
    classified: index % 3 === 0 ? { kind: "READ", decided: entry.expected.kind, source: "MODEL", modelMs: 900 + index } : { kind: "READ", decided: entry.expected.kind, source: "RULE" },
  }));
}

const verdicts = (gates: ReadonlyArray<{ id: string; verdict: string }>) => Object.fromEntries(gates.map((gate) => [gate.id, gate.verdict]));

// ---- Gates ---------------------------------------------------------------------------------------

describe("gates", () => {
  it("passes a ratio only when every case was measured", () => {
    expect(ratioGate({ id: "g", label: "l", minRatio: 1, passedIds: ["a", "b"], failedIds: [], blocked: [] }).verdict).toBe("PASS");
    expect(ratioGate({ id: "g", label: "l", minRatio: 0.5, passedIds: ["a"], failedIds: [], blocked: ["b: not run"] }).verdict).toBe("BLOCKED");
    expect(ratioGate({ id: "g", label: "l", minRatio: 1, passedIds: ["a"], failedIds: ["b"], blocked: ["c: not run"] }).verdict).toBe("FAIL");
    expect(ratioGate({ id: "g", label: "l", minRatio: 0.9, passedIds: [], failedIds: [], blocked: [] }).verdict).toBe("BLOCKED");
  });

  it("fails a count over its maximum even with unmeasured cases, and blocks an empty one", () => {
    expect(countGate({ id: "c", label: "l", max: 0, offenders: ["x"], n: 3, blocked: ["y"] }).verdict).toBe("FAIL");
    expect(countGate({ id: "c", label: "l", max: 0, offenders: [], n: 3, blocked: [] }).verdict).toBe("PASS");
    expect(countGate({ id: "c", label: "l", max: 0, offenders: [], n: 0, blocked: [] }).verdict).toBe("BLOCKED");
  });

  it("takes the nearest-rank percentile and lets FAIL beat BLOCKED beat PASS", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBeUndefined();
    expect(overall([{ verdict: "PASS" }, { verdict: "BLOCKED" }])).toBe("BLOCKED");
    expect(overall([{ verdict: "BLOCKED" }, { verdict: "FAIL" }])).toBe("FAIL");
    expect(overall([])).toBe("BLOCKED");
  });
});

// ---- EV-1 ----------------------------------------------------------------------------------------

describe("EV-1 grounding", () => {
  it("passes when every question read its clauses, was answered above the threshold and said nothing forbidden", () => {
    const result = scoreGrounding(sets.grounding, groundingOk());
    expect(result.n).toBe(40);
    expect(result.verdict).toBe("PASS");
    expect(verdicts(result.gates)).toEqual({ clauses: "PASS", grounding: "PASS", forbidden: "PASS" });
  });

  it("fails on one missing clause, one unanswered question or one forbidden pattern", () => {
    const observations = groundingOk();
    const [first, second, third] = observations;
    if (!first || !second || !third) throw new Error("fixture");
    observations[0] = { ...first, inspection: { kind: "READ", clauseIds: [], replies: [] } };
    observations[1] = { ...second, answered: false };
    observations[2] = { ...third, forbiddenHits: ["acciones legales"] };
    const result = scoreGrounding(sets.grounding, observations);
    expect(verdicts(result.gates)).toEqual({ clauses: "FAIL", grounding: "FAIL", forbidden: "FAIL" });
    expect(result.gates.find((gate) => gate.id === "forbidden")?.notes.join(" ")).not.toContain("acciones legales");
  });

  it("is BLOCKED, never PASS, while the driver cannot read TURN# and G2", () => {
    const observations = groundingOk().map((observation) => ({ ...observation, inspection: { kind: "BLOCKED" as const, reason: "turn.inspect: LOCAL_CONTRACT" } }));
    const result = scoreGrounding(sets.grounding, observations);
    expect(verdicts(result.gates)).toEqual({ clauses: "BLOCKED", grounding: "BLOCKED", forbidden: "PASS" });
    expect(result.verdict).toBe("BLOCKED");
  });

  it("proposes a calibrated threshold from the well-grounded questions, floored to 0.05 and bounded", () => {
    const observations = groundingOk(0.87);
    const [first] = observations;
    if (!first || first.inspection.kind !== "READ") throw new Error("fixture");
    observations[0] = { ...first, inspection: { ...first.inspection, replies: [{ kind: "REPLY", sent: false, groundingScore: 0.41, failure: "GROUNDING" }, { kind: "REPLY", sent: true, groundingScore: 0.81 }] } };
    const calibration = calibrate(sets.grounding, observations);
    expect(calibration.currentThreshold).toBe(0.75);
    expect(calibration.goodSentMin).toBe(0.81);
    expect(calibration.refusedForGrounding).toBe(1);
    expect(calibration.refusedInGoodQuestions).toBe(1);
    expect(calibration.proposedThreshold).toBe(0.85);
    expect(calibration.scores).toMatchObject({ n: 41, min: 0.41, max: 0.87 });
    expect(calibrate(sets.grounding, groundingOk(0.99)).proposedThreshold).toBe(0.9);
    expect(calibrate(sets.grounding, []).proposedThreshold).toBeUndefined();
  });

  it("lets good answers G2 refused pull the proposal below the current threshold (not a one-way ratchet)", () => {
    // 8 of 40 well-grounded answers score 0.68-0.74 and are refused; the 32 sent score 0.80-0.95.
    const refusedScores = [0.68, 0.69, 0.7, 0.71, 0.72, 0.73, 0.74, 0.74];
    const observations = groundingOk().map((observation, index) => {
      if (observation.inspection.kind !== "READ") throw new Error("fixture");
      const refusedScore = refusedScores[index];
      const reply = refusedScore === undefined
        ? { kind: "REPLY", sent: true, groundingScore: Number((0.8 + ((index - 8) % 16) * 0.01).toFixed(2)) }
        : { kind: "REPLY", sent: false, groundingScore: refusedScore, failure: "GROUNDING" };
      return { ...observation, inspection: { ...observation.inspection, replies: [reply] } };
    }) as GroundingObservation[];
    const calibration = calibrate(sets.grounding, observations);
    expect(calibration.refusedInGoodQuestions).toBe(8);
    expect(calibration.goodSentMin).toBe(0.8);
    expect(calibration.goodJudged).toBe(40);
    expect(calibration.goodBelowCurrent).toBe(8);
    expect(calibration.proposedThreshold).toBe(0.65);
    expect(calibration.proposedThreshold).toBeLessThan(calibration.currentThreshold);
    expect(calibration.goodBelowProposed).toBe(0);
    // A reply refused for another reason (relevance) is not a grounding judgement and stays out.
    const relevance = observations.map((observation) => observation.inspection.kind === "READ" ? { ...observation, inspection: { ...observation.inspection, replies: observation.inspection.replies.map((reply) => (reply.sent ? reply : { ...reply, groundingScore: 0.1, failure: "RELEVANCE" })) } } : observation) as GroundingObservation[];
    expect(calibrate(sets.grounding, relevance)).toMatchObject({ goodJudged: 32, goodBelowCurrent: 0, proposedThreshold: 0.8 });
  });
});

// ---- EV-2 ----------------------------------------------------------------------------------------

describe("EV-2 receipt reading", () => {
  it("passes every threshold of the spec with exact readings and the expected reconciliations", () => {
    const result = scoreReceipts(sets.receipts, { reads: readsOk(), paths: pathsOk() }, REPS);
    expect(verdicts(result.gates)).toEqual({
      sr: "PASS",
      "legible-fields": "PASS",
      blurry: "PASS",
      fakes: "PASS",
      "payer-mismatch": "PASS",
      "injection-flagged": "PASS",
      "injection-actions": "PASS",
      "undue-imputations": "PASS",
    });
    expect(result.n).toBe(64 + 12 * REPS + 10);
  });

  it("does not count a reading of the fallback alone as an exact SR reading", () => {
    const reads = readsOk().map((read) => (read.pass === "SR" && read.id === "c01-1" && read.rep === 3 && read.reading.kind === "READING" ? { ...read, reading: { ...read.reading, source: "FALLBACK" as const } } : read));
    const gate = scoreSr(sets.receipts, reads, REPS);
    expect(gate.verdict).toBe("FAIL");
    expect(gate.notes).toContain("fail c01-1#3");
  });

  it("blocks the SR gate when a repetition was not read, and when the probe cannot address an image", () => {
    const missing = readsOk().filter((read) => !(read.pass === "SR" && read.rep === REPS && read.id === "c41-1"));
    expect(scoreSr(sets.receipts, missing, REPS).verdict).toBe("BLOCKED");
    const blocked = readsOk().map((read) => (read.pass === "PROBE" && read.id.startsWith("ev-legible") ? { ...read, reading: { kind: "BLOCKED" as const, reason: "receipt.readProbe: LOCAL_CONTRACT" } } : read));
    expect(verdicts(scoreReceipts(sets.receipts, { reads: blocked, paths: pathsOk() }, REPS).gates)["legible-fields"]).toBe("BLOCKED");
  });

  it("fails the legible fields under 95 % and a blurry image read by inventing fields", () => {
    const reads = readsOk().map((read) => {
      if (read.pass !== "PROBE" || read.reading.kind !== "READING") return read;
      if (/^ev-legible-0[1-5]$/.test(read.id) && read.reading.fields) return { ...read, reading: { ...read.reading, fields: { ...read.reading.fields, amount: 1, operationCode: "SUR-20260101-000000-0" } } };
      if (read.id === "ev-blurry-01") return { ...read, reading: { kind: "READING" as const, result: "READ" as const, source: "BEDROCK" as const, suspiciousText: false } };
      return read;
    });
    const result = verdicts(scoreReceipts(sets.receipts, { reads, paths: pathsOk() }, REPS).gates);
    expect(result["legible-fields"]).toBe("FAIL");
    expect(result.blurry).toBe("FAIL");
  });

  it("counts an imputation without a MATCHED expectation, a second one and one of another amount as undue", () => {
    const fake = sets.receipts.personas.find((item) => item.id === "c18-1");
    const matched = sets.receipts.personas.find((item) => item.id === "c04-1");
    if (!fake || !matched) throw new Error("fixture");
    const base: PathObservation = { id: "x", settled: true, readings: [], reconciliations: [], imputations: [], otherActions: [] };
    expect(undueImputations({ ...base, imputations: [{ status: "EXECUTED", amountCents: 100 }] }, fake)).toBe(1);
    const amount = matched.expected.fields?.amount ?? 0;
    expect(undueImputations({ ...base, imputations: [{ status: "EXECUTED", amountCents: amount }] }, matched)).toBe(0);
    expect(undueImputations({ ...base, imputations: [{ status: "EXECUTED", amountCents: amount }, { status: "EXECUTED", amountCents: amount }] }, matched)).toBe(1);
    expect(undueImputations({ ...base, imputations: [{ status: "EXECUTED", amountCents: amount + 1 }] }, matched)).toBe(1);
  });

  it("fails a fake matched, another payer imputed and an injected receipt that moved anything else", () => {
    const paths = pathsOk().map((path) => {
      if (path.id === "c18-1") return { ...path, reconciliations: ["MATCHED" as const] };
      if (path.id === "c41-1") return { ...path, imputations: [{ status: "EXECUTED", amountCents: 1 }] };
      if (path.id === "c19-1") return { ...path, otherActions: ["REFUND_DUPLICATE"] };
      return path;
    });
    const result = verdicts(scoreReceipts(sets.receipts, { reads: readsOk(), paths }, REPS).gates);
    expect(result).toMatchObject({ fakes: "FAIL", "payer-mismatch": "FAIL", "injection-actions": "FAIL", "undue-imputations": "FAIL" });
  });
});

// ---- EV-3 ----------------------------------------------------------------------------------------

describe("EV-3 intake classifier", () => {
  it("passes recall, type, out-of-scope, the model's p95 and the intakeOnly precondition", () => {
    const result = scoreClassifier(sets.classifier, classifierOk());
    expect(result.n).toBe(120);
    expect(verdicts(result.gates)).toEqual({ recall: "PASS", type: "PASS", "out-of-scope": "PASS", "model-p95": "PASS", "intake-only": "PASS" });
  });

  it("fails recall under 95 %, type under 90 %, a registered out-of-scope message and a slow model path", () => {
    let missed = 0;
    let retyped = 0;
    const observations = classifierOk().map((observation) => {
      if (observation.expectedKind === "RECLAMO" && missed < 6) {
        missed += 1;
        return { ...observation, registered: false };
      }
      if (observation.expectedKind === "RECLAMO" && retyped < 10) {
        retyped += 1;
        return { ...observation, registeredType: "DATA_CHANGE" === observation.expectedType ? "DUPLICATE_DEBIT" : "DATA_CHANGE" };
      }
      if (observation.expectedKind === "OUT_OF_SCOPE") return { ...observation, registered: true, registeredType: "UNKNOWN_OPERATION" };
      if (observation.classified.kind === "READ" && observation.classified.source === "MODEL") return { ...observation, classified: { ...observation.classified, modelMs: 4_000 } };
      return observation;
    });
    expect(verdicts(scoreClassifier(sets.classifier, observations).gates)).toMatchObject({ recall: "FAIL", type: "FAIL", "out-of-scope": "FAIL", "model-p95": "FAIL" });
  });

  it("is BLOCKED when the worker ignores intakeOnly or the driver cannot read the classification", () => {
    const turned = classifierOk().map((observation, index) => (index === 0 ? { ...observation, agentTurned: true } : observation));
    expect(scoreClassifier(sets.classifier, turned).verdict).toBe("BLOCKED");
    const unread = classifierOk().map((observation) => ({ ...observation, classified: { kind: "BLOCKED" as const, reason: "intake.inspect: LOCAL_CONTRACT" } }));
    const result = scoreClassifier(sets.classifier, unread);
    expect(verdicts(result.gates)["model-p95"]).toBe("BLOCKED");
    expect(result.verdict).toBe("BLOCKED");
  });
});

// ---- Report --------------------------------------------------------------------------------------

describe("report", () => {
  const startedAt = new Date("2026-10-20T13:00:00Z");
  const finishedAt = new Date("2026-10-20T14:10:00Z");
  const evals = [scoreGrounding(sets.grounding, groundingOk()), scoreReceipts(sets.receipts, { reads: readsOk(), paths: pathsOk() }, REPS), scoreClassifier(sets.classifier, classifierOk())];
  const report = buildReport({ stage: "poc", runId: "18234567890-1", commit: "0df30b5", startedAt, finishedAt, plan: planOf(["EV-1", "EV-2", "EV-3"], sets), turnsBudgeted: 201, evals });

  it("carries N and the date of each run, the thresholds' source and the overall verdict", () => {
    expect(report).toMatchObject({ format: "reclamo-eval-report/1", stage: "poc", date: "2026-10-20", runId: "18234567890-1", commit: "0df30b5", verdict: "PASS", thresholdsSource: "docs/seed-spec.md §12" });
    expect(report.evals.map((result) => [result.evalId, result.n])).toEqual([
      ["EV-1", 40],
      ["EV-2", 134],
      ["EV-3", 120],
    ]);
  });

  it("renders the gates, N, date and calibration, and never a customer's text", () => {
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("# Evaluations · poc · 2026-10-20");
    expect(markdown).toContain("## EV-1 · Grounding · N = 40 · **PASS**");
    expect(markdown).toContain("| `sr` |");
    expect(markdown).toContain("Proposed threshold: 0.90");
    for (const entry of sets.grounding.entries) expect(markdown).not.toContain(entry.question);
    for (const entry of sets.classifier.entries) expect(markdown).not.toContain(entry.text);
  });

  it("is FAIL when one eval fails and BLOCKED when one cannot be measured", () => {
    const blocked = scoreClassifier(sets.classifier, []);
    expect(buildReport({ stage: "poc", runId: "1-1", startedAt, finishedAt, plan: planOf(["EV-3"], sets), turnsBudgeted: 1, evals: [evals[0] ?? blocked, blocked] }).verdict).toBe("BLOCKED");
    const failed = scoreGrounding(sets.grounding, groundingOk().map((observation) => ({ ...observation, answered: false })));
    expect(buildReport({ stage: "poc", runId: "1-1", startedAt, finishedAt, plan: planOf(["EV-1"], sets), turnsBudgeted: 1, evals: [failed, blocked] }).verdict).toBe("FAIL");
  });

  it("reports an eval that could not run as BLOCKED with its reason, never as missing", () => {
    const notRun = blockedEval("EV-2", "Receipt reading", 134, "ev2: the world did not reach READY in 600 s");
    const blockedReport = buildReport({ stage: "poc", runId: "1-1", startedAt, finishedAt, plan: planOf(["EV-2"], sets), turnsBudgeted: 80, evals: [notRun] });
    expect(blockedReport.verdict).toBe("BLOCKED");
    expect(renderMarkdown(blockedReport)).toContain("the world did not reach READY");
  });

  it("writes the JSON and the Markdown as run artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    try {
      const files = writeReport(report, dir);
      expect(JSON.parse(readFileSync(files.json, "utf8"))).toMatchObject({ date: "2026-10-20", verdict: "PASS" });
      expect(readFileSync(files.markdown, "utf8")).toBe(renderMarkdown(report));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
