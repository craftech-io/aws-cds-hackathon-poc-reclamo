// The seven Gateway targets and their 28 tools (docs/tool-catalog.md, docs/architecture.md §9.2): one
// Lambda per target, each tool named `<target>___<tool>` in the Gateway and in Cedar. Pure on purpose
// (zod only): the SST program (infra/agent-tool-schemas.ts, infra/policy-rules.ts) reads it too.
import { z } from "zod";

export const ToolTarget = z.enum(["identity", "account", "investigation", "actions", "complaints", "messaging", "handoff"]);
export type ToolTarget = z.infer<typeof ToolTarget>;

/** The tools of every target, in the order docs/tool-catalog.md lists them. */
export const GATEWAY_TOOLS = {
  identity: ["identify_customer", "verify_challenge"],
  account: ["get_account", "list_operations", "get_loan", "get_instalments", "get_fee_rules", "get_terms", "quote_early_payoff"],
  investigation: ["read_receipt", "reconcile_payment", "check_charge", "check_duplicate_debit", "get_transfer_status", "get_disbursement"],
  actions: ["apply_payment", "reverse_charge", "refund_duplicate_debit", "request_transfer_reversal", "freeze_outgoing", "request_account_closure", "request_data_change"],
  complaints: ["register_complaint", "update_complaint", "answer_complaint_in_writing"],
  messaging: ["send_whatsapp"],
  handoff: ["escalate_to_human", "request_operator_approval"],
} as const satisfies { readonly [T in ToolTarget]: readonly string[] };

export type TargetToolName<T extends ToolTarget> = (typeof GATEWAY_TOOLS)[T][number];
export type GatewayToolName = TargetToolName<ToolTarget>;

export const EXPECTED_TOOL_COUNT = 28;

/** Separator of `<target>___<tool>`, the name the Gateway and Cedar give a tool. */
export const GATEWAY_TOOL_SEPARATOR = "___";

/** `<target>___<tool>`: the Gateway tool name and the Cedar action. */
export function gatewayActionOf(target: ToolTarget, tool: string): string {
  return `${target}${GATEWAY_TOOL_SEPARATOR}${tool}`;
}

/** The target that owns a tool, or `undefined` for a name no target declares. */
export function targetOf(tool: string): ToolTarget | undefined {
  return ToolTarget.options.find((target) => (GATEWAY_TOOLS[target] as readonly string[]).includes(tool));
}

/** Cedar statements that read a field of a tool input (docs/design-brief.md §8.6). */
export type CedarStatementId = "CED-NO-SELF-APPROVAL" | "CED-NO-CAP-OVERRIDE" | "CED-ATTACHMENTS-ALLOWLIST" | "CED-WA-KIND-ALLOWLIST";

/** The Lambda fences of docs/design-brief.md §8.6 that the common wrapper enforces. */
export const LAM_RULE = {
  STRICT: "LAM-STRICT",
  SCOPE: "LAM-SCOPE",
  IDENTIFIED: "LAM-IDENTIFIED",
  COMPLAINT_REQUIRED: "LAM-COMPLAINT-REQUIRED",
  CONTROL: "LAM-CONTROL",
  ONCE_PER_EVENT: "LAM-ONCE-PER-EVENT",
  CALLER: "LAM-CALLER",
} as const;
export type LamRule = (typeof LAM_RULE)[keyof typeof LAM_RULE];
