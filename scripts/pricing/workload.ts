// What one complaint and one test gate consume, as the estimate prices it (docs/build-plan.md WP-46,
// docs/test-plan.md §7). Two kinds of number:
//
//   measured   the cached prefix of every agent call (system prompt + the Gateway tool schemas), the
//              classifier's and the reader's fixed prompt and schema: built from the code that ships,
//              in characters, turned into tokens with CHARS_PER_TOKEN
//   supuesto   everything a turn adds on top (envelope, history, tool results, output, Memory work),
//              volumes and the gate's sizes: a `low` and a `high` bound each, to be replaced by the
//              `Metrics` of SC-01 and the batch once they run on the stage
//
// Two model calls per turn: the worker preloads the reads every turn needs (ADR-0021 §7), so the model
// answers or asks for one more tool. Caching: the prefix is a cache read except where a cache write is
// counted (the first call of a turn when the previous one was more than 5 minutes earlier).
import { CLASSIFIER_INSTRUCTION, CLASSIFY_SCHEMA } from "../../packages/bff/src/intake/model";
import { READER_INSTRUCTION, converseRequest } from "../../packages/bff/src/receipts/bedrock-reader";
import { buildSystemPrompt } from "../../packages/bff/src/agent/system-prompt";
import { buildGatewayPayloads } from "../../packages/bff/src/agent-tools/common/gateway-schema";
import { MEMORY_TOP_K } from "../../packages/bff/src/agent/memory";
import { GLOBAL_TURN_CAPS } from "../../packages/bff/src/worker/caps";
import { IMAGE_READ_CAPS } from "../../packages/bff/src/receipts/budget";
import { SIGNUP_IMAGE_READS_PER_DAY } from "../../packages/bff/src/agent-tools/investigation/ports";

export interface Range {
  readonly low: number;
  readonly high: number;
}

const range = (low: number, high: number): Range => {
  if (!(low >= 0 && high >= low)) throw new RangeError(`a range needs 0 <= low <= high (got ${low}, ${high})`);
  return { low, high };
};

/** Supuesto: characters per token of Spanish and English prose mixed with JSON. */
export const CHARS_PER_TOKEN = 3.5;
export const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** Characters of the agent's cached prefix: the system prompt of a turn and every Gateway tool schema. */
export function agentPrefixChars(): number {
  const build = buildGatewayPayloads();
  if (build.problems.length > 0) throw new Error(`the Gateway schemas do not build: ${build.problems.join("; ")}`);
  return buildSystemPrompt({ delimiter: "inbound-000000000000" }).length + JSON.stringify(build.payloads).length;
}

/** Characters the classifier sends besides the customer's text (instruction and forced-output schema). */
export function classifierFixedChars(): number {
  return CLASSIFIER_INSTRUCTION.length + JSON.stringify(CLASSIFY_SCHEMA).length;
}

/** Characters the reader sends besides the image (instruction and forced-output tool). */
export function readerFixedChars(): number {
  const request = converseRequest("reader", { bytes: new Uint8Array(1), contentType: "image/png" });
  return READER_INSTRUCTION.length + JSON.stringify(request.toolConfig).length;
}

/** Records the worker may retrieve per turn: the three namespaces' topK. */
export const MAX_MEMORY_RECORDS_PER_TURN = MEMORY_TOP_K.preferences + MEMORY_TOP_K.facts + MEMORY_TOP_K.summary;

export interface ComplaintWorkload {
  readonly turns: Range;
  readonly callsPerTurn: number;
  /** New input of a turn's first call: the customer's text, `<facts>`, the preloaded reads and the memory lines. */
  readonly envelopeTokens: Range;
  /** What each earlier turn leaves in the Harness window (40 messages). */
  readonly historyTokensPerPriorTurn: Range;
  /** Extra input of the second call: the first call's output and the tool result. */
  readonly toolRoundTripTokens: Range;
  readonly outputTokensPerCall: Range;
  /** `low`: the history is a cache read; `high`: only the prefix is cached and the history is fresh input. */
  readonly historyCached: { readonly low: boolean; readonly high: boolean };
  /** Turns whose first call writes the prefix to the cache again (previous turn more than 5 minutes earlier). */
  readonly prefixCacheWrites: Range;
  /** Memory strategies (Sonnet through the same profile): extraction and consolidation per turn. */
  readonly memoryInputTokensPerTurn: Range;
  readonly memoryOutputTokensPerTurn: Range;
  readonly memoryRecordsPerTurn: Range;
  readonly gatewayCallsPerTurn: Range;
  /** Harness runtime: active vCPU seconds, and GB-seconds of memory (the turn plus the idle tail). */
  readonly runtimeVcpuSecondsPerTurn: Range;
  readonly runtimeGbSecondsPerTurn: Range;
  readonly customerMessages: Range;
  readonly classifierCalls: Range;
  readonly classifierMessageTokens: Range;
  readonly classifierOutputTokens: Range;
  readonly receiptReads: Range;
  readonly imageTokens: Range;
  readonly readerOutputTokens: Range;
  /** G2 checks: outbound free texts, and grounding text units per check (content, source and query). */
  readonly outboundFreeTexts: Range;
  readonly groundingUnitsPerCheck: Range;
  readonly emails: Range;
  readonly attachmentMbPerEmail: Range;
  readonly whatsappOutboundService: Range;
  readonly whatsappOutboundTemplates: Range;
  readonly whatsappInbound: Range;
}

/**
 * The happy path of the main story (C01: a payment that does not show, with its receipt): number in
 * the act, reading, reconciliation, payment applied, written answer by email and the closing
 * WhatsApp; at most 6 turns counting obligations (docs/test-plan.md §7). Every number is a supuesto.
 */
export const HAPPY_PATH: ComplaintWorkload = {
  turns: range(4, 6),
  callsPerTurn: 2,
  envelopeTokens: range(3_000, 7_000),
  historyTokensPerPriorTurn: range(2_500, 6_000),
  toolRoundTripTokens: range(1_000, 2_500),
  outputTokensPerCall: range(350, 600),
  historyCached: { low: true, high: false },
  prefixCacheWrites: range(1, 6),
  memoryInputTokensPerTurn: range(1_500, 4_000),
  memoryOutputTokensPerTurn: range(150, 400),
  memoryRecordsPerTurn: range(4, MAX_MEMORY_RECORDS_PER_TURN),
  gatewayCallsPerTurn: range(1, 3),
  runtimeVcpuSecondsPerTurn: range(1, 3),
  runtimeGbSecondsPerTurn: range(2 * 30, 2 * 330),
  customerMessages: range(3, 5),
  classifierCalls: range(0, 2),
  classifierMessageTokens: range(60, 300),
  classifierOutputTokens: range(60, 200),
  receiptReads: range(1, 1),
  imageTokens: range(1_000, 1_600),
  readerOutputTokens: range(250, 800),
  outboundFreeTexts: range(3, 6),
  groundingUnitsPerCheck: range(3, 6),
  emails: range(1, 2),
  attachmentMbPerEmail: range(0.1, 0.3),
  whatsappOutboundService: range(4, 6),
  whatsappOutboundTemplates: range(0, 1),
  whatsappInbound: range(3, 5),
};

/**
 * The "100 % probada" gate (docs/test-plan.md §7, docs/seed-spec.md §12-§13): three full suites of up
 * to 450 turns and about 250 short calls each (classifier and reader, split in half: supuesto), the
 * real-agent batch of 30 complaints, EV-1 (40 questions, one turn each), EV-2 (64 images plus the 12
 * `SR` receipts five times) and EV-3 (120 messages).
 */
export const GATE = {
  turnsPerSuite: 450,
  fullRuns: 3,
  shortCallsPerSuite: { classifier: 125, reader: 125 },
  batchComplaints: 30,
  ev1Turns: 40,
  ev2Reads: 64 + 12 * 5,
  ev3Classifications: 120,
} as const;

/**
 * The worst day the caps allow (docs/architecture-guests.md §7, ADR-0017). The self-signup pool counts
 * turns and image reads apart; the public pool's daily units are shared by turns and image reads
 * (receipts/budget.ts), so its worst day spends them all on whichever costs more.
 */
export const POOL_WORST_DAY = {
  SIGNUP: { turns: GLOBAL_TURN_CAPS.SIGNUP.DAY ?? 0, imageReads: SIGNUP_IMAGE_READS_PER_DAY },
  PUBLIC: { sharedUnits: Math.max(GLOBAL_TURN_CAPS.PUBLIC.DAY ?? 0, IMAGE_READ_CAPS.public.perDay) },
} as const;

/** The assumption WP-46 replaces (ADR-0021 §6): US$ 0.07 to 0.13 per turn. */
export const PREVIOUS_TURN_ASSUMPTION_USD: Range = range(0.07, 0.13);
