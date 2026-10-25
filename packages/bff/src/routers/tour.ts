// `tour` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/design-brief.md §15): the
// server side of the "Recorrido guiado". The steps themselves (titles, texts, "Qué mirar") have one
// source, packages/web/src/views/tour/steps.ts; this router answers what the panel cannot know alone and
// runs each button through the console's own procedures, so a tour click passes exactly the gates of the
// same click elsewhere (role, recent sign-in, `WORLD_BUSY`, simulated mode, audit):
//
//   steps  the world's clock as `clock.get` reads it, whether the world is pristine (clock at the
//          template's start, Wed 07/10 10:10, and no complaint of persona C01 yet), the main story's
//          complaint once filed (number, status, deadline), the next timers (the dates and hours of
//          "Qué mirar"), the time budget of the 5-minute and the deep blocks and of each step (by its
//          number: the titles live in the console's steps.ts) and "Tu recorrido: ~X min"
//   run    one action of a step: the persona's script message (with its synthetic receipt), a text, a
//          tap on a button of the latest message offering it, "Avanzar al próximo evento" or "… hito
//          de este reclamo", "Reloj en vivo" and the register export
//
// While the world is being reset nothing here answers (`WORLD_RESETTING`): the console waits on
// `clock.resetStatus` and then checks again that the world is pristine.
import { z } from "zod";
import { ComplaintNumber, ToolError, WaButtonAction } from "@reclamo/shared";
import { type PersonaId as ScriptPersonaId, UNLINKED_NUMBER_SCRIPT, personaScript } from "../copy";
import { readClock, simIso, viewOf } from "../clock/state";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import type { Complaint } from "../domain/complaint";
import { MAX_CONSOLE_RATE } from "../lib/clock";
import { clockRouter } from "./clock";
import type { ContextDeps } from "./deps";
import { registerRouter } from "./register";
import { accessProcedure } from "./roles";
import { PersonaId, PersonaRef, personaCustomerId, simulatorRouter } from "./simulator";
import { type WorldContext, createCallerFactory, router } from "./trpc";

/** Where every guest world starts (docs/seed-spec.md, template `guest`). */
export const TOUR_START_SIM = "2026-10-07T10:10:00-03:00";
/** The persona of the main story (`R-2026-000123`). */
export const MAIN_STORY_PERSONA = "C01";

/**
 * Time budget per step, in seconds (docs/design-brief.md §15), until the first measured run replaces
 * them with the p95 of its scenario; `measured: false` says so to the panel.
 */
export const TOUR_BLOCKS = [
  { block: "QUICK", budgetSeconds: 300, steps: [["1", 10], ["2", 10], ["2b", 30], ["3", 90], ["4", 90], ["5", 20]] },
  { block: "DEEP", budgetSeconds: 900, steps: [["6", 90], ["7", 120], ["8", 20], ["9", 180], ["10", 10], ["11", 120], ["12", 0]] },
] as const;

export interface TourPorts {
  readonly connector: Connector;
}

declare module "./deps" {
  interface ContextDeps {
    /** `tour.*` reads (routers/tour.ts); its actions run on the other routers' ports. */
    readonly tourPorts?: TourPorts;
  }
}

let stagePorts: TourPorts | undefined;

function tourPortsOf(deps: ContextDeps): TourPorts {
  if (deps.tourPorts) return deps.tourPorts;
  stagePorts ??= { connector: dynamoConnector() };
  return stagePorts;
}

export const TourAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sendScript"), persona: PersonaRef }).strict(),
  z.object({ kind: z.literal("sendText"), persona: PersonaRef, text: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ kind: z.literal("tapButton"), persona: PersonaId, action: WaButtonAction }).strict(),
  z.object({ kind: z.literal("advanceToNext"), complaintNumber: ComplaintNumber.optional() }).strict(),
  z.object({ kind: z.literal("setRunning"), rate: z.number().int().min(1).max(MAX_CONSOLE_RATE).optional() }).strict(),
  z.object({ kind: z.literal("exportRegister") }).strict(),
]);
export type TourAction = z.infer<typeof TourAction>;

export const TourRunInput = z.object({ action: TourAction }).strict();

// The procedures a tour action runs, called in process with the request's own context: every
// middleware (authentication memo included) runs again, under the same paths as from their views.
const createActionCaller = createCallerFactory(router({ simulator: simulatorRouter, clock: clockRouter, register: registerRouter }));

/** The main story's complaint in this epoch, once the guest filed it (never one the template seeded). */
async function mainStoryOf(ctx: WorldContext, connector: Connector): Promise<Complaint | undefined> {
  const complaints = await connector.complaints.listByCustomer(ctx.principal.worldId, personaCustomerId(MAIN_STORY_PERSONA));
  return complaints.find((complaint) => complaint.origin === "LIVE" && complaint.epoch === ctx.world.epoch);
}

async function complaintIdOf(ctx: WorldContext, connector: Connector, complaintNumber: string): Promise<string> {
  const complaint = await connector.complaints.getByNumber(ctx.principal.worldId, complaintNumber);
  if (complaint === undefined) throw new ToolError("NOT_FOUND", "there is no such complaint in this world", "COMPLAINT_NOT_FOUND");
  return complaint.complaintId;
}

export const tourRouter = router({
  steps: accessProcedure("tour.steps").query(async ({ ctx }) => {
    const { connector } = tourPortsOf(ctx.deps);
    const { worldId } = ctx.principal;
    const [stored, story, upcoming] = await Promise.all([readClock(connector, worldId), mainStoryOf(ctx, connector), connector.timers.listDue(worldId, { limit: 8 })]);
    const view = viewOf(stored, ctx.deps.wallClock());
    const clockAtStart = !view.running && view.simNow.getTime() === Date.parse(TOUR_START_SIM);
    // "Tu recorrido: ~X min": the 5-minute block until the main story is filed, then the deep one.
    const current = TOUR_BLOCKS[story === undefined ? 0 : 1];
    return {
      totalMinutes: current.budgetSeconds / 60,
      steps: TOUR_BLOCKS.flatMap((block) => block.steps.map(([step, seconds]) => ({ id: step, title: step, block: block.block, minutes: seconds / 60 }))),
      worldId,
      simNow: simIso(view.simNow),
      mode: view.running ? ("RUNNING" as const) : ("PAUSED" as const),
      startAtSim: TOUR_START_SIM,
      pristine: { ok: clockAtStart && story === undefined, clockAtStart, mainStoryFiled: story !== undefined },
      mainStory: story === undefined ? null : { complaintId: story.complaintId, complaintNumber: story.complaintNumber, status: story.status, slaState: story.slaState, deadlineSim: story.deadlineSim },
      nextEvents: upcoming.map((timer) => ({ kind: timer.kind, timerId: timer.timerId, dueAtSim: timer.dueAtSim, ownerKey: timer.ownerKey ?? null })),
      blocks: TOUR_BLOCKS.map((block) => ({ block: block.block, budgetSeconds: block.budgetSeconds, steps: block.steps.map(([step, seconds]) => ({ step, budgetSeconds: seconds })) })),
      measured: false,
    };
  }),

  run: accessProcedure("tour.run")
    .input(TourRunInput)
    .mutation(async ({ ctx, input }) => {
      const { action } = input;
      const actions = createActionCaller(ctx);
      switch (action.kind) {
        case "sendScript": {
          if (action.persona === "UNLINKED") return { kind: action.kind, sent: [await actions.simulator.sendText({ persona: "UNLINKED", text: UNLINKED_NUMBER_SCRIPT.text })] };
          const script = personaScript(action.persona as ScriptPersonaId);
          if (script === undefined) throw new ToolError("NOT_FOUND", "this persona has no script", "TOUR_NO_SCRIPT");
          const [first] = script.messages;
          const sent = [await actions.simulator.sendText({ persona: action.persona, text: first.text })];
          if (first.attachment?.kind === "RECEIPT_IMAGE") sent.push(await actions.simulator.attachReceipt({ persona: action.persona, source: { kind: "SCRIPT" } }));
          return { kind: action.kind, sent };
        }
        case "sendText":
          return { kind: action.kind, sent: [await actions.simulator.sendText({ persona: action.persona, text: action.text })] };
        case "tapButton": {
          const thread = await actions.simulator.threads({ persona: action.persona });
          const message = [...thread.messages].reverse().find((candidate) => candidate.buttons.some((button) => button.action === action.action));
          const button = message?.buttons.find((candidate) => candidate.action === action.action);
          if (message === undefined || button === undefined) throw new ToolError("NOT_FOUND", "no message of this thread offers that button yet", "TOUR_BUTTON_NOT_FOUND");
          return { kind: action.kind, sent: [await actions.simulator.tapButton({ persona: action.persona, messageId: message.messageId, buttonIndex: button.index })] };
        }
        case "advanceToNext": {
          const complaintId = action.complaintNumber === undefined ? undefined : await complaintIdOf(ctx, tourPortsOf(ctx.deps).connector, action.complaintNumber);
          return { kind: action.kind, moved: await actions.clock.advanceToNext(complaintId === undefined ? {} : { complaintId }) };
        }
        case "setRunning":
          return { kind: action.kind, clock: await actions.clock.setRunning(action.rate === undefined ? {} : { rate: action.rate }) };
        case "exportRegister":
          return { kind: action.kind, export: await actions.register.export({ chain: "REG" }) };
      }
    }),
});
