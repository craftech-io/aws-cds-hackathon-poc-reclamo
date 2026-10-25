// `tape` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/design-brief.md §9 "Cinta
// de cumplimiento"; docs/architecture-integrations.md §4): the compliance tape of the principal's
// world in its current epoch, every decision of the outbound gate whoever sent the message.
//
//   list    newest first, filtered by decision, rule, sender class, channel and complaint; with the
//           counts by decision and the policy violations of the epoch (`AuditLog VIOLATION`, the
//           number the view shows next to the tape, which must stay at 0)
//   export  the tape chain verified against its anchors and written like the register's export
//           (CSV with guarded cells, JSON and `.sha256` in `Exports`, routers/register.ts)
//
// The entries carry hashes and ids only: `customerRef` is a hash and no body is ever stored here.
import { z } from "zod";
import { Channel, TapeEntryKind } from "@reclamo/shared";
import { loadChain } from "../complaints/register-verify";
import { ofEpoch, type TapeEntry } from "../domain/ledger";
import { Id } from "../domain/common";
import { exportChain, registerPortsOf } from "./register";
import { accessProcedure } from "./roles";
import { router } from "./trpc";

export const SenderClass = z.enum(["AGENT", "SYSTEM", "OPERATOR"]);
export type SenderClass = z.infer<typeof SenderClass>;

export const TapeFilter = z
  .object({
    decision: TapeEntryKind.optional(),
    ruleId: z.string().regex(/^(CH-[A-Z0-9-]{2,40}|G2|VERIFY)$/).optional(),
    sender: SenderClass.optional(),
    channel: Channel.optional(),
    complaintId: Id.optional(),
  })
  .strict();
export type TapeFilter = z.infer<typeof TapeFilter>;

export const TapeListInput = TapeFilter.extend({
  limit: z.number().int().min(1).max(500).optional(),
  /** Offset of the next page, as the previous page returned it. */
  cursor: z.number().int().nonnegative().optional(),
})
  .strict()
  .optional();

/** The class of a tape sender: the agent, a deterministic system message or a person of the world. */
export function senderClassOf(sender: string): SenderClass {
  return sender === "AGENT" || sender === "SYSTEM" ? sender : "OPERATOR";
}

/** Whether an entry passes every filter given (a rule matches its `ruleIds` or an evaluated rule that did not pass). */
export function matchesTape(entry: TapeEntry, filter: TapeFilter): boolean {
  if (filter.decision !== undefined && entry.decision !== filter.decision) return false;
  if (filter.sender !== undefined && senderClassOf(entry.sender) !== filter.sender) return false;
  if (filter.channel !== undefined && entry.channel !== filter.channel) return false;
  if (filter.complaintId !== undefined && entry.complaintId !== filter.complaintId) return false;
  if (filter.ruleId !== undefined) {
    const named = entry.ruleIds.includes(filter.ruleId) || entry.evaluated.some((rule) => rule.ruleId === filter.ruleId && rule.result !== "PASS" && rule.result !== "SKIP");
    if (!named) return false;
  }
  return true;
}

const DEFAULT_PAGE = 100;

export const tapeRouter = router({
  list: accessProcedure("tape.list")
    .input(TapeListInput)
    .query(async ({ ctx, input }) => {
      const ports = registerPortsOf(ctx.deps);
      const { worldId } = ctx.principal;
      const epoch = ctx.world.epoch;
      const [all, violations] = await Promise.all([loadChain(ports, worldId, epoch, "TAPE"), ports.connector.audit.listByAction(worldId, "VIOLATION", 1_000)]);
      const { limit, cursor, ...filter } = input ?? {};
      const matching = all.filter((entry) => matchesTape(entry, filter)).sort((a, b) => b.seq - a.seq);
      const offset = cursor ?? 0;
      const size = limit ?? DEFAULT_PAGE;
      const byDecision = Object.fromEntries(TapeEntryKind.options.map((decision) => [decision, all.filter((entry) => entry.decision === decision).length]));
      return {
        epoch,
        total: all.length,
        matching: matching.length,
        byDecision,
        violations: ofEpoch(violations, epoch).length,
        entries: matching.slice(offset, offset + size),
        cursor: offset + size < matching.length ? offset + size : null,
      };
    }),

  export: accessProcedure("tape.export").query(({ ctx }) => exportChain(ctx, "TAPE")),
});
