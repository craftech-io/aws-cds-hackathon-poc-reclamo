// Test kit of the `investigation` target: the targets kit (real core and network mocks in process,
// recording gate, complaints deps) plus the receipt reader of receipts/ with a scripted Bedrock and an
// in-memory image store, the reconciliation of reconcile/ over the network mock's own settlement
// files, and an identified session with an open complaint. Synthetic data only.
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import type { CollectionRequest } from "@reclamo/core-contract";
import { createLogger } from "../../lib/log";
import { sha256Hex } from "../../lib/crypto";
import { createSettlementFileReader } from "../../networks/settlement-files";
import type { BedrockReading } from "../../receipts/bedrock-reader";
import { connectorReadBudget } from "../../receipts/budget";
import type { RawReading } from "../../receipts/schema";
import type { ImageStore } from "../../receipts/service";
import { luhnDigit } from "../../receipts/validate";
import type { Complaint } from "../../domain/complaint";
import type { ToolResponse } from "../common/context";
import { gatewayContext } from "../common/principal";
import { type TargetsKit, targetsKit } from "../account/testing";

export { codeOf, okOf } from "../account/testing";
import { type InvestigationPorts, createInvestigationTarget } from "./target";

const silent = createLogger({ sink: () => undefined });

/** A header-only PNG of `width`×`height` (enough for the size checks; no fallback chunk). */
export function tinyPng(seed = 0, width = 600, height = 900): Uint8Array {
  const bytes = new Uint8Array(33 + seed);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** `NTE-20261006-004817-<digit>` with its valid check digit. */
export function operationCode(prefix: "NTE" | "SUR", date: string, serial: string): string {
  return `${prefix}-${date}-${serial}-${luhnDigit(date + serial)}`;
}

/** What Bedrock answers for a clear receipt (amount in pesos, as the model reads it). */
export function clearReading(fields: { network: string; operationCode: string; amountPesos: number; paidAtLocal: string }, overrides: Partial<RawReading> = {}): BedrockReading {
  return {
    kind: "READ",
    raw: { isReceipt: true, network: fields.network, operationCode: fields.operationCode, amount: fields.amountPesos, currency: "ARS", paidAtLocal: fields.paidAtLocal, legibility: "CLEAR", suspiciousText: false, ...overrides },
  };
}

export interface InvestigationKit extends TargetsKit {
  readonly ports: InvestigationPorts;
  /** What the scripted Bedrock answers next (in order; the last one repeats). */
  readonly bedrockAnswers: BedrockReading[];
  readonly images: Map<string, Uint8Array>;
  readonly complaint: Complaint;
  readonly token: string;
  readonly turnId: string;
  call(tool: string, input: Record<string, unknown>, token?: string): Promise<ToolResponse>;
  /** A clean RECEIPT_IMAGE evidence of the complaint with these bytes. */
  addReceiptImage(evidenceId: string, bytes?: Uint8Array, complaintId?: string): Promise<void>;
  /** A cash payment at a collection network, as the world template or the QA driver registers it. */
  collect(request: CollectionRequest): Promise<void>;
  /** Publishes a batch, as ScheduleDispatch does when its timer fires. */
  publish(network: "NORTE" | "SUR", businessDate: string, simNow: string): Promise<void>;
}

export async function investigationKit(customers: readonly CustomerSpec[], complaint: Parameters<TargetsKit["addComplaint"]>[0] = {}): Promise<InvestigationKit> {
  const kit = await targetsKit(customers);
  const bedrockAnswers: BedrockReading[] = [];
  const images = new Map<string, Uint8Array>();
  const imageStore: ImageStore = { get: async (location) => images.get(location.key) };
  const settlements = createSettlementFileReader({
    s3: { send: async (command: { input: { Key?: string } }) => ({ Body: { transformToByteArray: async () => new TextEncoder().encode(kit.network.objects.get(command.input.Key ?? "") ?? "") } }) } as never,
    bucket: "settlements",
  });
  let reads = 0;
  const ports: InvestigationPorts = {
    core: kit.core,
    networks: () => kit.networkClient,
    complaints: () => kit.complaintsDeps,
    gate: kit.gate.gate,
    receipts: (connector, log) => ({
      connector,
      bedrock: { read: async () => bedrockAnswers[Math.min(reads++, bedrockAnswers.length - 1)] ?? { kind: "UNAVAILABLE", reason: "SERVICE_ERROR", attempts: 3 } },
      images: imageStore,
      budget: connectorReadBudget({ connector, now: () => kit.deps.wallClock(), signupImagePool: async () => true, log: silent }),
      now: () => kit.deps.wallClock(),
      log,
    }),
    reconcile: (connector, log) => ({ connector, core: kit.coreClient, network: kit.networkClient, readFile: settlements, now: () => kit.deps.wallClock(), log }),
  };
  const target = createInvestigationTarget(kit.toolDeps, ports);
  const open = await kit.addComplaint({ status: "INVESTIGATING", ...complaint });
  await kit.identify();
  const turn = await kit.openTurn({ complaintIds: [open.complaintId] });
  return {
    ...kit,
    ports,
    bedrockAnswers,
    images,
    complaint: open,
    token: turn.token,
    turnId: turn.turnId,
    call: (tool, input, token = turn.token) => target.handle({ sessionToken: token, ...input }, gatewayContext(`investigation___${tool}`)),
    async addReceiptImage(evidenceId, bytes = tinyPng(), complaintId = open.complaintId) {
      const s3Key = `up/qa-tools/${evidenceId}.png`;
      images.set(s3Key, bytes);
      await kit.addEvidence({ complaintId, evidenceId, kind: "RECEIPT_IMAGE", details: { s3Key, sha256: sha256Hex(bytes), contentType: "image/png", sizeBytes: bytes.length, scan: "NO_THREATS_FOUND" } });
    },
    async collect(request) {
      const answer = await kit.network.call("QaDriver", { method: "POST", path: `/v1/qa-tools/collections`, simNow: request.paidAtSim, body: request });
      if (answer.statusCode !== 200) throw new Error(`collection refused: ${answer.body}`);
    },
    async publish(network, businessDate, simNow) {
      const answer = await kit.network.call("ScheduleDispatch", { method: "POST", path: `/v1/qa-tools/settlements/${network}/${businessDate}/publish`, simNow });
      if (answer.statusCode !== 200) throw new Error(`publication refused: ${answer.body}`);
    },
  };
}
