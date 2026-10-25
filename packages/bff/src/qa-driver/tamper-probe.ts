// `register.tamperProbe` (docs/tool-catalog.md, ADR-0014, FL-076, SC-18/4): with the QaDriver's OWN role,
// on the register of a QA world, every way of changing an entry is tried and its outcome reported:
//
//   1  `UpdateItem` and `DeleteItem` of an entry           → IAM denies them (`AccessDeniedException`)
//   2  an unconditional `PutItem` that rewrites entry n    → IAM allows it; the chain verifies `broken`
//                                                            with `brokenAt = n`
//   3  entry m rewritten WITH its hash and every later one recomputed (a valid chain) plus a fake anchor
//      `{seq: m, hash'}` put one hour back in the `qa-…-e<epoch>-REG` stream → `ANCHOR_CONFLICT` at m:
//      the first anchor ingested wins, whatever `timestamp` the writer chose
//   4  the same `PutLogEvents` on a stream that does not start with `qa-` → IAM denies it
//   5  a `PutItem` conditioned on `attribute_exists(pk)` on a key of `demo` that does not exist → IAM
//      denies it (were it allowed, the condition alone would keep it from writing)
//
// The answer also names the ARNs of the three append-only tables (`tables`), so the runner can ask
// `iam:SimulatePrincipalPolicy` about every role of the app (SC-18/8).
//
// The probe never claims more than the register does: a rewrite is detected, not prevented (ADR-0014).
import { ToolError } from "@reclamo/shared";
import { anchorStreamName } from "../complaints/anchors";
import { chainHash } from "../complaints/register";
import { type ChainVerification, loadChain, verifyRegisterChain } from "../complaints/register-verify";
import { keys } from "../connector/keys";
import type { QaInput } from "./inputs";
import type { ActionContext } from "./ports";

const HOUR_MS = 60 * 60_000;
/** A field of the entry the rewrite changes (its content, never its sequence). */
const TAMPERED_FIELD = "reason";

function summary(verification: ChainVerification) {
  return { result: verification.result, brokenAt: verification.brokenAt ?? null, anchorConflicts: [...verification.anchorConflicts], breaks: verification.breaks.slice(0, 5) };
}

async function verify(ctx: ActionContext, worldId: string, epoch: number): Promise<ChainVerification> {
  return verifyRegisterChain({ connector: ctx.ports.data, chainKey: ctx.ports.chainKey(), log: ctx.log }, ctx.ports.anchors, { worldId, epoch, chain: "REG" });
}

function tampered(value: unknown): string {
  return `${typeof value === "string" ? value : ""} [alterado]`;
}

export async function registerTamperProbe(input: QaInput<"register.tamperProbe">, ctx: ActionContext): Promise<unknown> {
  const worldId = ctx.worldId;
  if (worldId === undefined || !worldId.startsWith("qa-")) throw new ToolError("FORBIDDEN", "the tamper probe runs only on a qa-* register");
  // m after n: rehashing m and its successors must not repair the overwrite of step 2.
  if (input.overwriteSeq >= input.rechainSeq) throw new ToolError("INVALID", "the rehashed entry comes after the overwritten one");
  const { data, store } = ctx.ports;
  const tamper = ctx.ports.tamper();
  const clock = await data.runtime.getClock(worldId);
  if (clock === undefined) throw new ToolError("NOT_FOUND", `${worldId} has no clock`, "WORLD_MISSING");
  const epoch = clock.worldEpoch;
  const entries = await loadChain({ connector: data }, worldId, epoch, "REG");
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry as unknown as Record<string, unknown> & { seq: number; hash: string; prevHash: string }]));
  const n = bySeq.get(input.overwriteSeq);
  const m = bySeq.get(input.rechainSeq);
  if (n === undefined || m === undefined) throw new ToolError("NOT_FOUND", "the register has no such entries", "ENTRY_MISSING");
  const keyOf = (seq: number) => keys.register(worldId, epoch, seq);
  const rawOf = async (seq: number) => {
    const raw = await store.get("Register", keyOf(seq), { consistent: true });
    if (raw === undefined) throw new ToolError("NOT_FOUND", `entry ${seq} is missing`, "ENTRY_MISSING");
    return raw;
  };

  // 1. update and delete
  const update = await tamper.updateRegister(keyOf(input.overwriteSeq));
  const remove = await tamper.deleteRegister(keyOf(input.overwriteSeq));

  // 2. an unconditional overwrite of n, hash untouched
  const overwrite = await tamper.putRegister({ ...(await rawOf(n.seq)), [TAMPERED_FIELD]: tampered(n[TAMPERED_FIELD]) });
  const afterOverwrite = summary(await verify(ctx, worldId, epoch));

  // 3. m and every later entry rehashed with the published key, plus a fake anchor an hour back
  const key = ctx.ports.chainKey();
  const later = entries.filter((entry) => entry.seq >= m.seq).sort((a, b) => a.seq - b.seq);
  let prevHash = m.prevHash;
  let rehashedM = "";
  for (const entry of later) {
    const { hash: _hash, ...content } = entry as unknown as Record<string, unknown>;
    const changed = entry.seq === m.seq ? { ...content, [TAMPERED_FIELD]: tampered(content[TAMPERED_FIELD]) } : content;
    const body = { ...changed, prevHash };
    const hash = chainHash(key, prevHash, body);
    if (entry.seq === m.seq) rehashedM = hash;
    await tamper.putRegister({ ...(await rawOf(entry.seq)), ...body, hash });
    prevHash = hash;
  }
  const stream = anchorStreamName(worldId, epoch, "REG");
  const fakeAnchor = JSON.stringify({ worldId, epoch, chain: "REG", seq: m.seq, hash: rehashedM, atReal: new Date(ctx.ports.now().getTime() - HOUR_MS).toISOString() });
  const anchorWrite = await tamper.putAnchor(stream, fakeAnchor, ctx.ports.now().getTime() - HOUR_MS);
  const afterRechain = summary(await verify(ctx, worldId, epoch));

  // 4. an anchor outside the QA streams
  const foreignAnchor = await tamper.putAnchor(anchorStreamName("demo", 1, "REG"), fakeAnchor, ctx.ports.now().getTime());

  // 5. a conditional write into demo's register
  const crossWorld = await tamper.putRegister({ ...keys.register("demo", 1, 999_999_999), entity: "RegisterEntry", worldId: "demo" }, "attribute_exists(pk)");

  const outcome = {
    updateDenied: update === "AccessDeniedException",
    deleteDenied: remove === "AccessDeniedException",
    overwriteDetected: overwrite === "OK" && afterOverwrite.result === "broken" && afterOverwrite.brokenAt === n.seq,
    anchorConflict: anchorWrite === "OK" && afterRechain.result === "broken" && afterRechain.anchorConflicts.includes(m.seq),
    foreignAnchorDenied: foreignAnchor === "AccessDeniedException",
    crossWorldDenied: crossWorld === "AccessDeniedException",
  };
  ctx.log.info("qa_driver.tamper_probe", outcome);
  return { ...outcome, tables: tamper.appendOnlyTableArns(), steps: { update, remove, overwrite, afterOverwrite, anchorWrite, afterRechain, foreignAnchor, crossWorld } };
}
