// The cost per complaint and the cost of the test gate, priced with the verified rate card (docs/build-plan.md
// WP-46, docs/architecture.md §12, docs/test-plan.md §7). Pure: a workload (workload.ts) in, USD out, a
// `low` and a `high` bound each. The breakdown is the one the console shows (agent, classifier,
// reader, SES, WhatsApp valued as live) plus the two lines a per-token figure leaves out: the
// Guardrails G1/G2 and the AgentCore platform (Gateway calls, Memory retrievals, Runtime compute).
import { PROJECT_BUDGET } from "../../infra/observability-spec";
import { type ModelUse, type TokenKind, modelRates, priceOf } from "./price-list";
import {
  CHARS_PER_TOKEN,
  type ComplaintWorkload,
  GATE,
  HAPPY_PATH,
  POOL_WORST_DAY,
  PREVIOUS_TURN_ASSUMPTION_USD,
  type Range,
  agentPrefixChars,
  classifierFixedChars,
  readerFixedChars,
  tokensOf,
} from "./workload";

export type Bound = keyof Range;
export const BOUNDS: readonly Bound[] = ["low", "high"];

export type TokenUse = Readonly<Record<TokenKind, number>>;
const NO_TOKENS: TokenUse = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const addTokens = (a: TokenUse, b: TokenUse): TokenUse => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

/** USD of a token use at the rates of a model use. */
export function tokenUsd(use: ModelUse, tokens: TokenUse): number {
  const rates = modelRates(use);
  return (tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheWrite * rates.cacheWrite) / 1_000_000;
}

export interface Breakdown {
  readonly agent: number;
  readonly classifier: number;
  readonly reader: number;
  readonly guardrails: number;
  readonly agentPlatform: number;
  readonly ses: number;
  readonly whatsappValuedAsLive: number;
  readonly total: number;
}

export interface AgentCalls {
  readonly tokens: TokenUse;
  /** G1 text units the Harness calls send (1,000 characters each, per call). */
  readonly g1Units: number;
}

const unitsOf = (tokens: number): number => (tokens <= 0 ? 0 : Math.ceil((tokens * CHARS_PER_TOKEN) / 1_000));

/**
 * The Harness calls of one complaint. `low`: incremental caching (each call reads what is cached and
 * writes only what it adds; G1 sees only the new content). `high`: only the prefix is cached, the
 * history and the envelope are fresh input every call, and G1 sees all of it.
 */
export function agentCalls(workload: ComplaintWorkload, bound: Bound, prefixTokens: number): AgentCalls {
  const turns = workload.turns[bound];
  const envelope = workload.envelopeTokens[bound];
  const roundTrip = workload.toolRoundTripTokens[bound];
  const output = workload.outputTokensPerCall[bound];
  const writes = Math.min(turns, workload.prefixCacheWrites[bound]);
  const incremental = workload.historyCached[bound];
  let tokens = NO_TOKENS;
  let g1Units = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    const history = (turn - 1) * workload.historyTokensPerPriorTurn[bound];
    const prefixWrite = turn <= writes;
    const prefix = prefixWrite ? { cacheWrite: prefixTokens, cacheRead: 0 } : { cacheWrite: 0, cacheRead: prefixTokens };
    for (let call = 1; call <= workload.callsPerTurn; call += 1) {
      const added = call === 1 ? envelope : roundTrip;
      const earlier = call === 1 ? 0 : envelope + (call - 2) * roundTrip;
      const prefixPart = call === 1 ? prefix : { cacheWrite: 0, cacheRead: prefixTokens };
      const use: TokenUse = incremental
        ? { input: 0, output, cacheRead: prefixPart.cacheRead + history + earlier, cacheWrite: prefixPart.cacheWrite + added }
        : { input: history + earlier + added, output, cacheRead: prefixPart.cacheRead, cacheWrite: prefixPart.cacheWrite };
      tokens = addTokens(tokens, use);
      g1Units += unitsOf(incremental ? added : history + earlier + added);
    }
  }
  return { tokens, g1Units };
}

const G1_PER_UNIT = (): number => priceOf("guardrail:topic") + priceOf("guardrail:content") + priceOf("guardrail:piiPaid") + priceOf("guardrail:regexFree");
const G2_TOPIC_PER_UNIT = (): number => priceOf("guardrail:topic");

/** USD of one classifier call and of one receipt read. */
export function shortCallUsd(workload: ComplaintWorkload, bound: Bound): { readonly classifier: number; readonly reader: number } {
  const classifier = tokenUsd("classifier", { ...NO_TOKENS, input: tokensOf(classifierFixedChars()) + workload.classifierMessageTokens[bound], output: workload.classifierOutputTokens[bound] });
  const reader = tokenUsd("reader", { ...NO_TOKENS, input: tokensOf(readerFixedChars()) + workload.imageTokens[bound], output: workload.readerOutputTokens[bound] });
  return { classifier, reader };
}

const round = (usd: number, digits = 6): number => Math.round(usd * 10 ** digits) / 10 ** digits;

/** The cost of one complaint of `workload` at `bound`. */
export function complaintBreakdown(workload: ComplaintWorkload, bound: Bound, prefixTokens: number = tokensOf(agentPrefixChars())): Breakdown {
  const turns = workload.turns[bound];
  const calls = agentCalls(workload, bound, prefixTokens);
  const memoryTokens: TokenUse = { ...NO_TOKENS, input: turns * workload.memoryInputTokensPerTurn[bound], output: turns * workload.memoryOutputTokensPerTurn[bound] };
  const agent = tokenUsd("agent", calls.tokens) + tokenUsd("agent", memoryTokens);
  const short = shortCallUsd(workload, bound);
  const classifier = workload.classifierCalls[bound] * short.classifier;
  const reader = workload.receiptReads[bound] * short.reader;
  const g1 = (workload.customerMessages[bound] + calls.g1Units) * G1_PER_UNIT();
  const g2 = workload.outboundFreeTexts[bound] * (G2_TOPIC_PER_UNIT() + workload.groundingUnitsPerCheck[bound] * priceOf("guardrail:grounding"));
  const agentPlatform =
    turns * workload.gatewayCallsPerTurn[bound] * priceOf("agentcore:gatewayInvocation") +
    turns * workload.memoryRecordsPerTurn[bound] * priceOf("agentcore:memoryRetrieval") +
    (turns * workload.runtimeVcpuSecondsPerTurn[bound] * priceOf("agentcore:runtimeVcpu")) / 3_600 +
    (turns * workload.runtimeGbSecondsPerTurn[bound] * priceOf("agentcore:runtimeMemory")) / 3_600;
  const emails = workload.emails[bound];
  const ses = emails * priceOf("ses:recipient") + (emails * workload.attachmentMbPerEmail[bound] * priceOf("ses:attachmentGb")) / 1_024;
  const messages = workload.whatsappOutboundService[bound] + workload.whatsappOutboundTemplates[bound] + workload.whatsappInbound[bound];
  const whatsappValuedAsLive = messages * priceOf("whatsapp:awsMessageAR") + workload.whatsappOutboundTemplates[bound] * priceOf("whatsapp:metaUtilityAR");
  const parts = { agent, classifier, reader, guardrails: g1 + g2, agentPlatform, ses, whatsappValuedAsLive };
  const total = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return { agent: round(agent), classifier: round(classifier), reader: round(reader), guardrails: round(g1 + g2), agentPlatform: round(agentPlatform), ses: round(ses), whatsappValuedAsLive: round(whatsappValuedAsLive), total: round(total) };
}

/** USD of one agent turn: its Harness calls, Memory, G1, G2 and platform share, without classifier, reader or channels. */
export function perTurnUsd(workload: ComplaintWorkload, bound: Bound, prefixTokens?: number): number {
  const complaint = complaintBreakdown(workload, bound, prefixTokens);
  return round((complaint.agent + complaint.guardrails + complaint.agentPlatform) / workload.turns[bound]);
}

/** The assumption ADR-0021 §6 made: 30,000 to 60,000 uncached input and 1,000 output tokens per turn. */
export function previousAssumptionAtVerifiedRates(): Range {
  const at = (input: number): number => round(tokenUsd("agent", { ...NO_TOKENS, input, output: 1_000 }), 4);
  return { low: at(30_000), high: at(60_000) };
}

export interface GateEstimate {
  readonly turns: number;
  readonly usd: number;
  readonly perExtraSuiteUsd: number;
  readonly parts: { readonly suites: number; readonly batch: number; readonly ev1: number; readonly ev2: number; readonly ev3: number };
}

/** "100 % probada": three suites, the real batch and the three evals. */
export function gateEstimate(workload: ComplaintWorkload, bound: Bound): GateEstimate {
  const turn = perTurnUsd(workload, bound);
  const short = shortCallUsd(workload, bound);
  const suite = GATE.turnsPerSuite * turn + GATE.shortCallsPerSuite.classifier * short.classifier + GATE.shortCallsPerSuite.reader * short.reader;
  const parts = {
    suites: round(GATE.fullRuns * suite, 2),
    batch: round(GATE.batchComplaints * complaintBreakdown(workload, bound).total, 2),
    ev1: round(GATE.ev1Turns * turn, 2),
    ev2: round(GATE.ev2Reads * short.reader, 2),
    ev3: round(GATE.ev3Classifications * short.classifier, 2),
  };
  const turns = GATE.turnsPerSuite * GATE.fullRuns + GATE.batchComplaints * workload.turns[bound] + GATE.ev1Turns;
  return { turns, usd: round(Object.values(parts).reduce((sum, value) => sum + value, 0), 2), perExtraSuiteUsd: round(suite, 2), parts };
}

export interface PoolDay {
  readonly signupUsd: number;
  readonly publicUsd: number;
}

/** The worst day each pool's caps allow. */
export function poolWorstDay(workload: ComplaintWorkload, bound: Bound): PoolDay {
  const turn = perTurnUsd(workload, bound);
  const read = shortCallUsd(workload, bound).reader;
  return {
    signupUsd: round(POOL_WORST_DAY.SIGNUP.turns * turn + POOL_WORST_DAY.SIGNUP.imageReads * read, 2),
    publicUsd: round(POOL_WORST_DAY.PUBLIC.sharedUnits * Math.max(turn, read), 2),
  };
}

/** A threshold the CTO can fix: the high bound with 25 % headroom, rounded up to US$ 0.05. */
export function proposedThresholdUsd(workload: ComplaintWorkload = HAPPY_PATH): number {
  return round(Math.ceil((complaintBreakdown(workload, "high").total * 1.25) / 0.05) * 0.05, 2);
}

export interface CostEstimate {
  readonly prefixTokens: number;
  readonly complaint: Readonly<Record<Bound, Breakdown>>;
  readonly perTurnUsd: Range;
  readonly previousTurnAssumptionUsd: Range;
  readonly previousAssumptionAtVerifiedRatesUsd: Range;
  readonly shortCalls: Readonly<Record<Bound, { readonly classifier: number; readonly reader: number }>>;
  readonly gate: Readonly<Record<Bound, GateEstimate>>;
  readonly poolWorstDay: Readonly<Record<Bound, PoolDay>>;
  readonly proposedThresholdUsdPerComplaint: number;
  readonly projectBudgetUsdPerMonth: number;
}

export function estimate(workload: ComplaintWorkload = HAPPY_PATH): CostEstimate {
  const per = <T>(of: (bound: Bound) => T): Readonly<Record<Bound, T>> => ({ low: of("low"), high: of("high") });
  return {
    prefixTokens: tokensOf(agentPrefixChars()),
    complaint: per((bound) => complaintBreakdown(workload, bound)),
    perTurnUsd: { low: perTurnUsd(workload, "low"), high: perTurnUsd(workload, "high") },
    previousTurnAssumptionUsd: PREVIOUS_TURN_ASSUMPTION_USD,
    previousAssumptionAtVerifiedRatesUsd: previousAssumptionAtVerifiedRates(),
    shortCalls: per((bound) => shortCallUsd(workload, bound)),
    gate: per((bound) => gateEstimate(workload, bound)),
    poolWorstDay: per((bound) => poolWorstDay(workload, bound)),
    proposedThresholdUsdPerComplaint: proposedThresholdUsd(workload),
    projectBudgetUsdPerMonth: PROJECT_BUDGET.limitUsdPerMonth,
  };
}
