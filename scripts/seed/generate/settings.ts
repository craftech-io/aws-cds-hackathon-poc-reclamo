// `SETTINGS` of every template (docs/seed-spec.md §4, docs/design-brief.md §4 and §7): caps per money
// action, contact hours, settlement delays, turn and image caps, WhatsApp always `simulated` in a
// template (only `demo` may become `live`, with whatsappLiveApproval in infra/channel-modes.ts, never by the seed), the human
// minutes per action and the synthetic reference rate, both labelled as assumptions. The `guest`
// template carries two sets of usage caps; the factory picks one by the origin of the world id.
import { GUEST_WORLD_LIMITS } from "@reclamo/bff/leads/limits";
import { WORLD_PLACEHOLDER } from "../lib/constants";
import { REFERENCE_RATE } from "./history-money";
import { cents } from "./ledger";

/** The per-complaint cost threshold of the `Metrics` KPI, fixed on 2026-10-14. */
export const COST_PER_COMPLAINT_THRESHOLD_USD = 1.75;

const caps = (agent: number, operator: number) => ({ agentCents: cents(agent), operatorCents: cents(operator) });

export function baseSettings(): Record<string, unknown> {
  return {
    worldId: WORLD_PLACEHOLDER,
    caps: {
      perAction: {
        APPLY_PAYMENT: caps(250_000, 1_000_000),
        REVERSE_CHARGE: caps(15_000, 150_000),
        REFUND_DUPLICATE: caps(120_000, 600_000),
        TRANSFER_REVERSAL: caps(200_000, 1_000_000),
      },
      autoActionsPer30Days: 2,
    },
    contactHours: { weekday: { from: "08:00", to: "20:00" }, saturday: { from: "09:00", to: "13:00" }, formalNotice: { from: "09:00", to: "18:00" } },
    maxProactivePerDay: 3,
    settlementDelays: {
      NORTE: { businessDays: 1, publishAt: "08:30", cutoff: "18:00" },
      SUR: { businessDays: 2, publishAt: "11:00", cutoff: "16:00" },
    },
    turnCaps: { perHour: 60, perDay: 150 },
    imageReadsPerDay: 60,
    rateLimitPerHour: 20,
    channelModes: { whatsapp: "simulated" },
    manualBaseline: {
      items: [
        { action: "Registrar el reclamo y dar el número", minutes: 6, label: "supuesto" },
        { action: "Buscar el pago en la rendición de la red", minutes: 18, label: "supuesto" },
        { action: "Revisar un cargo contra el cuadro de tarifas", minutes: 12, label: "supuesto" },
        { action: "Revisar débitos duplicados", minutes: 10, label: "supuesto" },
        { action: "Consultar el estado de una transferencia", minutes: 9, label: "supuesto" },
        { action: "Redactar y enviar la respuesta escrita", minutes: 15, label: "supuesto" },
      ],
    },
    referenceRate: { annualRate: REFERENCE_RATE, label: "Tasa de referencia sintética (supuesto)" },
    costPerComplaintThresholdUsd: COST_PER_COMPLAINT_THRESHOLD_USD,
    version: 1,
    synthetic: true,
  };
}

/** The two sets of usage caps of `guest` (pre-provisioned `gNN` and self-signup `gs-*`, ADR-0020). */
export function guestSettingsByOrigin(): Record<"INVITED" | "SIGNUP", Record<string, unknown>> {
  return {
    INVITED: { turnCaps: { perHour: 60, perDay: 150 }, imageReadsPerDay: 60 },
    SIGNUP: {
      turnCaps: { perHour: 60, perDay: GUEST_WORLD_LIMITS.turnsPerDay },
      turnsPerEpoch: GUEST_WORLD_LIMITS.turnsPerEpoch,
      imageReadsPerDay: GUEST_WORLD_LIMITS.imageReadsPerDay,
      productEmailsPerDay: GUEST_WORLD_LIMITS.productEmailsPerDay,
      resetsPerDay: GUEST_WORLD_LIMITS.resetsPerDay,
    },
  };
}
