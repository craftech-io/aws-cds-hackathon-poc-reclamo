// The part of a template that lives in the BFF's own tables, written through the connector's
// repositories (so every index the console and the worker query exists) as the world factory writes
// it (docs/seed-spec.md §15): complaints and their evidence, actions and approvals as the template
// has them, the three hash chains appended in `seq` order by the real chain code (complaints/register.ts
// `appendChained`, so the hashes are recomputed with the local `RegisterChainKey` and the heads end where
// the template's do), the audit entries, the complaint counter, the timers, the conversations and the
// paused clock.
import type { NewOf } from "@reclamo/bff/connector/codec";
import type { Connector } from "@reclamo/bff/connector/port";
import type { ComplaintsDeps } from "@reclamo/bff/complaints/deps";
import { type ChainBody, appendChained } from "@reclamo/bff/complaints/register";
import type { Action, Approval, Evidence } from "@reclamo/bff/domain/case-items";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import type { ConversationMeta, Message } from "@reclamo/bff/domain/conversation";
import type { AuditEntry } from "@reclamo/bff/domain/ledger";
import type { Timer } from "@reclamo/bff/domain/timer";
import type { StoredClock } from "@reclamo/bff/domain/runtime";
import type { TemplateItem } from "../../../scripts/seed/lib/template";

type Chain = "REG" | "RRI" | "TAPE";

const CHAIN_OF: Readonly<Record<string, Chain>> = { RegisterEntry: "REG", RefundEntry: "RRI", TapeEntry: "TAPE" };
/** What the chain decides itself: never copied from the template. */
const CHAIN_FIELDS = new Set(["worldId", "epoch", "seq", "prevHash", "hash", "createdAt", "updatedAt", "synthetic"]);

function of(items: readonly TemplateItem[], entity: string): Record<string, unknown>[] {
  return items.filter((item) => item.entity === entity).map((item) => item.data);
}

async function appendChains(deps: ComplaintsDeps, worldId: string, epoch: number, items: readonly TemplateItem[]): Promise<void> {
  for (const [entity, chain] of Object.entries(CHAIN_OF)) {
    const entries = of(items, entity).sort((a, b) => Number(a.seq) - Number(b.seq));
    for (const data of entries) {
      const body = Object.fromEntries(Object.entries(data).filter(([name]) => !CHAIN_FIELDS.has(name))) as ChainBody<typeof chain>;
      await appendChained(deps, { chain, worldId, epoch, build: () => ({ entry: body }) });
    }
  }
}

/** Writes the template's items of the BFF tables (`Worlds` and the Core/Networks mocks apart). */
export async function writeBffItems(connector: Connector, deps: ComplaintsDeps, input: { readonly worldId: string; readonly epoch: number; readonly items: readonly TemplateItem[] }): Promise<void> {
  const { items, worldId, epoch } = input;
  for (const data of of(items, "Complaint")) await connector.write(connector.complaints.createOp(data as NewOf<typeof Complaint>));
  for (const data of of(items, "Evidence")) await connector.caseItems.putEvidence(data as NewOf<typeof Evidence>);
  for (const data of of(items, "Action")) await connector.caseItems.putAction(data as NewOf<typeof Action>);
  for (const data of of(items, "Approval")) await connector.write(connector.caseItems.restoreApprovalOp(data as NewOf<typeof Approval>));
  await appendChains(deps, worldId, epoch, items);
  for (const data of of(items, "AuditEntry")) await connector.audit.append(data as NewOf<typeof AuditEntry>);
  for (const item of items.filter((candidate) => candidate.entity === "Counter")) {
    await connector.write({ kind: "put", table: "Runtime", item: { ...item.data, pk: item.pk, sk: item.sk, entity: "Counter", worldId } });
  }
  for (const data of of(items, "Timer")) await connector.timers.put(data as NewOf<typeof Timer>);
  for (const data of of(items, "ConversationMeta")) await connector.conversations.create(data as NewOf<typeof ConversationMeta>);
  for (const data of of(items, "Message")) await connector.conversations.putMessage(data as NewOf<typeof Message>);
  for (const data of of(items, "StoredClock")) await connector.runtime.putClock(data as NewOf<typeof StoredClock>);
}
