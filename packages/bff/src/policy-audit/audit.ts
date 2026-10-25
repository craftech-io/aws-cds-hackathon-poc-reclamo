// `policy_audit` (docs/architecture.md §12, docs/tool-catalog.md `policyAudit.run`, FL-075): the four
// checks of policy-audit/types.ts over one world's current epoch, daily and on demand. Every outbound
// message that may have reached the customer (and every email the world sent) is checked against the
// tape and the policy of its instant; every imputation against the settlement line it rests on; the
// three chains against their anchors. A message or complaint whose audit fails is logged and counted,
// never ends the run. It reads no message body into a log line, and it writes only `AuditLog`.
import { ToolError } from "@reclamo/shared";
import { loadHolidays } from "../complaints/sla";
import type { Complaint } from "../domain/complaint";
import type { EmailRecord, Message } from "../domain/conversation";
import type { CustomerFacts } from "../outbound/deps";
import { auditChains } from "./chains";
import { type ConversationFacts, WENT_OUT, type WorldFacts, conversationCustomers, loadConversation, worldComplaints } from "./facts";
import { imputationFindings } from "./imputations";
import { reevaluationFinding, tapeFinding } from "./outbound";
import { type Finding, violationRecorder } from "./record";
import type { ChainSummary, ChainWarning, PolicyAuditDeps, PolicyAuditReport, Violation } from "./types";

export const POLICY_AUDIT_FAILED_LOG = "policy_audit.item_failed";

export interface PolicyAuditScope {
  readonly worldId: string;
}

/** The core's customer once per run (consent and loans); a core failure leaves the facts out. */
function customerCache(deps: PolicyAuditDeps, worldId: string) {
  const cache = new Map<string, Promise<CustomerFacts | undefined>>();
  return (customerId: string, simNow: string): Promise<CustomerFacts | undefined> => {
    const reader = deps.customers;
    if (reader === undefined) return Promise.resolve(undefined);
    let found = cache.get(customerId);
    if (found === undefined) {
      found = reader.get(worldId, customerId, new Date(simNow), deps.log.correlationId).catch((error: unknown) => {
        deps.log.warn("policy_audit.customer_unavailable", { worldId, errorName: error instanceof Error ? error.name : "unknown" });
        return undefined;
      });
      cache.set(customerId, found);
    }
    return found;
  };
}

function latestInstant(messages: readonly Message[], fallback: string): string {
  return messages.reduce((latest, message) => (Date.parse(message.atSim) > Date.parse(latest) ? message.atSim : latest), fallback);
}

async function messageFindings(deps: PolicyAuditDeps, conversation: ConversationFacts, message: Message, world: WorldFacts): Promise<Finding[]> {
  const entries = await deps.connector.chains.listTapeByMessage(message.messageId);
  return [tapeFinding(message, entries), reevaluationFinding(conversation, message, world)].filter((finding): finding is Finding => finding !== undefined);
}

/** An email the world sent must belong to a message the gate allowed. */
async function emailFinding(deps: PolicyAuditDeps, email: EmailRecord): Promise<Finding | undefined> {
  const entries = email.messageId === undefined ? [] : await deps.connector.chains.listTapeByMessage(email.messageId);
  const allowed = entries.some((entry) => entry.worldId === email.worldId && entry.decision === "ALLOWED" && entry.messageId === email.messageId);
  if (allowed) return undefined;
  return {
    check: "TAPE_ALLOWED",
    key: `TAPE_ALLOWED#MAIL#${email.mailId}`,
    ruleIds: [],
    reason: "NO_ALLOWED",
    refs: { mailId: email.mailId, customerId: email.customerId, kind: email.kind, ...(email.messageId === undefined ? {} : { messageId: email.messageId }), ...(email.complaintId === undefined ? {} : { complaintId: email.complaintId }) },
    atSim: email.sentAtSim,
    ...(email.complaintId === undefined ? {} : { primaryRef: `CMP#${email.complaintId}` }),
  };
}

async function worldEmails(deps: PolicyAuditDeps, worldId: string): Promise<EmailRecord[]> {
  const all: EmailRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.connector.emails.listWorld(worldId, { limit: 200, ...(cursor ? { cursor } : {}) });
    all.push(...page.emails);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

interface Tally {
  messages: number;
  imputations: number;
  failed: number;
  readonly findings: Finding[];
}

function failed(deps: PolicyAuditDeps, tally: Tally, item: string, error: unknown): void {
  tally.failed += 1;
  deps.log.error(POLICY_AUDIT_FAILED_LOG, { item, errorName: error instanceof Error ? error.name : "unknown" });
}

async function auditConversations(deps: PolicyAuditDeps, world: WorldFacts, worldId: string, customer: ReturnType<typeof customerCache>, tally: Tally): Promise<void> {
  const fallback = deps.now().toISOString();
  for (const customerId of await conversationCustomers(deps.connector, worldId)) {
    let conversation: ConversationFacts;
    try {
      conversation = await loadConversation(deps.connector, worldId, customerId, (messages) => customer(customerId, latestInstant(messages, fallback)));
    } catch (error) {
      failed(deps, tally, "conversation", error);
      continue;
    }
    for (const message of conversation.messages) {
      if (message.direction !== "OUT" || !WENT_OUT.has(message.status)) continue;
      tally.messages += 1;
      try {
        tally.findings.push(...(await messageFindings(deps, conversation, message, world)));
      } catch (error) {
        failed(deps, tally, "message", error);
      }
    }
  }
  for (const email of await worldEmails(deps, worldId)) {
    try {
      const finding = await emailFinding(deps, email);
      if (finding !== undefined) tally.findings.push(finding);
    } catch (error) {
      failed(deps, tally, "email", error);
    }
  }
}

async function auditImputations(deps: PolicyAuditDeps, complaints: readonly Complaint[], customer: ReturnType<typeof customerCache>, tally: Tally): Promise<void> {
  for (const complaint of complaints) {
    try {
      const file = await deps.connector.caseItems.caseFile(complaint.worldId, complaint.complaintId);
      const facts = await customer(complaint.customerId, complaint.filedAtSim);
      const { checked, findings } = imputationFindings(complaint, file, facts);
      tally.imputations += checked;
      tally.findings.push(...findings);
    } catch (error) {
      failed(deps, tally, "complaint", error);
    }
  }
}

/** Runs the four checks over the world's current epoch and records every finding once. */
export async function runPolicyAudit(deps: PolicyAuditDeps, scope: PolicyAuditScope): Promise<PolicyAuditReport> {
  const { worldId } = scope;
  const meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
  const settings = await deps.connector.worlds.getSettings(worldId);
  if (meta === undefined || settings === undefined) throw new ToolError("NOT_FOUND", "world not found");
  const { epoch } = meta;
  const complaints = await worldComplaints(deps.connector, worldId);
  const world: WorldFacts = { settings, holidays: await loadHolidays(deps.connector), complaints: new Map(complaints.map((complaint) => [complaint.complaintId, complaint])) };
  const customer = customerCache(deps, worldId);
  const tally: Tally = { messages: 0, imputations: 0, failed: 0, findings: [] };

  await auditConversations(deps, world, worldId, customer, tally);
  await auditImputations(deps, complaints, customer, tally);
  const chains: ChainSummary[] = [];
  const warnings: ChainWarning[] = [];
  for (const outcome of await auditChains(deps, worldId, epoch)) {
    chains.push(outcome.summary);
    if (outcome.warning) warnings.push(outcome.warning);
    if (outcome.finding) tally.findings.push(outcome.finding);
  }
  for (const warning of warnings) deps.log.warn("policy_audit.chain_partial", { worldId, chain: warning.chain, unanchored: warning.unanchored.length });

  const recorder = await violationRecorder(deps, worldId, epoch);
  const violations: Violation[] = [];
  for (const finding of tally.findings) violations.push(await recorder.record(finding));
  deps.log.info("policy_audit.done", { worldId, epoch, messagesChecked: tally.messages, imputationsChecked: tally.imputations, failed: tally.failed, violations: violations.length, warnings: warnings.length });
  return { worldId, epoch, messagesChecked: tally.messages, imputationsChecked: tally.imputations, chains, warnings, failed: tally.failed, violations };
}
