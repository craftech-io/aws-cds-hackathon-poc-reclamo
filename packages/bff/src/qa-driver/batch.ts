// `batch.run` (docs/tool-catalog.md, docs/seed-spec.md §13): the real-agent metrics batch, as a non-blocking
// probe. The 30 presentations of `Seed/load/batch-inputs.jsonl` become customers cloned from their model
// personas, spread over `sim-<runId>-<batchId>-<n>` worlds so no world clones a model twice; each world
// runs with the clock PAUSED and a small turn cap, the real Harness and Bedrock answer them, and once
// every world is quiet the run's record is collected (metrics/runs.ts `collectBatchRun`). Publishing it as
// the tab's latest run is the operator's (`Reference` is read-only here).
//
//   CREATING  worlds still being built (by blocks, world-build.ts)
//   RUNNING   presentations being sent (one `wa.inbound` each, `wamid` from the batch and the key) or answered
//   DONE      every world quiet: `{record}`
import { readClock, viewOf } from "../clock/state";
import { worldPending } from "../clock/busy";
import { buildSimulatedEvent } from "../channels/whatsapp/sim-envelope";
import { SIM_WAMID_PREFIX } from "../channels/whatsapp/config";
import { sha256Hex } from "../lib/crypto";
import { type BatchPersona, batchPlan, parseLoadInputs } from "../metrics/inputs";
import { collectBatchRun } from "../metrics/runs";
import { PROBE_BUDGET_MS } from "./contract";
import { batchWorldId } from "./guard";
import type { QaInput } from "./inputs";
import type { ActionContext } from "./ports";
import { createQaWorld, personaOf } from "./world-build";

/** A batch world answers at most this many turns (docs/seed-spec.md §13: tope de turnos). */
const BATCH_TURN_CAPS = { perHour: 60, perDay: 60 } as const;

/** Presentations grouped so no world holds the same model twice. */
export function batchWorlds(root: string, personas: readonly BatchPersona[]): { readonly worldId: string; readonly personas: BatchPersona[] }[] {
  const worlds: { worldId: string; personas: BatchPersona[]; models: Set<string> }[] = [];
  for (const persona of personas) {
    let world = worlds.find((candidate) => !candidate.models.has(persona.model));
    if (world === undefined) {
      world = { worldId: `${root}-${worlds.length + 1}`, personas: [], models: new Set() };
      worlds.push(world);
    }
    world.personas.push(persona);
    world.models.add(persona.model);
  }
  return worlds.map(({ worldId, personas: members }) => ({ worldId, personas: members }));
}

function within(ctx: ActionContext): boolean {
  return ctx.ports.now().getTime() < ctx.startedAt + PROBE_BUDGET_MS;
}

async function quiet(ctx: ActionContext, worldId: string): Promise<boolean> {
  const now = ctx.ports.now();
  const view = viewOf(await readClock(ctx.ports.data, worldId), now);
  return (await worldPending(ctx.ports.data, view, now)).every((item) => item.stale);
}

/** The presentation of a persona, once: its `wamid` derives from the batch and the key. */
async function present(ctx: ActionContext, worldId: string, persona: BatchPersona): Promise<boolean> {
  const marked = await ctx.ports.data.claims.getIdempotency(worldId, "QABATCH", persona.key);
  if (marked !== undefined) return false;
  const { phoneE164 } = await personaOf(ctx.ports, worldId, persona.key);
  const wamid = `${SIM_WAMID_PREFIX}${sha256Hex(`${worldId}#${persona.key}`)}`;
  const event = buildSimulatedEvent(ctx.ports.inbound.key(), { kid: "qa", worldId, from: phoneE164, wamid, content: { type: "text", text: persona.input.message }, at: ctx.ports.now() });
  await ctx.ports.inbound.deliver(event);
  await ctx.ports.data.claims.claimOnce(worldId, "QABATCH", persona.key, { wamid });
  return true;
}

export async function batchRun(input: QaInput<"batch.run">, ctx: ActionContext): Promise<unknown> {
  const plan = batchPlan(parseLoadInputs(await ctx.ports.models.batchInputs()), input.runId);
  const worlds = batchWorlds(batchWorldId(input.runId, input.batchId), plan.personas);
  for (const world of worlds) {
    if (!within(ctx)) return { state: "CREATING", worlds: worlds.length };
    const built = await createQaWorld(
      ctx.ports,
      {
        runId: input.runId,
        worldId: world.worldId,
        template: "models",
        personas: world.personas.map((persona) => ({ key: persona.key, model: persona.model })),
        settings: { turnCaps: BATCH_TURN_CAPS },
      },
      ctx.startedAt,
    );
    if (built.state !== "READY") return { state: "CREATING", worlds: worlds.length, building: world.worldId };
  }
  let sent = 0;
  for (const world of worlds) {
    for (const persona of world.personas) {
      if (!within(ctx)) return { state: "RUNNING", sent };
      if (await present(ctx, world.worldId, persona)) sent += 1;
    }
  }
  for (const world of worlds) if (!(await quiet(ctx, world.worldId))) return { state: "RUNNING", sent, waitingOn: world.worldId };
  const record = await collectBatchRun(ctx.ports.data, { runId: input.runId, worldIds: worlds.map((world) => world.worldId), now: ctx.ports.now() });
  return { state: "DONE", record };
}
