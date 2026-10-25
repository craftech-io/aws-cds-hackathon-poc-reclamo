// The worlds `seed:load` owns (docs/seed-spec.md §15, docs/architecture.md §10): `demo`, `qamin` and
// `gprobe`, built in process with the same factory, phases, cursor and READY-last as `WorldJanitor`.
//
//   - a world that does not exist is pre-registered and created;
//   - a world left `CREATING` or `RESETTING` by an earlier run is finished;
//   - a `READY` world is reset only when the seed changed (new fingerprint) or with `--force`.
//
// `gprobe` has no staff row: nobody signs in there (it is the target of the fence probes). The demo
// phones of `SeedOverrides.personaPhones` go into `demo` only, with their `LIVEPHONE#` rows.
import { addressHash } from "@reclamo/shared";
import { keys } from "../../../packages/bff/src/connector/keys";
import { UNLIMITED, type WorldsDeps } from "../../../packages/bff/src/worlds/deps";
import { createWorld } from "../../../packages/bff/src/worlds/create";
import { requestWorldReset } from "../../../packages/bff/src/worlds/reset";
import { runWorldReset } from "../../../packages/bff/src/worlds/reset-work";
import type { FactoryTemplate } from "../../../packages/bff/src/worlds/template";

export const SEED_WORLDS = [
  { worldId: "demo", kind: "DEMO", template: "demo" },
  { worldId: "qamin", kind: "QA", template: "qa-min" },
  { worldId: "gprobe", kind: "GUEST", template: "qa-min" },
] as const satisfies readonly { worldId: string; kind: "DEMO" | "QA" | "GUEST"; template: FactoryTemplate }[];

export type WorldOutcome = "CREATED" | "RESET" | "RESUMED" | "UNCHANGED";

export interface EnsureOptions {
  /** The seed changed (or `--force`): a READY world is reset with the new template. */
  readonly rebuild: boolean;
  /** `customerId → E.164` of the demo phones (only `demo`). */
  readonly livePhones: Readonly<Record<string, string>>;
}

type World = (typeof SEED_WORLDS)[number];

async function preRegister(deps: WorldsDeps, world: World): Promise<void> {
  await deps.connector.worlds.register({
    worldId: world.worldId,
    kind: world.kind,
    template: world.template,
    epoch: 1,
    status: "REGISTERED",
    ...(world.worldId === "gprobe" ? { origin: "INVITED" as const } : {}),
  });
}

/** The demo phones in the reset ticket, so the reload writes the overrides of THIS load. */
async function phonesForReset(deps: WorldsDeps, worldId: string, requestId: string, livePhones: Readonly<Record<string, string>>): Promise<void> {
  if (worldId !== "demo") return;
  await deps.store.write({ kind: "update", table: "Runtime", key: keys.runtime(worldId, "RESETREQ", requestId), update: { set: { detail: { livePhones: { ...livePhones } } } } });
}

async function ensureWorld(deps: WorldsDeps, world: World, options: EnsureOptions): Promise<WorldOutcome> {
  const livePhones = world.worldId === "demo" ? options.livePhones : {};
  let meta = await deps.connector.worlds.getMeta(world.worldId, { consistent: true });
  if (!meta) {
    await preRegister(deps, world);
    meta = await deps.connector.worlds.getMeta(world.worldId, { consistent: true });
  }
  switch (meta?.status) {
    case "REGISTERED":
    case "CREATING": {
      const fresh = meta.status === "REGISTERED";
      await createWorld(deps, { worldId: world.worldId, template: world.template, livePhones, budget: UNLIMITED });
      return fresh ? "CREATED" : "RESUMED";
    }
    case "RESETTING":
      if (meta.reset) await runWorldReset(deps, { worldId: world.worldId, requestId: meta.reset.requestId }, UNLIMITED);
      return "RESUMED";
    case "READY": {
      if (!options.rebuild) return "UNCHANGED";
      const { requestId } = await requestWorldReset(deps, { worldId: world.worldId, actor: "SYSTEM", reason: "SEED_LOAD" });
      await phonesForReset(deps, world.worldId, requestId, livePhones);
      const result = await runWorldReset(deps, { worldId: world.worldId, requestId }, UNLIMITED);
      if (result.status !== "READY") throw new Error(`seed:load could not reset ${world.worldId}: ${result.status}`);
      return "RESET";
    }
    default:
      throw new Error(`seed:load cannot take ${world.worldId} in status ${meta?.status ?? "missing"}`);
  }
}

/** `LIVEPHONE#<phoneHash>` → `demo` for every demo phone (the only way a live sender resolves a world). */
export async function writeLivePhones(deps: WorldsDeps, livePhones: Readonly<Record<string, string>>): Promise<number> {
  for (const phone of Object.values(livePhones)) {
    await deps.connector.claims.putLivePhone({ phoneHash: await addressHash("WHATSAPP", phone, deps.keys().phoneHash), worldId: "demo" });
  }
  return Object.keys(livePhones).length;
}

/** Every seed world, in order; returns what happened to each. */
export async function ensureSeedWorlds(deps: WorldsDeps, options: EnsureOptions): Promise<Record<string, WorldOutcome>> {
  const outcomes: Record<string, WorldOutcome> = {};
  for (const world of SEED_WORLDS) outcomes[world.worldId] = await ensureWorld(deps, world, options);
  return outcomes;
}
