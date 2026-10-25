// `create_world` (docs/architecture.md §10): a pre-registered world (`META REGISTERED`) moves
// `REGISTERED → CREATING` conditionally (taking its epoch from `COUNTER#EPOCH`, 1 for a new world), is
// written block by block from its template with the cursor in `META.buildCursor`, and becomes `READY`
// LAST, in one transaction with its audit entry. A world left `CREATING` resumes from its cursor. No
// login and no request ever creates a world that was not pre-registered.
//
// Used by `console:invite --guest` (worlds/guest-world.ts), `seed:load` (`demo`, `qamin`, `gprobe`),
// the self-signup provisioning (worlds/guest-provision.ts) and the QA driver's `world.create`.
import { ToolError, guestOriginOf } from "@reclamo/shared";
import type { WriteOp } from "../connector/store";
import { BuildCursor } from "../domain/world";
import { type Budget, type WorldsDeps } from "./deps";
import { writeWorld } from "./factory";
import { instantiate } from "./instantiate";
import { metaUpdateOp, rawMeta } from "./meta";
import { type FactoryTemplate, templateOfWorld } from "./template";

export interface CreateWorldRequest {
  readonly worldId: string;
  /** By default the world id's own template (worlds/template.ts `templateOfWorld`). */
  readonly template?: FactoryTemplate;
  /** `SeedOverrides.personaPhones` of `demo` (customerId → E.164). */
  readonly livePhones?: Readonly<Record<string, string>>;
  readonly budget: Budget;
  /** The provisioning request that owns the creation (self-signup worlds): another one never builds it. */
  readonly provisionRequestId?: string;
  /** Operations that commit with `REGISTERED → CREATING` (the capacity of the self-signup worlds). */
  readonly startOps?: readonly WriteOp[];
  /** Operations that commit with `CREATING → READY`. */
  readonly finishOps?: readonly WriteOp[];
  /** Runs after every block, after the cursor is saved (a ticket's lease). */
  readonly heartbeat?: () => Promise<void>;
}

export type CreateWorldResult =
  | { readonly status: "READY"; readonly created: boolean; readonly epoch: number; readonly livePhones: readonly { phoneHash: string; customerId: string }[] }
  | { readonly status: "CREATING"; readonly cursor: BuildCursor };

type CreateDeps = Pick<WorldsDeps, "connector" | "store" | "templates" | "objects" | "anchors" | "keys" | "log" | "now" | "newId">;

function templateFor(request: CreateWorldRequest): FactoryTemplate {
  const template = request.template ?? templateOfWorld(request.worldId);
  if (!template) throw new ToolError("INVALID", `no template builds ${request.worldId}`, "NO_TEMPLATE");
  return template;
}

/** `REGISTERED → CREATING` with the world's epoch (and its counter, the first time). */
async function start(deps: CreateDeps, request: CreateWorldRequest, template: FactoryTemplate): Promise<number> {
  const current = await deps.connector.counters.getEpoch(request.worldId);
  const epoch = current === 0 ? 1 : current;
  const at = deps.now().toISOString();
  await deps.connector.transact([
    metaUpdateOp(deps, {
      worldId: request.worldId,
      from: "REGISTERED",
      to: "CREATING",
      set: { epoch, template, creatingAtReal: at, ...(request.provisionRequestId ? { provisionRequestId: request.provisionRequestId } : {}) },
      remove: ["buildCursor", "queuePosition"],
    }),
    ...(current === 0 ? [deps.connector.counters.initEpochOp(request.worldId, epoch)] : []),
    ...(request.startOps ?? []),
  ]);
  return epoch;
}

async function finish(deps: CreateDeps, request: CreateWorldRequest, epoch: number, creatingAtReal: string | undefined, template: FactoryTemplate): Promise<void> {
  const now = deps.now();
  const durationMs = creatingAtReal ? now.getTime() - Date.parse(creatingAtReal) : undefined;
  const signup = guestOriginOf(request.worldId) === "SIGNUP";
  await deps.connector.transact([
    metaUpdateOp(deps, {
      worldId: request.worldId,
      from: "CREATING",
      to: "READY",
      ...(request.provisionRequestId ? { provisionRequestId: request.provisionRequestId } : {}),
      set: { readyAtReal: now.toISOString() },
      remove: ["buildCursor", "creatingAtReal", "lastActivityAtReal"],
    }),
    deps.connector.audit.appendOp({
      worldId: request.worldId,
      epoch,
      auditId: `aud-${deps.newId().toLowerCase()}`,
      ts: now.toISOString(),
      action: signup ? "GUEST_WORLD_READY" : "WORLD_CREATED",
      actor: "SYSTEM",
      refs: { template },
      ...(durationMs === undefined ? {} : { detail: { durationMs } }),
    }),
    ...(request.finishOps ?? []),
  ]);
  if (durationMs !== undefined) deps.log.info("worlds.created", { metric: "WorldCreateDuration", worldId: request.worldId, template, durationMs });
}

/** Builds a pre-registered world until `READY`, or until the budget runs out (see the header). */
export async function createWorld(deps: CreateDeps, request: CreateWorldRequest): Promise<CreateWorldResult> {
  const template = templateFor(request);
  const meta = await deps.connector.worlds.getMeta(request.worldId, { consistent: true });
  if (!meta) throw new ToolError("NOT_FOUND", `${request.worldId} is not pre-registered`, "WORLD_NOT_REGISTERED");
  if (meta.status === "READY") return { status: "READY", created: false, epoch: meta.epoch, livePhones: [] };
  if (meta.status !== "REGISTERED" && meta.status !== "CREATING") throw new ToolError("CONFLICT", `${request.worldId} is ${meta.status}`, "WORLD_NOT_CREATABLE");

  let epoch = meta.epoch;
  let cursor = meta.buildCursor;
  if (meta.status === "REGISTERED") {
    epoch = await start(deps, request, template);
    cursor = undefined;
  }
  const raw = await rawMeta(deps, request.worldId);
  if (request.provisionRequestId !== undefined && raw?.provisionRequestId !== request.provisionRequestId) {
    throw new ToolError("CONFLICT", `${request.worldId} is being built by another request`, "SUPERSEDED");
  }

  const build = await instantiate(await deps.templates.read(template), { worldId: request.worldId, epoch, keys: deps.keys(), ...(request.livePhones ? { livePhones: request.livePhones } : {}) });
  const written = await writeWorld(deps, {
    build,
    mode: "CREATE",
    ...(cursor ? { cursor } : {}),
    budget: request.budget,
    onBlock: async (next) => {
      await deps.connector.write(metaUpdateOp(deps, { worldId: request.worldId, from: "CREATING", set: { buildCursor: BuildCursor.parse(next) } }));
      await request.heartbeat?.();
    },
  });
  if (!written.done) return { status: "CREATING", cursor: written.cursor };
  await finish(deps, request, epoch, typeof raw?.creatingAtReal === "string" ? raw.creatingAtReal : undefined, template);
  return { status: "READY", created: true, epoch, livePhones: build.livePhones };
}
