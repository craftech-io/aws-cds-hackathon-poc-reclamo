// The templates conform to what reads them (docs/seed-spec.md §4, docs/architecture.md §5): after the
// factory's only substitution (`<worldId>`, `<epoch>`), every item parses with the schema of its
// consumer (the core mock's store, the network mock's store, the BFF domain), sits at the key that
// consumer's key builder computes, and starts with `W#<worldId>#`; settlement lines parse with the
// published contract; the collection corpus loads through the single loader channel-policy uses.
import { parseSettlementCsv } from "@reclamo/core-contract";
import { keys } from "@reclamo/bff/connector/keys";
import { CORPUS_FILE, loadCollectionCorpus } from "@reclamo/bff/copy/testing";
import { Action, Approval, Evidence } from "@reclamo/bff/domain/case-items";
import { Complaint } from "@reclamo/bff/domain/complaint";
import { ConversationMeta, Message } from "@reclamo/bff/domain/conversation";
import { AuditEntry, ChainHead, RefundEntry, RegisterEntry, TapeEntry } from "@reclamo/bff/domain/ledger";
import { Counter, StoredClock, WorldState } from "@reclamo/bff/domain/runtime";
import { Timer } from "@reclamo/bff/domain/timer";
import { AutoClosePayload, NetworkTransitionPayload, SlaPayload } from "@reclamo/bff/timers/events";
import { WorldSettings } from "@reclamo/bff/domain/world";
import { ActionClaimItem, CUSTOMER_ENTITIES, OwnerItem } from "@reclamo/core-mock/store/items";
import { coreKeys } from "@reclamo/core-mock/store/keys";
import { NetworkWorld, StoredBatch, StoredLine, StoredTransfer, keys as networkKeys } from "@reclamo/network-mock/store/items";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { sha256Hex } from "../lib/json";
import { type TemplateItem, type WorldTemplateFile, instantiate } from "../lib/template";
import { type Json, type SeedOnDisk, readSeed } from "../validate/read";

let seed: SeedOnDisk;

beforeAll(() => {
  seed = readSeed();
});

const DOMAIN: Readonly<Record<string, z.ZodType>> = {
  WorldSettings,
  Complaint,
  Evidence,
  Action,
  Approval,
  RegisterEntry,
  RefundEntry,
  TapeEntry,
  AuditEntry,
  Timer,
  ConversationMeta,
  Message,
  StoredClock,
  Counter,
  ChainHead,
  WorldState,
};

const NETWORK: Readonly<Record<string, z.ZodType>> = {
  NetworkWorld,
  SettlementBatch: StoredBatch,
  SettlementLine: StoredLine,
  OperationCodeClaim: StoredLine,
  TransferStatus: StoredTransfer,
};

/** The key the item's consumer builds for it, from the item's own fields. */
function expectedKey(worldId: string, epoch: number, item: TemplateItem): { pk: string; sk: string } | undefined {
  const data = item.data as Json;
  const s = (name: string): string => String(data[name]);
  switch (item.entity) {
    case "Customer":
    case "Account":
    case "Wallet":
      return { pk: coreKeys.customerPk(worldId, s("customerId")), sk: { Customer: "META", Account: "ACCOUNT", Wallet: "WALLET" }[item.entity] };
    case "Loan":
      return { pk: coreKeys.customerPk(worldId, s("customerId")), sk: coreKeys.loanSk(s("loanId")) };
    case "Payment":
      return { pk: coreKeys.customerPk(worldId, s("customerId")), sk: coreKeys.paymentSk(s("loanId"), s("paymentId")) };
    case "Movement":
      return { pk: coreKeys.customerPk(worldId, s("customerId")), sk: coreKeys.movementSk(s("atSim"), s("movementId")) };
    case "Charge":
      return { pk: coreKeys.customerPk(worldId, s("customerId")), sk: coreKeys.chargeSk(s("chargeId")) };
    case "Transfer":
      return { pk: coreKeys.customerPk(worldId, s("customerId")), sk: coreKeys.transferSk(s("transferId")) };
    case "CreditNote":
      return { pk: coreKeys.customerPk(worldId, s("customerId")), sk: coreKeys.creditNoteSk(s("creditNoteId")) };
    case "WorldSettings":
      return keys.worldSettings(worldId);
    case "Complaint":
      return keys.complaint(worldId, s("complaintId"));
    case "Evidence":
      return keys.evidence(worldId, s("complaintId"), s("evidenceId"));
    case "Action":
      return keys.action(worldId, s("complaintId"), s("actionId"));
    case "Approval":
      return keys.approval(worldId, s("complaintId"), s("approvalId"));
    case "RegisterEntry":
      return keys.register(worldId, epoch, Number(data.seq));
    case "RefundEntry":
      return keys.refund(worldId, epoch, Number(data.seq));
    case "TapeEntry":
      return keys.tape(worldId, s("atSim").slice(0, 10), s("atSim"), s("tapeId"));
    case "AuditEntry":
      return keys.audit(worldId, epoch, s("ts"), s("auditId"));
    case "Timer":
      return keys.timer(worldId, s("kind"), s("timerId"));
    case "ConversationMeta":
      return keys.conversation(worldId, s("customerId"));
    case "Message":
      return keys.message(worldId, s("customerId"), s("atSim"), s("messageId"));
    case "SettlementBatch":
      return networkKeys.batch(worldId, data.network as "NORTE" | "SUR", s("businessDate"));
    case "SettlementLine": {
      const line = data.line as Json;
      return networkKeys.line(worldId, line.network as "NORTE" | "SUR", String(line.businessDate), String(line.operationCode));
    }
    case "OperationCodeClaim": {
      const line = data.line as Json;
      return networkKeys.operationCode(worldId, line.network as "NORTE" | "SUR", String(line.operationCode));
    }
    case "TransferStatus":
      return networkKeys.transfer(worldId, s("transferId"));
    case "NetworkWorld":
      return networkKeys.config(worldId);
    default:
      return undefined;
  }
}

function parse(item: TemplateItem): void {
  const data = item.data as Json;
  if (item.table === "Core") {
    const schema = item.entity === "ActionClaim" ? ActionClaimItem : item.entity === "LoanOwner" || item.entity === "ChargeOwner" ? OwnerItem : CUSTOMER_ENTITIES[item.entity as keyof typeof CUSTOMER_ENTITIES];
    expect(schema, item.entity).toBeDefined();
    schema?.parse({ entity: item.entity, ...data });
    return;
  }
  const schema = item.table === "Networks" ? NETWORK[item.entity] : DOMAIN[item.entity];
  expect(schema, `${item.table} ${item.entity}`).toBeDefined();
  const result = schema?.safeParse(data);
  expect(result?.success, `${item.entity} ${item.pk} ${item.sk}: ${JSON.stringify(result?.error?.issues.slice(0, 3))}`).toBe(true);
}

function conforms(items: readonly TemplateItem[], worldId: string, epoch: number): void {
  for (const raw of items) {
    const item = instantiate(raw, worldId, epoch);
    expect(item.pk.startsWith(`W#${worldId}#`), item.pk).toBe(true);
    parse(item);
    const key = expectedKey(worldId, epoch, item);
    if (key) expect({ pk: item.pk, sk: item.sk }, item.entity).toEqual(key);
  }
}

describe("the world templates conform to their consumers", () => {
  it.each([
    ["demo", "demo", 0],
    ["guest", "g01", 3],
    ["guest", "gs-abcdefghij", 1],
    ["qa-min", "qamin", 2],
  ] as const)("%s as %s (epoch %d)", (name, worldId, epoch) => {
    const template: WorldTemplateFile = seed.templates[name];
    expect(template.items.length).toBeGreaterThan(1000);
    conforms(template.items, worldId, epoch);
    const settings = instantiate(template.settings, worldId, epoch) as Json;
    expect(WorldSettings.safeParse(settings).success).toBe(true);
    expect((settings.channelModes as Json).whatsapp).toBe("simulated");
  }, 120_000);

  it("models: the shared items and every persona clone into a QA world", () => {
    conforms(seed.models.shared, "qa-1234-1-sc01", 0);
    expect(Object.keys(seed.models.personas)).toHaveLength(41);
    for (const persona of Object.values(seed.models.personas)) conforms(persona.items, "qa-1234-1-sc01", 0);
    for (const event of seed.models.personas.C17?.registerEvents ?? []) expect(RegisterEntry.omit({ seq: true, prevHash: true, hash: true }).safeParse(instantiate(event, "qa-1234-1-sc01", 0)).success).toBe(true);
  }, 120_000);

  it("every seeded SLA, AUTO_CLOSE and NETWORK_TRANSITION timer carries the payload its dispatcher parses", () => {
    const PAYLOADS: Readonly<Record<string, z.ZodType>> = { SLA: SlaPayload, AUTO_CLOSE: AutoClosePayload, NETWORK_TRANSITION: NetworkTransitionPayload };
    for (const name of ["demo", "guest", "qa-min"] as const) {
      const timers = seed.templates[name].items.filter((item) => item.entity === "Timer").map((item) => item.data as Json);
      const checked = timers.filter((timer) => String(timer.kind) in PAYLOADS);
      if (name !== "qa-min") expect(checked.some((timer) => timer.kind === "SLA"), name).toBe(true);
      for (const timer of checked) expect(PAYLOADS[String(timer.kind)]?.safeParse(instantiate(timer.payload, "g01", 1)).success, `${name} ${String(timer.timerId)}`).toBe(true);
    }
  });

  it("every template and the models carry the fixed per-complaint cost threshold, US$ 1.75", () => {
    for (const name of ["demo", "guest", "qa-min"] as const) expect(seed.templates[name].settings.costPerComplaintThresholdUsd, name).toBe(1.75);
    expect(seed.models.settings.costPerComplaintThresholdUsd).toBe(1.75);
  });

  it("guest carries both sets of usage caps; the others none", () => {
    expect(Object.keys(seed.templates.guest.settingsByOrigin ?? {})).toEqual(["INVITED", "SIGNUP"]);
    expect(seed.templates.demo.settingsByOrigin).toBeUndefined();
  });

  it("demo emails keep the plain tag, every other world prefixes its own id", () => {
    const email = (template: WorldTemplateFile, worldId: string): string =>
      String(instantiate(template.items.find((item) => item.entity === "Customer" && (item.data as Json).customerId === "cus-0039")?.data as Json, worldId, 0).email);
    expect(email(seed.templates.demo, "demo")).toBe("bounce+cus-0039@simulator.amazonses.com");
    expect(email(seed.templates.guest, "g07")).toBe("bounce+g07-cus-0039@simulator.amazonses.com");
  });
});

describe("the settlement files conform to the published contract", () => {
  it("every CSV parses all-or-nothing and its batch records its SHA-256 and line count", () => {
    for (const name of ["demo", "guest", "qa-min"] as const) {
      const batches = seed.templates[name].items.filter((item) => item.entity === "SettlementBatch").map((item) => item.data as Json);
      for (const batch of batches.filter((candidate) => candidate.status === "PUBLISHED")) {
        const path = `data/settlements/${name}/${String(batch.network)}/${String(batch.businessDate)}/batch-1.csv`;
        const bytes = seed.files.get(path);
        expect(bytes, path).toBeDefined();
        const lines = parseSettlementCsv(bytes?.toString("utf8") ?? "", { network: batch.network as "NORTE" | "SUR", businessDate: String(batch.businessDate) });
        expect([batch.sha256, batch.lineCount], path).toEqual([sha256Hex(bytes ?? ""), lines.length]);
      }
    }
  });
});

describe("the evals load through their consumers", () => {
  it(`[FL-067] the collection corpus (${CORPUS_FILE}) splits into 80 collection and 80 service sentences, plus the adversarial ones`, () => {
    const corpus = loadCollectionCorpus();
    expect((corpus?.collection.length ?? 0) - (corpus?.adversarial.length ?? 0)).toBe(80);
    expect(corpus?.adversarial.length).toBeGreaterThanOrEqual(10);
    expect(corpus?.service).toHaveLength(80);
  });
});
