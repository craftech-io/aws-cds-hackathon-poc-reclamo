// `LAM-SCOPE` (docs/design-brief.md §8.6, docs/tool-catalog.md "Sesión"): the customer, the world and
// the complaints come from the session of the turn, never from what the model wrote, and no id of the
// input is accepted unless it belongs to them. Every id field is declared with what it must belong to
// (`ToolDefinition.scoped`); fences.test.ts checks that no id field of the 28 tools is left undeclared.
//
//   COMPLAINT    a complaint of the session, of the session's customer
//   EVIDENCE     an evidence (by `evidenceId` or by the id a tool returned for it) of one of those
//   MESSAGE      an inbound message of the customer's conversation
//   NONCE        a button nonce issued to the customer
//   LOAN, CHARGE, TRANSFER, MOVEMENT   what the core says is the customer's (`CoreOwnership`)
//   BUTTON_REF   a complaint of the session or a loan of the customer
import type { Complaint } from "../../domain/complaint";
import type { Evidence } from "../../domain/case-items";
import type { Connector } from "../../connector/port";
import type { ScopeKind } from "./define";
import type { ToolSession } from "./principal";

/** Ownership the simulated core answers for the session's customer (wired to the core client by the targets). */
export interface CoreOwnership {
  owns(kind: "LOAN" | "CHARGE" | "TRANSFER" | "MOVEMENT", ref: { readonly worldId: string; readonly customerId: string; readonly id: string }): Promise<boolean>;
}

export interface ScopedRef {
  readonly kind: ScopeKind;
  readonly value: string;
  /** Where it was found (`buttons.1.ref`); ids are not personal data, so the audit may carry it. */
  readonly path: string;
}

/** What the scope check found about the input, for the fences after it. */
export interface ScopeFindings {
  /** Complaints the input named, directly or through one of their evidences. */
  readonly complaintIds: readonly string[];
  readonly evidence: readonly Evidence[];
}

export type ScopeCheck = { readonly ok: true; readonly findings: ScopeFindings } | { readonly ok: false; readonly ref: ScopedRef; readonly why: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every string at a declared path of the (already parsed, bounded) input. */
export function scopedRefsOf(input: Readonly<Record<string, unknown>>, scoped: Readonly<Record<string, ScopeKind>>): ScopedRef[] {
  const refs: ScopedRef[] = [];
  for (const [path, kind] of Object.entries(scoped)) {
    const visit = (value: unknown, segments: readonly string[], at: string): void => {
      if (segments.length === 0) {
        if (typeof value === "string") refs.push({ kind, value, path: at });
        else if (Array.isArray(value)) value.forEach((item, index) => typeof item === "string" && refs.push({ kind, value: item, path: `${at}.${index}` }));
        return;
      }
      const [head = "", ...rest] = segments;
      if (head === "[]") {
        if (Array.isArray(value)) value.forEach((item, index) => visit(item, rest, `${at}.${index}`));
        return;
      }
      if (isRecord(value) && value[head] !== undefined) visit(value[head], rest, at === "" ? head : `${at}.${head}`);
    };
    const segments = path.split(".").flatMap((part) => (part.endsWith("[]") ? [part.slice(0, -2), "[]"] : [part]));
    visit(input, segments, "");
  }
  return refs;
}

/** Reads the scope needs: complaints and evidences of the session, the conversation, the core. */
export interface ScopeLookups {
  complaint(worldId: string, complaintId: string): Promise<Complaint | undefined>;
  evidenceOf(worldId: string, complaintId: string): Promise<readonly Evidence[]>;
  isInboundMessage(worldId: string, customerId: string, messageId: string): Promise<boolean>;
  isNonceOf(worldId: string, customerId: string, nonce: string): Promise<boolean>;
  readonly core: CoreOwnership;
}

export function connectorLookups(connector: Connector, core: CoreOwnership): ScopeLookups {
  return {
    complaint: (worldId, complaintId) => connector.complaints.get(worldId, complaintId, { consistent: true }),
    evidenceOf: (worldId, complaintId) => connector.caseItems.listEvidence(worldId, complaintId),
    isInboundMessage: async (worldId, customerId, messageId) => (await connector.conversations.findMessage(worldId, customerId, messageId))?.direction === "IN",
    isNonceOf: async (worldId, customerId, nonce) => (await connector.claims.getNonce(worldId, nonce))?.customerId === customerId,
    core,
  };
}

/** Checks every declared id of the input against the session; the first that does not belong stops it. */
export async function checkScope(session: ToolSession, input: Readonly<Record<string, unknown>>, scoped: Readonly<Record<string, ScopeKind>>, lookups: ScopeLookups): Promise<ScopeCheck> {
  const { worldId, customerId } = session;
  const complaintIds = new Set<string>();
  const evidence: Evidence[] = [];
  const ownComplaint = async (id: string): Promise<boolean> => {
    if (!session.complaintIds.includes(id)) return false;
    return (await lookups.complaint(worldId, id))?.customerId === customerId;
  };
  let evidenceCache: Evidence[] | undefined;
  const sessionEvidence = async (): Promise<Evidence[]> => {
    evidenceCache ??= (await Promise.all(session.complaintIds.map((id) => lookups.evidenceOf(worldId, id)))).flat();
    return evidenceCache;
  };

  for (const ref of scopedRefsOf(input, scoped)) {
    let why: string | undefined;
    switch (ref.kind) {
      case "COMPLAINT":
        if (await ownComplaint(ref.value)) complaintIds.add(ref.value);
        else why = "is not a complaint of this session";
        break;
      case "EVIDENCE": {
        const found = (await sessionEvidence()).find((item) => item.evidenceId === ref.value || item.refId === ref.value);
        if (found !== undefined && (await ownComplaint(found.complaintId))) {
          complaintIds.add(found.complaintId);
          evidence.push(found);
        } else why = "is not an evidence of a complaint of this session";
        break;
      }
      case "MESSAGE":
        if (!(await lookups.isInboundMessage(worldId, customerId, ref.value))) why = "is not a message of this customer";
        break;
      case "NONCE":
        if (!(await lookups.isNonceOf(worldId, customerId, ref.value))) why = "is not a button of this customer";
        break;
      case "BUTTON_REF":
        if (await ownComplaint(ref.value)) complaintIds.add(ref.value);
        else if (!(await lookups.core.owns("LOAN", { worldId, customerId, id: ref.value }))) why = "is neither a complaint of this session nor a loan of this customer";
        break;
      default:
        if (!(await lookups.core.owns(ref.kind, { worldId, customerId, id: ref.value }))) why = `is not a ${ref.kind.toLowerCase()} of this customer`;
    }
    if (why !== undefined) return { ok: false, ref, why };
  }
  return { ok: true, findings: { complaintIds: [...complaintIds], evidence } };
}
