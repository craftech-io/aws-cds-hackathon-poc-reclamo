// Operational actions of the QaDriver (docs/tool-catalog.md): caps, kill switch, forced turns, events and
// the QA dead letters, the networks' controls, the receipt reader, the audit and the metrics. Each one
// writes only its own world's keys (or the QA-only global buckets) through the module that owns them.
import { FaultsItem, NetworkWorld, fromRaw, items, keys as networkKeys } from "@reclamo/network-mock/store/items";
import { ToolError } from "@reclamo/shared";
import { readClock, simIso, viewOf } from "../clock/state";
import { keys } from "../connector/keys";
import { LEADS_TTL_SECONDS, expiresAt } from "../leads/limits";
import { signupRuntimeKeys } from "../leads/keys";
import { RECEIPT_FORCE_ID, RECEIPT_FORCE_SOURCE } from "../receipts/force";
import { forceNextTurn } from "../turns/forced";
import { primeQaCapacityOp } from "../worlds/meta";
import { keyParts, qaEventId } from "./contract";
import { runConsole } from "./console";
import type { QaInput } from "./inputs";
import type { ActionContext } from "./ports";
import { personaOf } from "./world-build";


function worldOf(ctx: ActionContext): string {
  if (ctx.worldId === undefined) throw new ToolError("INVALID", "this action needs its world");
  return ctx.worldId;
}

async function simNowOf(ctx: ActionContext, worldId: string): Promise<string> {
  return simIso(viewOf(await readClock(ctx.ports.data, worldId), ctx.ports.now()).simNow);
}

async function epochOf(ctx: ActionContext, worldId: string): Promise<number> {
  return (await readClock(ctx.ports.data, worldId)).worldEpoch;
}

export async function capsPrime(input: QaInput<"caps.prime">, ctx: ActionContext): Promise<unknown> {
  const at = ctx.ports.now();
  const { caps } = ctx.ports.data;
  switch (input.bucket) {
    case "TURNCAP":
      await caps.set({ kind: "TURNCAP", worldId: worldOf(ctx), window: input.window, at }, input.value);
      break;
    case "RATE": {
      if (input.persona === undefined) throw new ToolError("INVALID", "RATE names the persona whose sender is primed");
      const { phoneE164 } = await personaOf(ctx.ports, worldOf(ctx), input.persona);
      await caps.set({ kind: "RATE", worldId: worldOf(ctx), phoneHash: await ctx.ports.phoneHash(phoneE164), at }, input.value);
      break;
    }
    case "GLOBALCAP_QA":
      await caps.set({ kind: "GLOBALCAP", pool: "QA", window: input.window, at }, input.value);
      break;
    case "SIGNUP_QA": {
      const key = input.window === "HOUR" ? signupRuntimeKeys.qaHour(at) : signupRuntimeKeys.qaDay(at);
      await ctx.ports.store.write({ kind: "put", table: "Runtime", item: { ...key, entity: "CapCounter", count: input.value, updatedAt: at.toISOString(), expiresAt: expiresAt(at, LEADS_TTL_SECONDS.counter) } });
      break;
    }
    case "GUESTCAP_QA":
      // The runner's sign-up worlds have their own capacity (`GUESTCAP#QA`, worlds/meta.ts): the value is
      // the limit of active worlds for this key's run only, for an hour; `GUESTCAP#ACTIVE` is never touched.
      await ctx.ports.store.write(primeQaCapacityOp({ now: ctx.ports.now }, input.value, keyParts(ctx.key).runId));
      break;
  }
  return { bucket: input.bucket, value: input.value };
}

export async function killSetWorld(input: QaInput<"kill.setWorld">, ctx: ActionContext): Promise<unknown> {
  await ctx.ports.data.runtime.setKill({ worldId: worldOf(ctx), on: input.on, by: "QA", atReal: ctx.ports.now().toISOString(), reason: "QA" });
  return { worldId: worldOf(ctx), on: input.on };
}

export async function turnForceFailure(input: QaInput<"turn.forceFailure">, ctx: ActionContext): Promise<unknown> {
  await forceNextTurn(ctx.ports.data, worldOf(ctx), input.customerId, "FAILURE");
  return { customerId: input.customerId, mode: "FAILURE" };
}

export async function turnForceSilence(input: QaInput<"turn.forceSilence">, ctx: ActionContext): Promise<unknown> {
  await forceNextTurn(ctx.ports.data, worldOf(ctx), input.customerId, input.mode);
  return { customerId: input.customerId, mode: input.mode };
}

function qaCaller(worldId: string, eventId: string) {
  return { kind: "QA" as const, worldId, eventId };
}

/** A fabricated (or repeated) `APPROVAL_DECIDED`: the worker re-reads the approval and trusts nothing else. */
export async function eventInject(input: QaInput<"event.inject">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const eventId = qaEventId(ctx.key);
  await ctx.ports.enqueuer(ctx.log).enqueueCustomerEvent(
    { type: "APPROVAL_DECIDED", eventId, worldId, customerId: input.customerId, epoch: await epochOf(ctx, worldId), eventAtSim: await simNowOf(ctx, worldId), payload: { approvalId: input.approvalId, complaintId: input.complaintId } },
    qaCaller(worldId, eventId),
  );
  return { eventId };
}

/** An event that fails on purpose until the QA dead letters (FL-108). */
export async function eventPoison(input: QaInput<"event.poison">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const eventId = qaEventId(ctx.key);
  await ctx.ports.enqueuer(ctx.log).enqueueCustomerEvent(
    { type: "POISON", eventId, worldId, customerId: input.customerId, epoch: await epochOf(ctx, worldId), eventAtSim: await simNowOf(ctx, worldId), payload: {} },
    qaCaller(worldId, eventId),
  );
  return { eventId };
}

export async function dlqFind(input: QaInput<"dlq.find">, ctx: ActionContext): Promise<unknown> {
  const found = await ctx.ports.dlq.find(input.eventId);
  return found === undefined ? { found: false } : { found: true, ...found };
}

export async function dlqDelete(input: QaInput<"dlq.delete">, ctx: ActionContext): Promise<unknown> {
  return { deleted: await ctx.ports.dlq.delete(input.eventId) };
}

export async function alarmHistory(_input: QaInput<"alarm.history">, ctx: ActionContext): Promise<unknown> {
  return { items: await ctx.ports.alarmHistory() };
}

/** `/v1/health` of both mocks by Function URL with the driver's role, and a `HEALTH_PROBE` through the QA queue. */
export async function probeMocks(input: QaInput<"probe.mocks">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const direct = await ctx.ports.mocks.health();
  const probeId = qaEventId(ctx.key);
  const pending = await ctx.ports.data.claims.getProbe(probeId);
  if (pending === undefined) {
    await ctx.ports.enqueuer(ctx.log).enqueueCustomerEvent(
      { type: "HEALTH_PROBE", eventId: probeId, worldId, customerId: input.customerId, epoch: await epochOf(ctx, worldId), eventAtSim: await simNowOf(ctx, worldId), payload: { probeId } },
      qaCaller(worldId, probeId),
    );
  }
  return { direct, worker: pending === undefined ? { state: "PENDING" } : { state: "DONE", ...pending.data } };
}

export async function probeMalwarePlan(_input: QaInput<"probe.malwarePlan">, ctx: ActionContext): Promise<unknown> {
  return ctx.ports.malwarePlan();
}

export async function networkPublish(input: QaInput<"network.publish">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  return ctx.ports.networks().publishSettlement({ worldId, simNow: await simNowOf(ctx, worldId), correlationId: ctx.log.correlationId }, input.network, input.businessDate);
}

export async function networkTransition(input: QaInput<"network.transition">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  return ctx.ports.networks().transitionTransfer({ worldId, simNow: await simNowOf(ctx, worldId), correlationId: ctx.log.correlationId }, input.transferId, input.transition);
}

/** The world's settlement delay of one network (`Networks/…CONFIG`). */
export async function networkSetDelay(input: QaInput<"network.setDelay">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const raw = await ctx.ports.store.get("Networks", networkKeys.config(worldId), { consistent: true });
  if (raw === undefined) throw new ToolError("NOT_FOUND", `${worldId} has no networks`, "WORLD_MISSING");
  const config = fromRaw(NetworkWorld, raw);
  const delay = { businessDays: input.businessDays, publishAt: input.publishAt, cutoff: input.cutoff };
  const next = { ...config, settlementDelays: { ...config.settlementDelays, [input.network]: delay }, version: config.version + 1 };
  await ctx.ports.store.write({ kind: "put", table: "Networks", item: items.config(next, ctx.ports.now()) as never });
  return { network: input.network, delay };
}

/** The world's network faults (`Networks/…FAULTS`): honoured in QA worlds only (network-mock faults.ts). */
export async function networkSetFault(input: QaInput<"network.setFault">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const raw = await ctx.ports.store.get("Networks", networkKeys.faults(worldId), { consistent: true });
  const version = raw === undefined ? 0 : fromRaw(FaultsItem, raw).version;
  const value = FaultsItem.parse({ worldId, faults: input.faults, version: version + 1 });
  await ctx.ports.store.write({ kind: "put", table: "Networks", item: items.faults(value, ctx.ports.now()) as never });
  return { faults: value.faults.length };
}

export async function receiptForceFallback(input: QaInput<"receipt.forceFallback">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  if (input.on) await ctx.ports.data.claims.claimOnce(worldId, RECEIPT_FORCE_SOURCE, RECEIPT_FORCE_ID, { on: true });
  else await ctx.ports.store.write({ kind: "delete", table: "Runtime", key: keys.runtime(worldId, "IDEMP", RECEIPT_FORCE_SOURCE, RECEIPT_FORCE_ID) });
  return { on: input.on };
}

export async function receiptReadProbe(input: QaInput<"receipt.readProbe">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const seedKey = "file" in input ? input.file : `receipts/${input.variant}/${input.personaModel.toLowerCase()}-${input.seq}.png`;
  const simNow = viewOf(await readClock(ctx.ports.data, worldId), ctx.ports.now()).simNow;
  return ctx.ports.receipts.read({ worldId, seedKey, simNow, forceFallback: input.forceFallback === true });
}

export async function policyAuditRun(_input: QaInput<"policyAudit.run">, ctx: ActionContext): Promise<unknown> {
  return ctx.ports.policyAudit(worldOf(ctx));
}

export async function metricsGet(input: QaInput<"metrics.get">, ctx: ActionContext): Promise<unknown> {
  return runConsole(ctx.ports.console(), { worldId: worldOf(ctx), procedure: "metrics.summary", role: "SUPERVISOR", input: { tab: input.tab } }, ctx.log.correlationId);
}
