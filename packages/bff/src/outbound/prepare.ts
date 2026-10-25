// Steps 2 to 4 of the gate (docs/architecture-integrations.md §4): render, G2 and the deterministic
// verification, on what the customer will read. G2 runs only over free text an agent or an operator
// wrote (a template or a text of copy/ never reaches it); the verification runs over every rendered
// message. A failure answers the rule that stopped it (`G2`, `VERIFY` or a `CH-*` content rule) and,
// for G2, the reason and the scores the gate logs and audits; never the text itself.
import { type ErrorCode, ToolError } from "@reclamo/shared";
import { senderClassOf } from "../channel-policy/kinds";
import { STAGE_DOMAIN } from "../channel-policy/types";
import type { CollectionCategory } from "../copy/types";
import type { Logger } from "../lib/log";
import { type SendContext, lastCustomerText } from "./context";
import type { DebtDetail, OutboundDeps } from "./deps";
import { type G2Verdict, GuardrailUnavailableError, groundingSourceOf } from "./g2";
import { g2Query } from "./g2-query";
import { type EmailDraft, renderEmail } from "./render/email";
import { type WhatsAppDraft, renderWhatsApp } from "./render/whatsapp";
import { complaintFactsOf } from "./template-grounding";
import { GATE_REASON, GATE_RULE, type OutboundRequest } from "./types";
import { failureCodeOf, verifyOutbound } from "./verify";

/** Grounding source limit of `GuardrailG2` (infra/guardrail-policies.ts `G2_LIMITS`). */
const GROUNDING_SOURCE_MAX_CHARS = 100_000;

export type Prepared =
  | { readonly channel: "WHATSAPP"; readonly draft: WhatsAppDraft; readonly rendered: string }
  | { readonly channel: "EMAIL"; readonly draft: EmailDraft; readonly rendered: string };

export interface ContentRefusal {
  readonly ok: false;
  readonly ruleIds: readonly string[];
  readonly code: ErrorCode;
  readonly reason: string;
  readonly message: string;
  readonly g2?: G2Verdict;
  readonly categories?: readonly CollectionCategory[];
}

export type ContentOutcome = { readonly ok: true; readonly prepared: Prepared; readonly g2?: G2Verdict } | ContentRefusal;

export interface PrepareOptions {
  /** Prepend the automation disclosure (render/disclosure.ts decides). */
  readonly disclose: boolean;
  readonly debt?: DebtDetail;
  /** A deferred message whose content was checked when it was deferred, unchanged since. */
  readonly checked?: boolean;
}

function render(request: OutboundRequest, ctx: SendContext, options: PrepareOptions): Prepared {
  if (request.channel === "WHATSAPP") {
    const draft = renderWhatsApp({ request, senderClass: senderClassOf(request.sender), disclose: options.disclose, loans: ctx.customer?.loans ?? [] });
    return { channel: "WHATSAPP", draft, rendered: draft.text };
  }
  if (ctx.customer === undefined) throw new ToolError("UNAVAILABLE", "the core did not return the customer", GATE_REASON.NO_RECIPIENT);
  const draft = renderEmail({
    kind: request.kind,
    ...(request.text === undefined ? {} : { text: request.text }),
    firstName: ctx.customer.firstName,
    ...(ctx.complaint === undefined ? {} : { complaintNumber: ctx.complaint.complaintNumber }),
    ...(options.debt === undefined ? {} : { debt: options.debt }),
  });
  return { channel: "EMAIL", draft, rendered: `${draft.subject}\n\n${draft.text}` };
}

/** The words a person or the agent wrote; a template's parameters are checked apart, copy/ is trusted. */
function freeTextOf(request: OutboundRequest, prepared: Prepared): string | undefined {
  if (request.sender === "SYSTEM") return undefined;
  if (prepared.channel === "EMAIL") return prepared.draft.freeText;
  return request.template === undefined ? request.text?.trim() : undefined;
}

/** A `REPLY` that states figures and a written answer are grounded against the turn (§9.4). */
function grounded(request: OutboundRequest, freeText: string): boolean {
  return request.kind === "FORMAL_ANSWER" || (request.kind === "REPLY" && /\d/.test(freeText));
}

/** What grounds the agent's text: this turn's tool results, then what the message's complaint already proved. */
function groundingResults(ctx: SendContext): readonly unknown[] {
  return [...ctx.turnResults, ...(ctx.caseFacts ?? [])];
}

/** G2's grounding source: the same, plus the message's complaint number and deadline (verify.ts adds them too). */
function g2Source(ctx: SendContext): string {
  return groundingSourceOf([...groundingResults(ctx), ...complaintFactsOf(ctx.complaint)], GROUNDING_SOURCE_MAX_CHARS);
}

async function checkG2(deps: OutboundDeps, request: OutboundRequest, ctx: SendContext, freeText: string, log: Logger): Promise<ContentRefusal | { readonly verdict: G2Verdict }> {
  const grounding = grounded(request, freeText) ? { source: g2Source(ctx), query: g2Query(lastCustomerText(ctx)) } : undefined;
  let verdict: G2Verdict;
  try {
    verdict = await deps.guardrail.check({ kind: request.kind, text: freeText, ...(grounding === undefined ? {} : { grounding }) });
  } catch (error) {
    if (!(error instanceof GuardrailUnavailableError)) throw error;
    log.error("outbound.g2_unavailable", { kind: request.kind });
    return { ok: false, ruleIds: [GATE_RULE.G2], code: "UNAVAILABLE", reason: GATE_REASON.GUARDRAIL_UNAVAILABLE, message: "the output guardrail is not available; try again later" };
  }
  if (verdict.action === "NONE") return { verdict };
  const scores = { ...(verdict.groundingScore === undefined ? {} : { groundingScore: verdict.groundingScore }), ...(verdict.relevanceScore === undefined ? {} : { relevanceScore: verdict.relevanceScore }) };
  log.warn("outbound.g2_refused", { kind: request.kind, reason: verdict.failure ?? "BLOCKED", grounded: grounding !== undefined, ...scores });
  const policy = verdict.failure === "BLOCKED";
  return {
    ok: false,
    ruleIds: [GATE_RULE.G2],
    code: policy ? "POLICY_DENIED" : "GROUNDING_FAIL",
    reason: policy ? "G2_DENIED_TOPIC" : GATE_REASON.GROUNDING_FAIL,
    message: policy ? "the output guardrail denied the text" : "the text is not grounded in this turn's tool results: use only values a tool returned, or escalate",
    g2: verdict,
  };
}

/** Render, G2 and the verification of one request. */
export async function prepareContent(deps: OutboundDeps, request: OutboundRequest, ctx: SendContext, options: PrepareOptions, log: Logger): Promise<ContentOutcome> {
  const prepared = render(request, ctx, options);
  if (options.checked === true) return { ok: true, prepared };
  const freeText = freeTextOf(request, prepared);
  let g2: G2Verdict | undefined;
  if (freeText !== undefined && freeText !== "") {
    const checked = await checkG2(deps, request, ctx, freeText, log);
    if ("ok" in checked) return checked;
    g2 = checked.verdict;
  }
  const failures = verifyOutbound({
    channel: request.channel,
    kind: request.kind,
    senderClass: senderClassOf(request.sender),
    rendered: prepared.rendered,
    ...(freeText === undefined ? {} : { freeText }),
    ...(request.template === undefined ? {} : { template: request.template }),
    results: groundingResults(ctx),
    ...(ctx.complaint === undefined ? {} : { complaint: { complaintNumber: ctx.complaint.complaintNumber, deadlineSim: ctx.complaint.deadlineSim } }),
    stageDomains: [STAGE_DOMAIN],
  });
  if (failures.length === 0) return { ok: true, prepared, ...(g2 === undefined ? {} : { g2 }) };
  const [first] = failures;
  const categories = [...new Set(failures.flatMap((failure) => failure.categories ?? []))];
  log.warn("outbound.verify_refused", { kind: request.kind, checks: failures.map((failure) => failure.check) });
  return {
    ok: false,
    ruleIds: [...new Set(failures.map((failure) => failure.ruleId))],
    code: failureCodeOf(failures),
    reason: first?.code === "GROUNDING_FAIL" ? GATE_REASON.GROUNDING_FAIL : (first?.ruleId ?? GATE_RULE.VERIFY),
    message: failures.map((failure) => failure.detail).join("; ").slice(0, 900),
    ...(categories.length === 0 ? {} : { categories }),
    ...(g2 === undefined ? {} : { g2 }),
  };
}
