// The models of an in-process world, answering from the seed's evaluation sets instead of Bedrock
// (docs/test-plan.md §2, level LF): the input classifier answers what `evals/classifier.json` expects
// for a known text, the receipt reader answers what `evals/receipts.json` expects for a known image
// (by SHA-256: its evaluation images and the personas' receipts), G1 lets every text through and G2 passes every outbound message. Anything unknown is
// "Bedrock unavailable", so the code takes its deterministic path. A test changes a verdict per call.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IntakeModel, ModelOutcome } from "@reclamo/bff/intake/model";
import type { BedrockReceiptReader, BedrockReading } from "@reclamo/bff/receipts/bedrock-reader";
import type { G1Prefilter, G1Verdict } from "@reclamo/bff/turns/prefilter";
import type { G2Input, G2Verdict, OutputGuardrail } from "@reclamo/bff/outbound/g2";
import { seedPaths } from "../../../../scripts/seed/lib/constants";

const ClassifierEval = z.object({
  entries: z.array(z.object({ text: z.string(), expected: z.object({ kind: z.enum(["CONSULTA", "RECLAMO", "OUT_OF_SCOPE", "UNCLEAR"]), type: z.string().optional() }) })),
});

const ReceiptFieldsEval = z.object({ amount: z.number().int(), network: z.string(), operationCode: z.string(), paidAtLocal: z.string(), payerReference: z.string().optional() });
const ReceiptEval = z.object({
  sha256: z.string(),
  expected: z.object({ result: z.string(), fields: ReceiptFieldsEval.optional(), suspiciousText: z.boolean().optional() }),
});
/** Both sets of the file: the evaluation images and the personas' own receipts (what the scripts attach). */
const ReceiptsEval = z.object({ images: z.array(ReceiptEval), personas: z.array(ReceiptEval) });

function evalFile(name: string): unknown {
  return JSON.parse(readFileSync(join(seedPaths().evals, name), "utf8"));
}

export interface EvalClassifier extends IntakeModel {
  readonly texts: string[];
  /** A fixed answer for the next calls (`undefined` goes back to the evaluation set). */
  forced?: ModelOutcome;
}

export function evalClassifier(): EvalClassifier {
  const expected = new Map(ClassifierEval.parse(evalFile("classifier.json")).entries.map((entry) => [entry.text.trim(), entry.expected]));
  const model: EvalClassifier = {
    texts: [],
    async classify(text) {
      model.texts.push(text);
      if (model.forced !== undefined) return model.forced;
      const answer = expected.get(text.trim());
      if (answer === undefined) return { kind: "UNAVAILABLE", reason: "SERVICE_ERROR" };
      return { kind: "CLASSIFIED", result: { kind: answer.kind, ...(answer.type === undefined ? {} : { type: answer.type as never }), confidence: 0.95 } };
    },
  };
  return model;
}

export interface EvalReceiptReader extends BedrockReceiptReader {
  /** SHA-256 of every image read, in order. */
  readonly reads: string[];
  forced?: BedrockReading;
}

function readingOf(expected: z.infer<typeof ReceiptsEval>["images"][number]["expected"]): BedrockReading {
  const fields = expected.fields;
  const base = { currency: "ARS", notes: "", suspiciousText: expected.suspiciousText === true };
  switch (expected.result) {
    case "UNREADABLE":
      return { kind: "READ", raw: { ...base, isReceipt: true, legibility: "ILLEGIBLE" } as never };
    case "NOT_A_RECEIPT":
      return { kind: "READ", raw: { ...base, isReceipt: false, legibility: "CLEAR" } as never };
    default:
      if (fields === undefined) return { kind: "UNAVAILABLE", reason: "SERVICE_ERROR", attempts: 1 };
      return {
        kind: "READ",
        raw: {
          ...base,
          isReceipt: true,
          legibility: "CLEAR",
          network: fields.network,
          operationCode: fields.operationCode,
          amount: fields.amount / 100,
          paidAtLocal: fields.paidAtLocal,
          ...(fields.payerReference === undefined ? {} : { payerReference: fields.payerReference }),
        } as never,
      };
  }
}

export function evalReceiptReader(): EvalReceiptReader {
  const set = ReceiptsEval.parse(evalFile("receipts.json"));
  const expected = new Map([...set.images, ...set.personas].map((image) => [image.sha256, image.expected]));
  const reader: EvalReceiptReader = {
    reads: [],
    async read(image) {
      const sha256 = createHash("sha256").update(image.bytes).digest("hex");
      reader.reads.push(sha256);
      if (reader.forced !== undefined) return reader.forced;
      const answer = expected.get(sha256);
      return answer === undefined ? { kind: "UNAVAILABLE", reason: "SERVICE_ERROR", attempts: 1 } : readingOf(answer);
    },
  };
  return reader;
}

export interface ScriptedGuardrails {
  readonly g1: G1Prefilter & { readonly texts: string[]; verdict: (text: string) => G1Verdict };
  readonly g2: OutputGuardrail & { readonly inputs: G2Input[]; verdict: (input: G2Input) => G2Verdict };
}

/** G1 lets everything through and G2 passes everything, until a test says otherwise. */
export function scriptedGuardrails(): ScriptedGuardrails {
  const g1: ScriptedGuardrails["g1"] = {
    texts: [],
    verdict: () => ({ action: "NONE" }),
    async check(text) {
      g1.texts.push(text);
      return g1.verdict(text);
    },
  };
  const g2: ScriptedGuardrails["g2"] = {
    inputs: [],
    verdict: () => ({ action: "NONE", groundingScore: 0.95, relevanceScore: 0.9 }),
    async check(input) {
      g2.inputs.push(input);
      return g2.verdict(input);
    },
  };
  return { g1, g2 };
}
