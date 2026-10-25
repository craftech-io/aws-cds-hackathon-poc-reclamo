// Check (d) of `PolicyAudit`: the complaint register, the refund register and the compliance tape of
// the world's epoch verify against their anchors (complaints/register-verify.ts, ADR-0014). `broken`
// (a recomputed hash, a gap, an anchor that disagrees, an `ANCHOR_CONFLICT`) is a violation keyed by the
// chain and the first broken `seq`; `partial` (entries the `AnchorWriter` has not anchored yet) is only
// a `CHAIN_PARTIAL` warning with the `seq` that lack an anchor.
import { type ChainVerification, verifyRegisterChain } from "../complaints/register-verify";
import type { ChainKind } from "../domain/ledger";
import type { Finding } from "./record";
import type { ChainSummary, ChainWarning, PolicyAuditDeps } from "./types";

export const AUDITED_CHAINS: readonly ChainKind[] = ["REG", "RRI", "TAPE"];

export interface ChainOutcome {
  readonly summary: ChainSummary;
  readonly warning?: ChainWarning;
  readonly finding?: Finding;
}

export function chainOutcome(verification: ChainVerification): ChainOutcome {
  const summary: ChainSummary = { chain: verification.chain, result: verification.result, entries: verification.entries };
  if (verification.result === "partial") return { summary, warning: { warning: "CHAIN_PARTIAL", chain: verification.chain, unanchored: [...verification.unanchored] } };
  if (verification.result === "ok") return { summary };
  const brokenAt = verification.brokenAt ?? 0;
  const reason = verification.breaks.find((item) => item.seq === brokenAt)?.reason ?? (verification.anchorConflicts.length > 0 ? "ANCHOR_CONFLICT" : "BROKEN");
  return {
    summary,
    finding: {
      check: "CHAIN_BROKEN",
      key: `CHAIN_BROKEN#${verification.chain}#e${verification.epoch}#${brokenAt}`,
      ruleIds: ["ADR-0014"],
      reason,
      refs: { chain: verification.chain, epoch: String(verification.epoch), brokenAt: String(brokenAt), anchorConflicts: verification.anchorConflicts.join(",").slice(0, 200) },
    },
  };
}

/** Verifies the three chains of the epoch, one after the other. */
export async function auditChains(deps: PolicyAuditDeps, worldId: string, epoch: number): Promise<ChainOutcome[]> {
  const outcomes: ChainOutcome[] = [];
  for (const chain of AUDITED_CHAINS) {
    const verification = await verifyRegisterChain({ connector: deps.connector, chainKey: deps.chainKey, log: deps.log }, deps.anchors, { worldId, epoch, chain });
    outcomes.push(chainOutcome(verification));
  }
  return outcomes;
}
