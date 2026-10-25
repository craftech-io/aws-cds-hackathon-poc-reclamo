// SC-23 · live WhatsApp (docs/test-plan.md §4.5), only in a world approved for live WhatsApp (whatsappLiveApproval in infra/channel-modes.ts; the product's own number and WABA,
// ADR-0021) and only when asked: it never joins a suite and runs with `--scenario SC-23 --live` (the
// runner exports `SCENARIOS_LIVE=1` for it). The world `qa-live-<runId>` runs WhatsApp live
// with C01 on the leased phone of the person at the other end (`LIVEPHONE#`): every step waits for that
// person to act on a real phone, so the waits are long and the run is attended.
import { consoleCall } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { type Persona, sentKind } from "./lib/flows";
import { complaintsOf, messages } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, notWired } from "./lib/steps";

/** A person types on a real phone: minutes, not seconds. */
const HUMAN_SEC = 600;

const persona = (ctx: ScenarioContext): Persona => ({ worldId: `qa-live-${ctx.runId}`, key: "a", model: "C01", customerId: `cus-qa-live-${ctx.runId}-a` });

export default defineScenario({
  id: "SC-23",
  slug: "sc23",
  title: "Live WhatsApp: a real message, a real image, a template delivered, read receipts",
  suites: ["full"],
  onDemand: true,
  steps: [
    {
      n: 0,
      title: "the live world: qa-live-<runId> with WhatsApp live and C01 on the leased phone",
      flows: [],
      async run(ctx) {
        if (process.env["SCENARIOS_LIVE"] !== "1") notWired("world.create", "SC-23 runs only with --live against a world approved for live WhatsApp");
        const create = ctx.repeatable("world.create", { runId: ctx.runId, scenario: "sc23", template: "models", personas: [{ key: "a", model: "C01" }], settings: { channelModes: { whatsapp: "live" } }, live: true });
        await ctx.eventually("the live world READY", async () => ((await create()) as { state: string }).state === "READY", WAITS.worldSec, 2);
        ctx.state["liveWorld"] = persona(ctx).worldId;
        ctx.note("instruction", "write the C01 script message from the leased phone, then send a receipt photo");
      },
    },
    {
      n: 1,
      title: "a real message → the acknowledgement on the phone",
      flows: ["FL-103"],
      async run(ctx) {
        const who = persona(ctx);
        const snapshot = await ctx.eventually("a real message and its acknowledgement", async () => {
          const fresh = await ctx.snapshot(who.worldId, who.customerId);
          return sentKind(fresh, "COMPLAINT_ACK", "WHATSAPP").length > 0 ? fresh : undefined;
        }, HUMAN_SEC, 10);
        ctx.check(complaintsOf(snapshot).length === 1, "the real message filed no complaint");
      },
    },
    {
      n: 2,
      title: "a real image → GetWhatsAppMessageMedia → the case's RECEIPT_IMAGE",
      flows: ["FL-103"],
      async run(ctx) {
        const who = persona(ctx);
        await ctx.eventually("the real image as evidence", async () => complaintsOf(await ctx.snapshot(who.worldId, who.customerId)).some((view) => view.evidence.some((item) => item.kind === "RECEIPT_IMAGE")), HUMAN_SEC, 10);
      },
    },
    {
      n: 3,
      title: "the template reclamo_resuelto → delivered (category utility)",
      flows: ["FL-103"],
      async run(ctx) {
        const who = persona(ctx);
        const view = complaintsOf(await ctx.snapshot(who.worldId, who.customerId))[0];
        if (view === undefined) throw new Error("step 1 filed no complaint");
        await consoleCall(ctx, "customers", "compose", { customerId: who.customerId, kind: "RESOLUTION_NOTICE", channel: "WHATSAPP", template: { name: "reclamo_resuelto", params: [view.complaint.complaintNumber, "v•••@…"] }, complaintId: view.complaint.complaintId }, { worldId: who.worldId });
        await ctx.eventually("reclamo_resuelto delivered", async () => messages(await ctx.snapshot(who.worldId, who.customerId), { direction: "OUT", status: ["DELIVERED", "READ"] }).some((message) => message.templateName === "reclamo_resuelto"), 120, 5);
        ctx.warn("the template's category (utility) is Meta's: read it in the WABA's template list (scripts/channels/whatsapp-templates.ts)");
      },
    },
    {
      n: 4,
      title: "the person reads it → READ",
      flows: ["FL-103"],
      async run(ctx) {
        const who = persona(ctx);
        await ctx.eventually("the template READ", async () => messages(await ctx.snapshot(who.worldId, who.customerId), { direction: "OUT", status: ["READ"] }).some((message) => message.templateName === "reclamo_resuelto"), HUMAN_SEC, 10);
      },
    },
  ],
  async cleanup(ctx) {
    const worldId = ctx.state["liveWorld"];
    if (typeof worldId !== "string") return;
    const destroy = ctx.repeatable("world.destroy", { worldId });
    await ctx.eventually("the live world destroyed", async () => ((await destroy()) as { state: string }).state === "DESTROYED", WAITS.worldSec, 2);
  },
});
