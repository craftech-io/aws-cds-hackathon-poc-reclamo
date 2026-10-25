// The guided tour's replay world (docs/test-plan.md §3, "Flujos locales"): one guest world of the
// `guest` template in the in-process world of the local flows (tests/flows/support/world.ts), driven as
// the guest drives it — every `run` move through the real `tour.run` of the console, every task through
// the console procedure of its view, as user `guest-NN` of that world — with the scripted Harness
// answering the agent's turns (scripts/tour/autopilot.ts). SES is the only actor of the outside world
// the replay plays: each email the world sends gets its `Delivery` event before the next move, as the
// mailbox simulator does in the stage.
import type { Complaint } from "@reclamo/bff/domain/complaint";
import type { TapeEntry } from "@reclamo/bff/domain/ledger";
import { metricsSummary } from "@reclamo/bff/metrics/load";
import { type FlowWorld, createFlowWorld } from "../../tests/flows/support/world";
import { OPERATOR_COLLECTION_TEXT, type TourAction, type TourPersona } from "../../packages/web/src/views/tour/steps";
import { tourAutopilot } from "./autopilot";
import { type ComplaintView, type GuestTask, type TapeView, type TourLanding, type TourWorld } from "./timeline";

/** A guest world id (class `GUEST`): the replay never touches `demo` or a QA world. */
export const REPLAY_WORLD = "g03";

const TAPE_DECISIONS: readonly TapeEntry["decision"][] = ["ALLOWED", "BLOCKED", "REROUTED"];
/** Rounds of "settle the queues, deliver the new emails" before a move is considered done. */
const QUIET_ROUNDS = 8;

export function customerOf(persona: TourPersona): string {
  return `cus-${persona.slice(1).padStart(4, "0")}`;
}

function viewOf(complaint: Complaint): ComplaintView {
  return { number: complaint.complaintNumber, status: complaint.status, slaState: complaint.slaState, filedAtSim: complaint.filedAtSim, deadlineSim: complaint.deadlineSim };
}

function detailsText(details: Readonly<Record<string, unknown>>, name: "result" | "source"): string | undefined {
  const value = details[name];
  return typeof value === "string" ? value : undefined;
}

export interface LfTourWorld extends TourWorld {
  readonly flow: FlowWorld;
}

export async function createLfTourWorld(): Promise<LfTourWorld> {
  const flow = await createFlowWorld({ worlds: [{ worldId: REPLAY_WORLD, template: "guest" }] });
  flow.harness.script(tourAutopilot(() => flow.harness.results));
  const guest = await flow.console("GUEST", { worldId: REPLAY_WORLD });
  const delivered = new Set<string>();
  let lastExport: string | undefined;

  const allTape = async () => (await Promise.all(TAPE_DECISIONS.map((decision) => flow.connector.chains.listTapeByDecision(REPLAY_WORLD, decision, 1_000)))).flat();
  const before = new Set((await allTape()).map((entry) => entry.tapeId));

  /** Settles the queues and plays SES's `Delivery` of every new email until nothing moves. */
  const quiet = async (): Promise<void> => {
    for (let round = 0; round < QUIET_ROUNDS; round += 1) {
      await flow.settle();
      const fresh = flow.stage.emails.filter((sent) => !delivered.has(sent.providerMessageId));
      if (fresh.length === 0) return;
      for (const sent of fresh) {
        delivered.add(sent.providerMessageId);
        await flow.sesEvent(sent, "Delivery");
      }
    }
  };

  /** The persona's complaint the guest filed in this epoch (the latest one). */
  const liveComplaint = async (persona: TourPersona): Promise<Complaint | undefined> =>
    (await flow.connector.complaints.listByCustomer(REPLAY_WORLD, customerOf(persona)))
      .filter((complaint) => complaint.origin === "LIVE")
      .sort((a, b) => a.complaintNumber.localeCompare(b.complaintNumber))
      .at(-1);

  const required = async (persona: TourPersona): Promise<Complaint> => {
    const complaint = await liveComplaint(persona);
    if (complaint === undefined) throw new Error(`${persona} has no complaint in the world yet`);
    return complaint;
  };

  const caseFile = async (persona: TourPersona) => {
    const complaint = await liveComplaint(persona);
    return complaint === undefined ? undefined : flow.connector.caseItems.caseFile(REPLAY_WORLD, complaint.complaintId);
  };

  const run = async (action: TourAction): Promise<TourLanding | undefined> => {
    if (action.kind === "advanceToNext") {
      const complaintNumber = action.persona === undefined ? undefined : (await required(action.persona)).complaintNumber;
      const answer = await guest.tour.run({ action: { kind: "advanceToNext", ...(complaintNumber === undefined ? {} : { complaintNumber }) } });
      await quiet();
      if (answer.kind !== "advanceToNext") return undefined;
      return { simNow: answer.moved.simNow, fired: answer.moved.fired.map((timer) => ({ kind: timer.kind, timerId: timer.timerId, dueAtSim: timer.dueAtSim })) };
    }
    if (action.kind === "exportRegister") {
      const answer = await guest.tour.run({ action });
      lastExport = answer.kind === "exportRegister" ? answer.export.result : undefined;
      await quiet();
      return undefined;
    }
    await guest.tour.run({ action });
    await quiet();
    return undefined;
  };

  const tasks: Readonly<Record<GuestTask, () => Promise<void>>> = {
    async COLLECTION_ATTEMPT_C09() {
      const customerId = customerOf("C09");
      await guest.customers.compose({ customerId, kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Recordatorio de mora de tu cuota." });
      await quiet();
      const blocked = (await flow.connector.chains.listTapeByDecision(REPLAY_WORLD, "BLOCKED", 1_000)).find((entry) => !before.has(entry.tapeId) && entry.kind === "COLLECTION_REMINDER");
      if (blocked === undefined) throw new Error("the collection reminder did not reach the tape");
      await guest.conversation.reroute({ tapeId: blocked.tapeId, route: "FORMAL_EMAIL", customerId });
      await quiet();
    },
    async APPROVE_C03() {
      const complaint = await required("C03");
      const pending = (await guest.approvals.list()).items.find((item) => item.complaintId === complaint.complaintId);
      if (pending === undefined) throw new Error("the agent's approval request is not in Aprobaciones");
      await guest.approvals.decide({ complaintId: pending.complaintId, approvalId: pending.approvalId, decision: "APPROVED" });
      await quiet();
    },
    async TAKE_OVER_AND_WRITE_C09() {
      const customerId = customerOf("C09");
      await guest.conversation.take({ customerId });
      await guest.conversation.send({ customerId, text: OPERATOR_COLLECTION_TEXT });
      await quiet();
    },
    async ANSWER_C07() {
      const complaint = await required("C07");
      await guest.complaints.answer({ complaintId: complaint.complaintId, outcome: "NOT_IN_FAVOUR", draftBody: "Revisamos tu comprobante con la red de cobro y no figura en la rendición publicada, por lo que no podemos imputar ese pago." });
      await quiet();
    },
  };

  return {
    flow,
    run,
    task: (task) => tasks[task](),
    async clock() {
      const clock = await guest.clock.get();
      return { simNow: clock.simNow, mode: clock.mode };
    },
    async pristine() {
      return (await guest.tour.steps()).pristine.ok;
    },
    async complaint(persona) {
      const complaint = await liveComplaint(persona);
      return complaint === undefined ? undefined : viewOf(complaint);
    },
    async milestones(persona) {
      const complaint = await liveComplaint(persona);
      if (complaint === undefined) return [];
      const timers = await flow.connector.timers.listByOwner(REPLAY_WORLD, `CMP#${complaint.complaintId}`);
      return timers.filter((timer) => timer.kind === "SLA").map((timer) => ({ milestone: String(timer.payload.milestone ?? ""), status: timer.status, dueAtSim: timer.dueAtSim }));
    },
    async outbound(persona) {
      const messages = await flow.connector.conversations.listMessages(REPLAY_WORLD, customerOf(persona));
      return messages
        .filter((message) => message.direction === "OUT" && message.channel === "WHATSAPP")
        .map((message) => {
          const buttons = (message.interactive as { buttons?: readonly { action?: unknown }[] } | undefined)?.buttons ?? [];
          return { kind: message.kind ?? "", disclosure: message.flags.disclosure === true, buttons: buttons.map((button) => String(button.action ?? "")) };
        });
    },
    async emails(persona) {
      const { emails } = await flow.connector.emails.listWorld(REPLAY_WORLD, { limit: 200 });
      return emails.filter((email) => email.customerId === customerOf(persona)).map((email) => ({ kind: email.kind, ...(email.deliveryProof === undefined ? {} : { deliveryProof: email.deliveryProof }) }));
    },
    async evidence(persona) {
      const file = await caseFile(persona);
      return (file?.evidence ?? []).map((item) => {
        const result = detailsText(item.details, "result");
        const source = detailsText(item.details, "source");
        return { kind: item.kind, ...(result === undefined ? {} : { result }), ...(source === undefined ? {} : { source }) };
      });
    },
    async actions(persona) {
      return ((await caseFile(persona))?.actions ?? []).map((action) => ({ kind: action.kind, status: action.status }));
    },
    async approvals(persona) {
      return ((await caseFile(persona))?.approvals ?? []).map((approval) => ({ decision: approval.decision, executed: approval.executedAt !== undefined }));
    },
    async newTape(): Promise<TapeView[]> {
      return (await allTape())
        .filter((entry) => !before.has(entry.tapeId))
        .map((entry) => ({ tapeId: entry.tapeId, kind: entry.kind, channel: entry.channel, decision: entry.decision, ruleIds: entry.ruleIds, ...(entry.rerouteOf === undefined ? {} : { rerouteOf: entry.rerouteOf }) }));
    },
    async seededComplaints() {
      return (await flow.connector.complaints.listOpen(REPLAY_WORLD)).filter((complaint) => complaint.origin === "SEED").map((complaint) => ({ number: complaint.complaintNumber, slaState: complaint.slaState }));
    },
    async measured() {
      // What `metrics.summary` answers for "Este mundo" (the flows' console binds no metrics ports).
      const meta = await flow.connector.worlds.getMeta(REPLAY_WORLD);
      return meta === undefined ? undefined : (await metricsSummary(flow.connector, { worldId: REPLAY_WORLD, epoch: meta.epoch, tab: "WORLD" })).n;
    },
    lastExport: () => lastExport,
    deadLetters: () =>
      flow.queues.deadLetters.map((letter) => {
        const type = /"type":"([A-Z_]+)"/.exec(letter.body)?.[1] ?? "UNKNOWN";
        return `${type} (${letter.errorName})`;
      }),
  };
}
