// `world.create` and `world.destroy` of the QaDriver (docs/tool-catalog.md, docs/architecture.md §10): the
// world factory by blocks, as a non-blocking probe. Each invocation pre-registers the world (once),
// writes blocks until PROBE_BUDGET_MS and answers `{state: CREATING | READY, cursor, elapsedMs}`; the
// runner calls again until `READY`. The cursor lives in `META.buildCursor`, so every call rebuilds the
// same plan (the personas, their leased phones and the template are deterministic) and resumes it.
//
//   models   worlds/factory.ts `writeWorld` over the clone of world-models.ts (start, cursor and finish here)
//   guest    worlds/create.ts `createWorld` itself (SC-21, SC-22), the same code as every guest world
import { ToolError, WorldId, mayRunLive, worldKindOf } from "@reclamo/shared";
import { worldObjectRoot } from "../channels/email/config";
import { isConflict } from "../connector/errors";
import { BuildCursor } from "../domain/world";
import { personaCustomerId, personaPhone } from "../routers/simulator";
import { createWorld } from "../worlds/create";
import { type Budget, RESERVE_MS, type WorldsDeps } from "../worlds/deps";
import { destroyWorld } from "../worlds/destroy";
import { writeWorld } from "../worlds/factory";
import { instantiate } from "../worlds/instantiate";
import { metaUpdateOp, rawMeta } from "../worlds/meta";
import { PROBE_BUDGET_MS, QA_REASON } from "./contract";
import type { HistoryEntry, PersonaRequest, WorldSettingsOverride } from "./inputs";
import type { QaPorts } from "./ports";
import { type ClonedPersona, QA_PHONE_COUNT, QA_PHONE_FIRST, cloneCustomerId, cloneEmail, cloneModels, modelsSettlementKey, publishedFiles, qaPhone } from "./world-models";
import { sha256Hex } from "../lib/crypto";

/** A QA phone is leased for two real hours (docs/seed-spec.md §5). */
export const PHONE_LEASE_MS = 2 * 60 * 60_000;
/** Consecutive numbers tried from the persona's hashed start before the range is called full. */
const PHONE_TRIES = 64;
/** `Runtime/W#<w>#IDEMP#QAPERSONA#<key>`: the persona a key of the world stands for. */
const PERSONA_SOURCE = "QAPERSONA";

export type BuildState = { readonly state: "CREATING"; readonly cursor: BuildCursor | null; readonly elapsedMs: number } | { readonly state: "READY"; readonly epoch: number; readonly elapsedMs: number };

/** A budget that leaves the invocation after PROBE_BUDGET_MS (the factory stops below RESERVE_MS). */
export function probeBudget(ports: Pick<QaPorts, "now">, startedAt: number): Budget {
  return { remainingMs: () => startedAt + PROBE_BUDGET_MS - ports.now().getTime() + RESERVE_MS };
}

/** Leases the persona's QA phone: the same holder always finds the same number first. */
async function leasePhone(ports: Pick<QaPorts, "data" | "now">, worldId: string, key: string): Promise<string> {
  const holder = `${worldId}#${key}`;
  const start = Number.parseInt(sha256Hex(holder).slice(0, 8), 16) % QA_PHONE_COUNT;
  const until = new Date(ports.now().getTime() + PHONE_LEASE_MS).toISOString();
  for (let offset = 0; offset < PHONE_TRIES; offset += 1) {
    const n = QA_PHONE_FIRST + ((start + offset) % QA_PHONE_COUNT);
    if (await ports.data.claims.acquireLease(`QAPHONE#${n}`, holder, until)) return qaPhone(n);
  }
  throw new ToolError("UNAVAILABLE", "the QA phone range has no free number", QA_REASON.NO_QA_PHONE);
}

/** The clones of the request, each with its leased phone, remembered under the world. */
async function clonesOf(ports: Pick<QaPorts, "data" | "now">, worldId: string, personas: readonly PersonaRequest[]): Promise<ClonedPersona[]> {
  const clones: ClonedPersona[] = [];
  for (const persona of personas) {
    const clone: ClonedPersona = {
      key: persona.key,
      model: persona.model,
      customerId: cloneCustomerId(worldId, persona.key),
      phoneE164: await leasePhone(ports, worldId, persona.key),
      email: cloneEmail(worldId, persona.key, persona.emailOverride),
    };
    await ports.data.claims.claimOnce(worldId, PERSONA_SOURCE, persona.key, { customerId: clone.customerId, model: clone.model, phoneE164: clone.phoneE164 });
    clones.push(clone);
  }
  return clones;
}

/** The customer id and the phone a persona key stands for in a world (`wa.inbound`, `caps.prime RATE`). */
export async function personaOf(ports: Pick<QaPorts, "data">, worldId: string, persona: string): Promise<{ readonly customerId: string; readonly phoneE164: string }> {
  if (/^C\d{2}$/.test(persona)) {
    if (worldId.startsWith("qa-")) throw new ToolError("INVALID", "a qa-* world names its personas by their clone key", "PERSONA_KEY");
    return { customerId: personaCustomerId(persona), phoneE164: personaPhone(persona as `C${string}`) };
  }
  const mark = await ports.data.claims.getIdempotency(worldId, PERSONA_SOURCE, persona);
  const customerId = mark?.result?.["customerId"];
  const phoneE164 = mark?.result?.["phoneE164"];
  if (typeof customerId !== "string" || typeof phoneE164 !== "string") throw new ToolError("NOT_FOUND", `no persona ${persona} in ${worldId}`, "PERSONA_NOT_FOUND");
  return { customerId, phoneE164 };
}

function settingsWith(settings: Record<string, unknown>, worldId: string, override: WorldSettingsOverride | undefined): Record<string, unknown> {
  if (override === undefined) return settings;
  if (override.channelModes?.whatsapp === "live" && !mayRunLive(worldId)) throw new ToolError("INVALID", "only qa-live-<runId> may run WhatsApp live", "WORLD_NEVER_LIVE");
  return { ...settings, ...override };
}

export interface CreateRequest {
  readonly runId: string;
  readonly worldId: string;
  readonly template: "models" | "guest";
  readonly personas: readonly PersonaRequest[];
  readonly settings?: WorldSettingsOverride;
  /** Earlier money actions of the personas (`models` only). */
  readonly history?: readonly HistoryEntry[];
}

async function register(deps: WorldsDeps, worldId: string, template: "models" | "guest"): Promise<void> {
  if (await deps.connector.worlds.getMeta(worldId, { consistent: true })) return;
  try {
    await deps.connector.worlds.register({ worldId: WorldId.parse(worldId), kind: worldKindOf(worldId) === "SIM" ? "SIM" : "QA", template, epoch: 1, status: "REGISTERED" });
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

/** Files whose lines name a cloned persona are rewritten; the others are copied as they are. */
async function publishFiles(ports: Pick<QaPorts, "models" | "objects">, deps: WorldsDeps, worldId: string, swap: (value: unknown) => unknown, files: readonly string[]): Promise<{ seedKey: string; key: string }[]> {
  const copies: { seedKey: string; key: string }[] = [];
  const root = worldObjectRoot(worldId);
  for (const seedPath of files) {
    const csv = await ports.models.settlementCsv(seedPath);
    const swapped = swap(csv) as string;
    if (swapped === csv) copies.push({ seedKey: modelsSettlementKey(seedPath), key: `${root}${seedPath}` });
    else await ports.objects.putSettlement(`${root}${seedPath}`, swapped);
  }
  deps.log.debug("qa_driver.files_planned", { worldId, copied: copies.length, rewritten: files.length - copies.length });
  return copies;
}

async function buildModels(ports: QaPorts, deps: WorldsDeps, request: CreateRequest, budget: Budget): Promise<{ readonly done: boolean; readonly cursor?: BuildCursor; readonly epoch: number }> {
  const { worldId } = request;
  let meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
  if (meta?.status === "REGISTERED") {
    const current = await deps.connector.counters.getEpoch(worldId);
    const epoch = current === 0 ? 1 : current;
    await deps.connector.transact([
      metaUpdateOp(deps, { worldId, from: "REGISTERED", to: "CREATING", set: { epoch, creatingAtReal: deps.now().toISOString() }, remove: ["buildCursor"] }),
      ...(current === 0 ? [deps.connector.counters.initEpochOp(worldId, epoch)] : []),
    ]);
    meta = await deps.connector.worlds.getMeta(worldId, { consistent: true });
  }
  if (meta?.status === "READY") return { done: true, epoch: meta.epoch };
  if (meta?.status !== "CREATING") throw new ToolError("CONFLICT", `${worldId} is ${meta?.status ?? "missing"}`, "WORLD_NOT_CREATABLE");

  const doc = await ports.models.read();
  const clones = await clonesOf(ports, worldId, request.personas);
  const { template, swap } = cloneModels(doc, clones, request.history ?? []);
  const built = await instantiate(template, { worldId, epoch: meta.epoch, keys: deps.keys() });
  const files = await publishFiles(ports, deps, worldId, swap, publishedFiles(doc));
  const build = { ...built, settings: settingsWith(built.settings, worldId, request.settings), files };
  const written = await writeWorld(deps, {
    build,
    mode: "CREATE",
    ...(meta.buildCursor ? { cursor: meta.buildCursor } : {}),
    budget,
    onBlock: async (next) => deps.connector.write(metaUpdateOp(deps, { worldId, from: "CREATING", set: { buildCursor: BuildCursor.parse(next) } })),
  });
  if (!written.done) return { done: false, cursor: written.cursor, epoch: meta.epoch };
  const raw = await rawMeta(deps, worldId);
  const startedAt = typeof raw?.creatingAtReal === "string" ? Date.parse(raw.creatingAtReal) : undefined;
  const now = deps.now();
  await deps.connector.transact([
    metaUpdateOp(deps, { worldId, from: "CREATING", to: "READY", set: { readyAtReal: now.toISOString() }, remove: ["buildCursor", "creatingAtReal"] }),
    deps.connector.audit.appendOp({ worldId, epoch: meta.epoch, auditId: `aud-${deps.newId().toLowerCase()}`, ts: now.toISOString(), action: "WORLD_CREATED", actor: "QA", refs: { template: "models", personas: String(clones.length) } }),
  ]);
  if (startedAt !== undefined) deps.log.info("worlds.created", { metric: "WorldCreateDuration", worldId, template: "models", durationMs: now.getTime() - startedAt });
  return { done: true, epoch: meta.epoch };
}

/** One step of `world.create` (see the header). */
export async function createQaWorld(ports: QaPorts, request: CreateRequest, startedAt: number): Promise<BuildState> {
  const deps = ports.worlds();
  const budget = probeBudget(ports, startedAt);
  await register(deps, request.worldId, request.template);
  const elapsed = () => ports.now().getTime() - startedAt;
  if (request.template === "guest") {
    if ((request.history ?? []).length > 0) throw new ToolError("INVALID", "history clones model personas: the guest template has none", "HISTORY_TEMPLATE");
    const result = await createWorld(deps, { worldId: request.worldId, template: "guest", budget });
    return result.status === "READY" ? { state: "READY", epoch: result.epoch, elapsedMs: elapsed() } : { state: "CREATING", cursor: result.cursor, elapsedMs: elapsed() };
  }
  const result = await buildModels(ports, deps, request, budget);
  return result.done ? { state: "READY", epoch: result.epoch, elapsedMs: elapsed() } : { state: "CREATING", cursor: result.cursor ?? null, elapsedMs: elapsed() };
}

/** One step of `world.destroy`: the same steps as WorldJanitor's cleanup of a `qa-*` world, by budget. */
export async function destroyQaWorld(ports: QaPorts, worldId: string, startedAt: number): Promise<{ readonly state: "DESTROYING" | "DESTROYED"; readonly elapsedMs: number }> {
  const result = await destroyWorld(ports.worlds(), worldId, probeBudget(ports, startedAt));
  const elapsedMs = ports.now().getTime() - startedAt;
  return { state: result === "OUT_OF_TIME" ? "DESTROYING" : "DESTROYED", elapsedMs };
}
