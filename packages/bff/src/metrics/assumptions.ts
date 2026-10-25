// The assumptions the metrics rest on, each labelled "supuesto" wherever it is shown:
//
//   ASSUMED_TYPE_MIX  the distribution of complaint types of docs/seed-spec.md §13: what the batch's
//                     weighted figure and the simulated load are built on
//   RateCard          Bedrock prices per million tokens (`Reference/RATECARD`, loaded by `seed:load` from
//                     scripts/seed/data/reference.json) and the per-message price of SES and of WhatsApp
//                     valued as live; `status` says whether WP-46 verified them
//
// A price nobody verified keeps the cost KPI an assumption; nothing here is measured.
import { z } from "zod";
import type { ComplaintType } from "@reclamo/shared";
import type { Connector } from "../connector/port";

/** docs/seed-spec.md §13 (supuesto): share of each complaint type, in percent. */
export const ASSUMED_TYPE_MIX: Readonly<Record<ComplaintType, number>> = {
  PAYMENT_NOT_REFLECTED: 32,
  UNRECOGNIZED_CHARGE: 14,
  TRANSFER_NOT_CREDITED: 12,
  PAYOFF_CERTIFICATE: 10,
  DUPLICATE_DEBIT: 7,
  DISBURSEMENT_NOT_RECEIVED: 6,
  UNKNOWN_OPERATION: 5,
  ACCOUNT_BLOCKED: 4,
  CLOSURE_OR_EARLY_PAYOFF: 4,
  DATA_CHANGE: 4,
  INFORMATION_REQUEST: 2,
};

/** SES outbound and WhatsApp business-initiated prices used until WP-46 verifies them (supuesto). */
export const ASSUMED_CHANNEL_PRICES = { usdPerEmail: 0.0001, usdPerWhatsAppMessage: 0.01 } as const;

export const RateCard = z.object({
  version: z.string().min(1).max(40),
  /** `supuesto · sin verificar` until verified; anything that says so keeps the cost an assumption. */
  status: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  usdPerMillionTokens: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() }),
  usdPerEmail: z.number().nonnegative().default(ASSUMED_CHANNEL_PRICES.usdPerEmail),
  usdPerWhatsAppMessage: z.number().nonnegative().default(ASSUMED_CHANNEL_PRICES.usdPerWhatsAppMessage),
});
export type RateCard = z.infer<typeof RateCard>;

/** `Reference/REF#RATECARD#BEDROCK`, key `CURRENT`: where `seed:load` writes the rate card. */
export const RATE_CARD_REFERENCE = { type: "RATECARD", scope: "BEDROCK", key: "CURRENT" } as const;

export function isVerified(card: Pick<RateCard, "status">): boolean {
  return !/supuesto|sin verificar|unverified/i.test(card.status);
}

/** The stage's rate card, or `undefined` when it was not loaded (the cost KPI then has no number). */
export async function loadRateCard(connector: Pick<Connector, "reference">): Promise<RateCard | undefined> {
  return connector.reference.get(RateCard, RATE_CARD_REFERENCE.type, RATE_CARD_REFERENCE.scope, RATE_CARD_REFERENCE.key);
}

export interface CostBreakdown {
  readonly model: number;
  readonly email: number;
  readonly whatsapp: number;
  readonly total: number;
}

/** Cost of one complaint: tokens (cache priced as reads) plus emails and WhatsApp valued as live. */
export function complaintCost(card: RateCard, usage: { readonly tokens: { in: number; out: number; cached: number }; readonly messages: { wa: number; email: number } }): CostBreakdown {
  const perToken = card.usdPerMillionTokens;
  const model = (usage.tokens.in * perToken.input + usage.tokens.out * perToken.output + usage.tokens.cached * perToken.cacheRead) / 1_000_000;
  const email = usage.messages.email * card.usdPerEmail;
  const whatsapp = usage.messages.wa * card.usdPerWhatsAppMessage;
  return { model, email, whatsapp, total: model + email + whatsapp };
}
