// Text report of the rate card and the estimate (scripts/pricing/ratecard.ts prints it). English, like
// every script output; the labels say which figures are measured, verified or supuesto.
import type { RateCardDocument } from "./card";
import { BOUNDS, type Breakdown, type CostEstimate } from "./estimate";
import { GATE, HAPPY_PATH, POOL_WORST_DAY } from "./workload";

const usd = (value: number, digits = 4): string => `US$ ${value.toFixed(digits)}`;
const span = (low: number, high: number, digits = 4): string => `${usd(low, digits)} – ${usd(high, digits)}`;

const BREAKDOWN_ROWS: readonly (keyof Breakdown)[] = ["agent", "classifier", "reader", "guardrails", "agentPlatform", "ses", "whatsappValuedAsLive", "total"];

export function rateCardLines(card: RateCardDocument): string[] {
  return [
    `rate card ${card.version} (${card.status})`,
    ...card.rates.map((rate) => `  ${rate.rateId.padEnd(34)} ${String(rate.usd).padStart(10)} USD / ${rate.unit.padEnd(16)} ${rate.offer} ${rate.sku} (effective ${rate.effectiveDate.slice(0, 10)})`),
    `  WhatsApp flat rate for the cost KPI: ${usd(card.usdPerWhatsAppMessage)} per message (${card.whatsappFlatBasis})`,
  ];
}

export function estimateLines(result: CostEstimate): string[] {
  const { complaint, gate, poolWorstDay } = result;
  return [
    `agent prefix (system prompt + Gateway tool schemas, measured): ${result.prefixTokens} tokens`,
    `happy path (C01, ${HAPPY_PATH.turns.low}–${HAPPY_PATH.turns.high} turns, ${HAPPY_PATH.callsPerTurn} model calls per turn, caching on; volumes supuesto):`,
    ...BREAKDOWN_ROWS.map((row) => `  ${row.padEnd(22)} ${span(complaint.low[row], complaint.high[row])}`),
    `per agent turn: ${span(result.perTurnUsd.low, result.perTurnUsd.high)} (replaces the supuesto ${span(result.previousTurnAssumptionUsd.low, result.previousTurnAssumptionUsd.high, 2)}; that assumption at verified rates: ${span(result.previousAssumptionAtVerifiedRatesUsd.low, result.previousAssumptionAtVerifiedRatesUsd.high)})`,
    `one classifier call: ${span(result.shortCalls.low.classifier, result.shortCalls.high.classifier, 6)}; one receipt read: ${span(result.shortCalls.low.reader, result.shortCalls.high.reader)}`,
    `"100 % probada" gate (${GATE.fullRuns} × ${GATE.turnsPerSuite} turns, batch of ${GATE.batchComplaints}, EV-1/2/3): ${span(gate.low.usd, gate.high.usd, 2)}; each extra suite ${span(gate.low.perExtraSuiteUsd, gate.high.perExtraSuiteUsd, 2)}`,
    ...BOUNDS.map((bound) => `  ${bound}: suites ${usd(gate[bound].parts.suites, 2)} · batch ${usd(gate[bound].parts.batch, 2)} · EV-1 ${usd(gate[bound].parts.ev1, 2)} · EV-2 ${usd(gate[bound].parts.ev2, 2)} · EV-3 ${usd(gate[bound].parts.ev3, 2)}`),
    `worst day, SIGNUP pool (${POOL_WORST_DAY.SIGNUP.turns} turns, ${POOL_WORST_DAY.SIGNUP.imageReads} image reads): ${span(poolWorstDay.low.signupUsd, poolWorstDay.high.signupUsd, 2)}`,
    `worst day, PUBLIC pool (${POOL_WORST_DAY.PUBLIC.sharedUnits} units): ${span(poolWorstDay.low.publicUsd, poolWorstDay.high.publicUsd, 2)}; project budget ${usd(result.projectBudgetUsdPerMonth, 0)} per month (breaker at 100 %)`,
    `proposed threshold per complaint for the CTO (high bound + 25 %): ${usd(result.proposedThresholdUsdPerComplaint, 2)}`,
  ];
}
