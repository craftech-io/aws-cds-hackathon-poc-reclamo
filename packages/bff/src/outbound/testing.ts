// Test kit of the gate: the demo world on Wednesday 07/10/2026 10:10 in Buenos Aires over the memory
// connector, the real SES client (fenced, with a recording SES stand-in), the real phone simulator, a
// programmable G2 and the fictitious customers of the policy fixtures (Valeria C01, Martín C09 with an
// overdue instalment, Rocío C38 without WhatsApp opt-in). Every instant is explicit; every address is
// the SES mailbox simulator's.
import type { ChannelMode, MessageKind, WaButtonAction } from "@reclamo/shared";
import { addressHash } from "@reclamo/shared";
import type { WhatsAppSendRequest, WhatsAppTransport } from "../channels/whatsapp/transport";
import { simulatedWhatsAppTransport } from "../channels/whatsapp/simulated-transport";
import { type EmailKit, emailKit } from "../channels/email/testing";
import { TEST_PHONE_KEY } from "../channels/whatsapp/testing";
import { complaintsKit } from "../complaints/testing";
import type { NewOf } from "../connector/codec";
import { SIM_NOW, complaint as complaintRow, conversation as conversationRow, message as messageRow, staff } from "../connector/testing";
import type { Complaint } from "../domain/complaint";
import type { ConversationMeta } from "../domain/conversation";
import { createLogger } from "../lib/log";
import { renderDocument } from "../pdf/documents";
import type { CustomerFacts, DebtDetail, OutboundDeps } from "./deps";
import { personaRecipients, simulatorEmailDirectory } from "./directory";
import { createOutboundGate } from "./gate";
import type { G2Input, G2Verdict, OutputGuardrail } from "./g2";
import type { OutboundCall, OutboundGate, OutboundRequest } from "./types";

export const VALERIA = "cus-0001";
export const MARTIN = "cus-0009";
export const ROCIO = "cus-0038";
export const OPERATOR = "OPERATOR:stf-operator-01";
export const DEMO_PHONE = "+5491100009999";
const OPTED_IN = { optedIn: true, optedInAtSim: "2025-03-01T10:00:00-03:00", optInMedium: "SIGNED_ONBOARDING", optInTextVersion: "v001", optedOut: false };

export const CUSTOMERS: Readonly<Record<string, CustomerFacts>> = {
  [VALERIA]: { customerId: VALERIA, firstName: "Valeria", emailMasked: "s***@simulator.amazonses.com", whatsapp: OPTED_IN, loans: [{ loanId: "L-0001", label: "Préstamo personal 0001" }, { loanId: "L-0002", label: "Préstamo express 0002" }] },
  [MARTIN]: { customerId: MARTIN, firstName: "Martín", emailMasked: "s***@simulator.amazonses.com", whatsapp: OPTED_IN, loans: [{ loanId: "L-0009", label: "Préstamo personal 0009" }] },
  [ROCIO]: { customerId: ROCIO, firstName: "Rocío", emailMasked: "s***@simulator.amazonses.com", whatsapp: { optedIn: false, optedOut: false }, loans: [] },
};

export const MARTIN_DEBT: DebtDetail = { loanId: "L-0009", loanLabel: "Préstamo personal 0009", overdue: [{ instalment: 3, dueDate: "2026-09-25", amountCents: 6_421_000 }], totalCents: 6_421_000 };

/** A G2 that answers `verdict` (pass by default) and records what it was asked. */
export class FakeG2 implements OutputGuardrail {
  readonly inputs: G2Input[] = [];
  verdict: G2Verdict | Error = { action: "NONE", groundingScore: 0.92, relevanceScore: 0.81 };

  async check(input: G2Input): Promise<G2Verdict> {
    this.inputs.push(input);
    if (this.verdict instanceof Error) throw this.verdict;
    return this.verdict;
  }
}

export interface GateRig {
  readonly worldId: string;
  readonly deps: OutboundDeps;
  readonly gate: OutboundGate;
  readonly kit: ReturnType<typeof complaintsKit>;
  readonly email: EmailKit;
  readonly g2: FakeG2;
  /** Every WhatsApp the transport was asked to send (before the simulator ran it). */
  readonly whatsappSent: WhatsAppSendRequest[];
  /** Set to make the next WhatsApp sends throw. */
  failWhatsApp: Error | undefined;
  /** Runs before each WhatsApp send (to look at the store at that moment). */
  beforeWhatsApp: (() => Promise<void>) | undefined;
  simNow: string;
  readonly lines: Record<string, unknown>[];
  readonly documents: Map<string, Uint8Array>;
}

export interface RigOptions {
  readonly worldId?: string;
  readonly mode?: ChannelMode;
}

export async function gateRig(options: RigOptions = {}): Promise<GateRig> {
  const worldId = options.worldId ?? "demo";
  const kit = complaintsKit({ worldId });
  await kit.seedWorld();
  const { connector } = kit;
  const email = emailKit({ connector });
  const g2 = new FakeG2();
  const documents = new Map<string, Uint8Array>();
  let nonce = 0;
  const simulated = simulatedWhatsAppTransport({ data: connector, recipients: personaRecipients, templates: { status: async () => "LOCAL_ONLY" }, realClock: { now: async () => kit.deps.realNow?.() ?? new Date(0) }, log: kit.log, newWamid: () => `wamid.SIM.${String(++nonce).padStart(26, "0")}` });
  const rig: GateRig = {
    worldId,
    deps: undefined as unknown as OutboundDeps,
    gate: undefined as unknown as OutboundGate,
    kit,
    email,
    g2,
    whatsappSent: [],
    failWhatsApp: undefined,
    beforeWhatsApp: undefined,
    simNow: SIM_NOW,
    lines: kit.lines,
    documents,
  };
  const recordingTransport: WhatsAppTransport = {
    mode: "simulated",
    async send(request) {
      await rig.beforeWhatsApp?.();
      rig.whatsappSent.push(request);
      if (rig.failWhatsApp !== undefined) throw rig.failWhatsApp;
      return simulated.send(request);
    },
  };
  const deps: OutboundDeps = {
    chains: kit.deps,
    simNow: async () => new Date(rig.simNow),
    customers: { get: async (_worldId, customerId) => CUSTOMERS[customerId] },
    emails: simulatorEmailDirectory,
    recipients: personaRecipients,
    phoneHash: (phone) => addressHash("WHATSAPP", phone, TEST_PHONE_KEY),
    debts: { overdue: async (_worldId, customerId) => (customerId === MARTIN ? MARTIN_DEBT : undefined) },
    documents: {
      async read(s3Key) {
        const bytes = documents.get(s3Key);
        if (bytes === undefined) throw new Error("no such document");
        return bytes;
      },
      async collectionNotice(input) {
        const rendered = renderDocument({ docKind: "COLLECTION_NOTICE", issuedAtSim: input.issuedAtSim, customerName: input.customerName, creditor: { cuit: "30-99999999-5", address: "Av. de los Tilos 1400, Ciudad Ficticia" }, loan: { label: input.debt.loanLabel }, overdue: input.debt.overdue.map((row) => ({ number: row.instalment, dueDate: row.dueDate, amountCents: row.amountCents })) });
        const s3Key = `W/${input.worldId}/customers/${input.customerId}/COLLECTION_NOTICE.pdf`;
        documents.set(s3Key, rendered.bytes);
        return { docKind: "COLLECTION_NOTICE", s3Key, sha256: rendered.sha256, bytes: rendered.bytes, fileName: "jarilla-collection-notice.pdf" };
      },
    },
    guardrail: g2,
    email: email.client,
    whatsapp: { simulated: recordingTransport },
    stageModes: { email: "live", whatsapp: { liveWorlds: [] } },
    demoRecipients: () => ({ emails: ["demo.recipient@craftech.io"], phones: [DEMO_PHONE] }),
    newNonce: () => `01K6ZT0000NONCE${String(++nonce).padStart(11, "0")}`,
  };
  Object.assign(rig, { deps, gate: createOutboundGate(deps) });
  await connector.worlds.putStaff({ ...staff(worldId, "stf-operator-01"), worldId });
  return rig;
}

export function call(rig: Pick<GateRig, "kit">, actor: OutboundCall["actor"] = "SYSTEM"): OutboundCall {
  return { actor, correlationId: "test-correlation", log: rig.kit.log };
}

/** A conversation whose customer wrote at `atSim` (the 24-hour window opens), optionally disclosed already. */
export async function customerWrote(rig: GateRig, customerId: string, atSim: string, meta: Partial<NewOf<typeof ConversationMeta>> = {}): Promise<void> {
  const { connector } = rig.kit;
  if ((await connector.conversations.getMeta(rig.worldId, customerId)) === undefined) {
    await connector.conversations.create(conversationRow(rig.worldId, { customerId, sessionEpoch: 1, disclosedEpochs: [1], windowOpenUntilSim: atSim, lastInboundAtSim: atSim, ...meta }));
  }
  await connector.conversations.putMessage(messageRow(rig.worldId, { customerId, messageId: `in-${customerId}-${Date.parse(atSim)}`, body: "¿Me ayudás con mi pago de la cuota 4?", atSim }));
}

/** An open turn of the agent for the customer, with the given tool results (`Runtime/TURN#`). */
export async function agentTurn(rig: GateRig, customerId: string, turnId: string, results: readonly Record<string, unknown>[]): Promise<void> {
  const { sessions } = rig.kit.connector;
  const at = rig.kit.deps.realNow?.().toISOString() ?? SIM_NOW;
  await sessions.putSession({ worldId: rig.worldId, sessionId: `ses-${turnId}`, customerId, complaintIds: [], identified: true, trigger: "CUSTOMER_MESSAGE", triggerEventId: `evt-${turnId}`, turnId, eventAtSim: rig.simNow, createdAtReal: at });
  await sessions.openTurn({ worldId: rig.worldId, turnId, sessionId: `ses-${turnId}`, openedAtReal: at });
  for (const result of results) await sessions.putTurnResult(rig.worldId, turnId, "get_account", result as never);
}

export async function seedComplaint(rig: GateRig, overrides: Partial<NewOf<typeof Complaint>> = {}): Promise<void> {
  await rig.kit.connector.write(rig.kit.connector.complaints.createOp(complaintRow(rig.worldId, { status: "INVESTIGATING", ...overrides })));
}

export interface RequestOverrides extends Partial<OutboundRequest> {
  readonly buttons?: readonly { readonly action: WaButtonAction; readonly ref?: string }[];
}

/** A request with the given kind; ids default to Valeria's. */
export function request(kind: MessageKind, overrides: RequestOverrides = {}): OutboundRequest {
  return { worldId: "demo", customerId: VALERIA, sender: "SYSTEM", channel: "WHATSAPP", kind, refs: {}, ...overrides };
}

/** Log lines with this message. */
export function linesNamed(rig: Pick<GateRig, "lines">, message: string): Record<string, unknown>[] {
  return rig.lines.filter((line) => line.message === message);
}

/** The world's tape in chain order. */
export async function tapeOf(rig: GateRig) {
  return (await rig.kit.connector.chains.listTapeBySeq(rig.worldId, 1)).entries;
}

export const quietLog = createLogger({ sink: () => undefined });
