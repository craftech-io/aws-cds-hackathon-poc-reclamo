// Reads and writes of the `Leads` table over the connector's storage port, so DynamoDB and the memory
// engine run the same conditions. Each method is one of the accesses of docs/architecture-guests.md
// §12: the Bff never reads a lead (`GetItem`/`Query` on `LEAD#` are not in its policy), it only
// repairs one with a conditional put and stamps the last sign-in; the triggers and the notifier read.
import { ConnectorError } from "@reclamo/shared";
import { type RepoContext, decode, decodeOptional, encode } from "../connector/codec";
import type { Condition, StoredItem, WriteOp } from "../connector/store";
import { cond } from "../connector/store";
import { type QaScope, leadsKeys, signupAuditPartition } from "./keys";
import { LEADS_TTL_SECONDS, expiresAt } from "./limits";
import { CanonCounter, Lead, PendingPointer, SignupRequest, type SignupStatus } from "./records";

const TABLE = "Leads" as const;

/** The states a request can still be confirmed or replaced from. */
const LIVE_STATUSES: readonly SignupStatus[] = ["STARTED", "CODE_SENT"];

const qaOf = (request: Pick<SignupRequest, "qa">): QaScope | undefined => request.qa;

export function leadsRepo(ctx: RepoContext) {
  const signupItem = (request: SignupRequest): StoredItem =>
    encode(request, {
      entity: "SignupRequest",
      key: leadsKeys.signup(request.signupId, qaOf(request)),
      now: ctx.now(),
      indexes: { emailHashKey: leadsKeys.emailHashKey(request.emailHash), subKey: request.sub ? leadsKeys.subKey(request.sub) : undefined },
    });

  const setStatusOp = (request: SignupRequest, to: SignupStatus, from: readonly SignupStatus[], extra: Record<string, unknown> = {}, condition?: Condition): WriteOp => ({
    kind: "update",
    table: TABLE,
    key: leadsKeys.signup(request.signupId, qaOf(request)),
    condition: cond.and(cond.present(), cond.in("status", from), ...(condition ? [condition] : [])),
    update: { set: { status: to, updatedAt: ctx.now().toISOString(), ...extra } },
  });

  return {
    async getSignup(signupId: string, qa?: QaScope): Promise<SignupRequest | undefined> {
      return decodeOptional(SignupRequest, await ctx.store.get(TABLE, leadsKeys.signup(signupId, qa), { consistent: true }), TABLE);
    },

    async currentSignupId(emailHash: string, qa?: QaScope): Promise<string | undefined> {
      return decodeOptional(PendingPointer, await ctx.store.get(TABLE, leadsKeys.pending(emailHash, qa), { consistent: true }), TABLE)?.signupId;
    },

    async confirmedAccounts(canonHash: string): Promise<number> {
      return decodeOptional(CanonCounter, await ctx.store.get(TABLE, leadsKeys.canon(canonHash), { consistent: true }), TABLE)?.confirmed ?? 0;
    },

    /**
     * A new request becomes the only one of its email: the request (`STARTED`, never over another),
     * the pointer, and the previous request as `SUPERSEDED` while it is still live, in one
     * transaction. A previous request that is already over (abandoned, superseded, confirmed) is left
     * as it is; one that ended between the read and the write is re-read once.
     */
    async start(request: SignupRequest, previous: SignupRequest | undefined): Promise<void> {
      const now = ctx.now();
      const ttl = { expiresAt: expiresAt(now, LEADS_TTL_SECONDS.signupRequest) };
      const pointer = encode({ signupId: request.signupId }, { entity: "PendingSignup", key: leadsKeys.pending(request.emailHash, qaOf(request)), now });
      const write = (before: SignupRequest | undefined) => {
        const ops: WriteOp[] = [
          { kind: "put", table: TABLE, item: { ...signupItem(request), ...ttl }, condition: cond.absent() },
          { kind: "put", table: TABLE, item: { ...pointer, ...ttl } },
        ];
        if (before && before.signupId !== request.signupId && LIVE_STATUSES.includes(before.status)) ops.push(setStatusOp(before, "SUPERSEDED", LIVE_STATUSES));
        return ctx.store.transact(ops);
      };
      try {
        await write(previous);
      } catch (error) {
        if (!(previous && error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
        await write(decodeOptional(SignupRequest, await ctx.store.get(TABLE, leadsKeys.signup(previous.signupId, qaOf(previous)), { consistent: true }), TABLE));
      }
    },

    /** `SignUp` answered: the request carries its `sub` and the world the confirmation registers. */
    async codeSent(request: SignupRequest, sub: string, worldId: string): Promise<void> {
      await ctx.store.write(setStatusOp(request, "CODE_SENT", ["STARTED"], { sub, worldId, subKey: leadsKeys.subKey(sub) }));
    },

    async abandon(request: SignupRequest): Promise<void> {
      try {
        await ctx.store.write(setStatusOp(request, "ABANDONED", LIVE_STATUSES));
      } catch (error) {
        if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
      }
    },

    /** The confirmation of this request, for `register` (only while it is `CODE_SENT` with this `sub`). */
    confirmOp(request: SignupRequest, sub: string): WriteOp {
      return setStatusOp(request, "CONFIRMED", ["CODE_SENT"], {}, cond.eq("sub", sub));
    },

    /** The lead, written once (the trigger and the Bff's repair race; one of them wins). */
    putLeadOp(lead: Lead): WriteOp {
      const now = ctx.now();
      const item = encode(lead, {
        entity: "Lead",
        key: leadsKeys.lead(lead.sub, lead.qa),
        now,
        indexes: { emailHashKey: leadsKeys.emailHashKey(lead.emailHash), subKey: leadsKeys.subKey(lead.sub) },
      });
      return { kind: "put", table: TABLE, item: { ...item, expiresAt: expiresAt(now, LEADS_TTL_SECONDS.lead) }, condition: cond.absent() };
    },

    canonOp(canonHash: string): WriteOp {
      return { kind: "update", table: TABLE, key: leadsKeys.canon(canonHash), update: { add: { confirmed: 1 }, set: { entity: "CanonCounter", updatedAt: ctx.now().toISOString() } } };
    },

    /** Trigger and notifier only (the Bff's policy has no `GetItem` on `LEAD#`). */
    async getLead(sub: string, qa?: QaScope): Promise<Lead | undefined> {
      return decodeOptional(Lead, await ctx.store.get(TABLE, leadsKeys.lead(sub, qa), { consistent: true }), TABLE);
    },

    /** The world of a lead, reading only `worldId` (the pre-token trigger's IAM allows nothing else). */
    async leadWorldId(sub: string, qa?: QaScope): Promise<string | undefined> {
      const item = await ctx.store.get(TABLE, leadsKeys.lead(sub, qa), { consistent: true, attributes: ["pk", "sk", "worldId"] });
      const worldId = item?.worldId;
      return typeof worldId === "string" ? worldId : undefined;
    },

    /** First call of a session: the last sign-in, and the retention counted again from it (a QA lead under its scope). */
    async touchSignIn(sub: string, qa?: QaScope): Promise<boolean> {
      const now = ctx.now();
      try {
        await ctx.store.write({
          kind: "update",
          table: TABLE,
          key: leadsKeys.lead(sub, qa),
          condition: cond.present(),
          update: { set: { lastLoginAtReal: now.toISOString(), updatedAt: now.toISOString(), expiresAt: expiresAt(now, LEADS_TTL_SECONDS.lead) } },
        });
        return true;
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
        throw error;
      }
    },

    /** Claims the one notice of a lead; false when another run already took it. */
    async claimNotice(sub: string): Promise<boolean> {
      const now = ctx.now().toISOString();
      try {
        await ctx.store.write({ kind: "update", table: TABLE, key: leadsKeys.lead(sub), condition: cond.and(cond.present(), cond.notExists("notifiedAtReal")), update: { set: { notifiedAtReal: now, updatedAt: now } } });
        return true;
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
        throw error;
      }
    },

    /** Gives the claim back after a failed send, so the asynchronous retry can send it. */
    async releaseNotice(sub: string): Promise<void> {
      await ctx.store.write({ kind: "update", table: TABLE, key: leadsKeys.lead(sub), condition: cond.present(), update: { remove: ["notifiedAtReal"] } });
    },

    decodeLead: (item: StoredItem): Lead => decode(Lead, item, TABLE),
  };
}

export type LeadsRepo = ReturnType<typeof leadsRepo>;

/** An audit entry of the public edge that belongs to no world: codes and hashes only, never an email. */
export interface EdgeAuditEntry {
  readonly action: "SIGNUP_REJECTED" | "SIGNUP_SWITCHED" | "LEAD_NOTICE_SENT" | "LEAD_NOTICE_SKIPPED" | "LEAD_NOTICE_PROBE" | "LEAD_NOTICE_TEST" | "LEAD_DELETED" | "EDGE_REQUIRED";
  readonly outcome: string;
  readonly refs: Readonly<Record<string, string>>;
  /** An entry of the scenario runner: `SIGNUP#AUD#QA#<yyyy-mm>`, apart from every visitor's. */
  readonly qa?: boolean;
}

/** `AuditLog`, partition `SIGNUP#AUD#[QA#]<yyyy-mm>`: put-only, like every audit entry. */
export function edgeAuditOp(entry: EdgeAuditEntry, auditId: string, now: Date): WriteOp {
  const ts = now.toISOString();
  const item = { pk: signupAuditPartition(now, entry.qa === true), sk: `${ts}#${auditId}`, entity: "Decision", auditId, ts, actor: "SYSTEM", action: entry.action, outcome: entry.outcome, refs: { ...entry.refs }, createdAt: ts, expiresAt: expiresAt(now, 365 * 24 * 3_600) };
  return { kind: "put", table: "AuditLog", item, condition: cond.absent() };
}
