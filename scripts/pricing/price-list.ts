// The verified prices behind the rate card (docs/build-plan.md WP-46, ADR-0021 §6): each line is one
// on-demand price dimension of the AWS Price List for us-east-1, the machine-readable feed behind the
// official pricing pages, read on PRICES_READ_ON. A line keeps the offer, SKU, usage type, unit, price,
// the date AWS made it effective and the publication date of the offer file it came from, so anyone
// can find it again (`live.ts` re-reads the offer files and compares every line by SKU).
//
//   AmazonBedrockFoundationModels  the agent (Harness and Memory, Claude Sonnet 5.5), the classifier
//                                  (Claude Haiku 5.5, ADR-0016) and the receipt reader (Claude Opus 5.5,
//                                  ADR-0007): "Standard, Global" lines, 5-minute cache writes
//   AmazonBedrock                  Guardrails G1 and G2 (per text unit of 1,000 characters)
//   AmazonBedrockAgentCore         Gateway calls, long-term Memory retrievals, Runtime compute
//   AmazonSES                      outbound recipients (the stage sends to the SES mailbox simulator,
//                                  which bills the same), attachments
//   AmazonPinpoint                 the AWS End User Messaging Social fee per WhatsApp message (Argentina)
//   AWSEndUserMessaging3pFees      Meta's fee per template category (Argentina), passed through by AWS

import { AGENT_MODEL_ID, CLASSIFIER_MODEL_ID, RECEIPT_MODEL_ID } from "../../infra/agentcore-spec";

/** Day the offer files below were read. */
export const PRICES_READ_ON = "2026-10-09";
export const PRICE_REGION = "us-east-1";

export const PRICE_LIST_ROOT = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

export const OFFERS = ["AmazonBedrockFoundationModels", "AmazonBedrock", "AmazonBedrockAgentCore", "AmazonSES", "AmazonPinpoint", "AWSEndUserMessaging3pFees"] as const;
export type Offer = (typeof OFFERS)[number];

/** The offer file of `offer` for us-east-1: the source every line cites. */
export function offerUrl(offer: Offer): string {
  return `${PRICE_LIST_ROOT}/${offer}/current/${PRICE_REGION}/index.json`;
}

/** The human-readable pricing page of each offer. */
export const PRICING_PAGES: Readonly<Record<Offer, string>> = {
  AmazonBedrockFoundationModels: "https://aws.amazon.com/bedrock/pricing/",
  AmazonBedrock: "https://aws.amazon.com/bedrock/pricing/",
  AmazonBedrockAgentCore: "https://aws.amazon.com/bedrock/agentcore/pricing/",
  AmazonSES: "https://aws.amazon.com/ses/pricing/",
  AmazonPinpoint: "https://aws.amazon.com/end-user-messaging/pricing/",
  AWSEndUserMessaging3pFees: "https://aws.amazon.com/end-user-messaging/pricing/",
};

/** `publicationDate` of each offer file as it was read. */
export const OFFER_PUBLISHED_AT: Readonly<Record<Offer, string>> = {
  AmazonBedrockFoundationModels: "2026-10-08T23:56:37Z",
  AmazonBedrock: "2026-10-06T14:47:26Z",
  AmazonBedrockAgentCore: "2026-10-06T13:21:19Z",
  AmazonSES: "2026-09-11T12:45:07Z",
  AmazonPinpoint: "2026-09-15T21:20:41Z",
  AWSEndUserMessaging3pFees: "2026-09-16T22:05:49Z",
};

export interface PriceLine {
  /** Stable id the rate card and the estimate use. */
  readonly id: string;
  readonly offer: Offer;
  readonly sku: string;
  readonly usageType: string;
  /** Unit as the offer file writes it. */
  readonly unit: string;
  readonly usd: number;
  /** `effectiveDate` of the on-demand term. */
  readonly effectiveDate: string;
  readonly description: string;
}

const line = (id: string, offer: Offer, sku: string, usageType: string, unit: string, usd: number, effectiveDate: string, description: string): PriceLine => ({ id, offer, sku, usageType, unit, usd, effectiveDate, description });

const FM = "AmazonBedrockFoundationModels";
const TOKENS = "1M tokens";
const fm = (id: string, sku: string, kind: "input" | "output" | "cache_read" | "cache_write", usd: number, effectiveDate: string, model: string): PriceLine =>
  line(id, FM, sku, `USE1-MP:USE1_${kind}_tokens_global_standard-Units`, TOKENS, usd, effectiveDate, `${model} · ${kind.replace("_", " ")} tokens, Standard, Global`);

export type ModelUse = "agent" | "classifier" | "reader";
export type TokenKind = "input" | "output" | "cacheRead" | "cacheWrite";

/** Price-list model of each use, with the inference profile it is called through (infra/agentcore-spec.ts). */
export const MODEL_USES: Readonly<Record<ModelUse, { readonly modelId: string; readonly priceListModel: string }>> = {
  agent: { modelId: AGENT_MODEL_ID, priceListModel: "Claude Sonnet 5.5" },
  classifier: { modelId: CLASSIFIER_MODEL_ID, priceListModel: "Claude Haiku 5.5" },
  reader: { modelId: RECEIPT_MODEL_ID, priceListModel: "Claude Opus 5.5" },
};

export const modelLineId = (use: ModelUse, kind: TokenKind): string => `bedrock:${use}:${kind}`;

const MODEL_LINES: readonly PriceLine[] = [
  fm(modelLineId("agent", "input"), "PXMCKMF8EGSRB3GB", "input", 2, "2026-10-01T00:00:00Z", "Claude Sonnet 5.5"),
  fm(modelLineId("agent", "output"), "HP32J6RXJZ3XYFUM", "output", 10, "2026-10-01T00:00:00Z", "Claude Sonnet 5.5"),
  fm(modelLineId("agent", "cacheRead"), "487WBAJQRFHYFE5M", "cache_read", 0.1, "2026-10-01T00:00:00Z", "Claude Sonnet 5.5"),
  fm(modelLineId("agent", "cacheWrite"), "CES7A5M9YH89UF9G", "cache_write", 2.5, "2026-10-01T00:00:00Z", "Claude Sonnet 5.5"),
  fm(modelLineId("classifier", "input"), "CT2JY6DA5N94ZAXN", "input", 0.1, "2026-10-01T00:00:00Z", "Claude Haiku 5.5"),
  fm(modelLineId("classifier", "output"), "9C6E7ATQE23Q4W66", "output", 0.5, "2026-10-01T00:00:00Z", "Claude Haiku 5.5"),
  fm(modelLineId("classifier", "cacheRead"), "8FP5E8EDA6KXE8UU", "cache_read", 0.01, "2026-10-01T00:00:00Z", "Claude Haiku 5.5"),
  fm(modelLineId("classifier", "cacheWrite"), "CV39UEQ78VU65KM9", "cache_write", 0.125, "2026-10-01T00:00:00Z", "Claude Haiku 5.5"),
  fm(modelLineId("reader", "input"), "KVG5FBPDJPKF5TJY", "input", 4, "2026-09-01T00:00:00Z", "Claude Opus 5.5"),
  fm(modelLineId("reader", "output"), "MWH4TD2A4D5CEBAP", "output", 20, "2026-09-01T00:00:00Z", "Claude Opus 5.5"),
  fm(modelLineId("reader", "cacheRead"), "QT3QZUNUXV325ZDF", "cache_read", 0.2, "2026-09-01T00:00:00Z", "Claude Opus 5.5"),
  fm(modelLineId("reader", "cacheWrite"), "RVG5HJ3PZEQYVC74", "cache_write", 5, "2026-09-01T00:00:00Z", "Claude Opus 5.5"),
];

const GR_EFFECTIVE = "2026-10-01T00:00:00Z";
const guardrail = (id: string, sku: string, policy: string, usd: number): PriceLine =>
  line(id, "AmazonBedrock", sku, `USE1-Guardrail-${policy}`, "TextUnit", usd, GR_EFFECTIVE, `Guardrails ${policy} per text unit (1,000 characters)`);

/** G1: denied topics, PROMPT_ATTACK (a content filter) and the card number (a paid PII entity); the document regexes are free. G2: denied topics and contextual grounding. */
const GUARDRAIL_LINES: readonly PriceLine[] = [
  guardrail("guardrail:topic", "V3DRG4UQ9AK3UEHC", "TopicPolicyUnitsConsumed", 0.00015),
  guardrail("guardrail:content", "8Z4D5YJ9KP2G3SFM", "ContentPolicyUnitsConsumed", 0.00015),
  guardrail("guardrail:piiPaid", "BWGV6PGXE535JNYG", "SensitiveInformationPolicyPaidUnitsConsumed", 0.0001),
  guardrail("guardrail:regexFree", "FJTNJPU9V6NE9S4E", "SensitiveInformationPolicyFreeUnitsConsumed", 0),
  guardrail("guardrail:grounding", "ZKCCTPJXTF33WCT5", "ContextualGroundingPolicyUnitsConsumed", 0.0001),
];

const AC = "AmazonBedrockAgentCore";
const AC_EFFECTIVE = "2026-10-06T00:00:00Z";
const AGENTCORE_LINES: readonly PriceLine[] = [
  line("agentcore:gatewayInvocation", AC, "H8W62CM2CG5942WM", "USE1-Gateway:Consumption-based:API-Invocations", "Invocations", 0.000005, AC_EFFECTIVE, "Gateway tool invocation"),
  line("agentcore:memoryRetrieval", AC, "PG78QZJV6N4VECXA", "USE1-Memory:Consumption-based:Long-Term-Memory-Retrieval", "Memory-Retrieved", 0.0005, AC_EFFECTIVE, "Long-term memory record retrieved"),
  line("agentcore:memoryEvent", AC, "DKG82AWJVU98R6RZ", "USE1-Memory:Consumption-based:Short-Term-Memory", "Events", 0, AC_EFFECTIVE, "Short-term memory event"),
  line("agentcore:runtimeVcpu", AC, "XF44DNBTFC8XWPWU", "USE1-Runtime:Consumption-based:vCPU", "vCPU-Hours", 0.0895, AC_EFFECTIVE, "Runtime active vCPU-hour"),
  line("agentcore:runtimeMemory", AC, "H5Z74PWV6XHEN9JG", "USE1-Runtime:Consumption-based:Memory", "GB-Hours", 0.00945, AC_EFFECTIVE, "Runtime memory GB-hour"),
];

const SES_EFFECTIVE = "2026-07-01T00:00:00Z";
const SES_LINES: readonly PriceLine[] = [
  line("ses:recipient", "AmazonSES", "6M5WNQ7SQJYZPC9M", "Recipients", "Count", 0.0001, SES_EFFECTIVE, "Recipient of SendEmail or SendRawEmail"),
  line("ses:recipientMailboxSimulator", "AmazonSES", "JC3K5BCA3RUYRK6F", "USE1-Recipients-MailboxSim", "Count", 0.0001, SES_EFFECTIVE, "Recipient on the SES mailbox simulator"),
  line("ses:attachmentGb", "AmazonSES", "DWHMJ4MCRQ9VB6RK", "AttachmentsSize-Bytes", "GB", 0.12, SES_EFFECTIVE, "Attachments, per GB"),
];

const WA_EFFECTIVE = "2026-09-01T00:00:00Z";
const WHATSAPP_LINES: readonly PriceLine[] = [
  line("whatsapp:awsMessageAR", "AmazonPinpoint", "Y9373T6NMR3B7TUS", "USE1-WhatsApp-AR-MessageFee-Standard", "Messages", 0.005, WA_EFFECTIVE, "AWS End User Messaging Social fee per WhatsApp message, Argentina"),
  line("whatsapp:metaUtilityAR", "AWSEndUserMessaging3pFees", "WCQNZRYSHSENTRRB", "USE1-WhatsApp-AR-ConversationFee-Utility", "Messages", 0.0206, WA_EFFECTIVE, "Meta fee, utility template to Argentina"),
  line("whatsapp:metaServiceAR", "AWSEndUserMessaging3pFees", "ER3UY7T7GYJYKG72", "USE1-WhatsApp-AR-ConversationFee-Service", "Messages", 0, WA_EFFECTIVE, "Meta fee, service message to Argentina"),
];

export const PRICE_LINES: readonly PriceLine[] = [...MODEL_LINES, ...GUARDRAIL_LINES, ...AGENTCORE_LINES, ...SES_LINES, ...WHATSAPP_LINES];

/** Price of a line by id; throws on an unknown id so a typo never prices at zero. */
export function priceOf(id: string): number {
  const found = PRICE_LINES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no verified price line ${id}`);
  return found.usd;
}

/** USD per million tokens of a model use. */
export function modelRates(use: ModelUse): Readonly<Record<TokenKind, number>> {
  return { input: priceOf(modelLineId(use, "input")), output: priceOf(modelLineId(use, "output")), cacheRead: priceOf(modelLineId(use, "cacheRead")), cacheWrite: priceOf(modelLineId(use, "cacheWrite")) };
}
