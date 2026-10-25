// Test kit of the world factory: a small template cut from the real `guest` template (every entity
// kind, more than one block of core items and of register entries), the memory connector on a
// movable real clock, and fakes of S3, the Scheduler, Memory, `AnchorWriter`, the asynchronous
// invocations and the user pool. Nothing here reaches AWS.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnchorRequest } from "../complaints/anchors";
import type { MemoryConnector } from "../connector/memory/connector";
import { testConnector } from "../connector/testing";
import { deriveSubkey, hmacSha256Hex } from "../lib/crypto";
import { createLogger } from "../lib/log";
import type { AccountSummary, Budget, GuestAccounts, JanitorInvoker, WorldKeys, WorldObjects, WorldsDeps } from "./deps";
import { TEMPLATE_CUSTOMER_REF_KEY } from "./instantiate";
import type { MemoryAdmin } from "./memory-admin";
import { type FactoryTemplate, type TemplateRow, memoryTemplateSource } from "./template";

const SEED_DATA = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/seed/data");

export const WORLD_TEST_KEYS: WorldKeys = {
  chainKey: "test-register-chain-key-of-32-characters-or-more",
  phoneHash: deriveSubkey("PhoneHashKey", "test-phone-hash-key-of-32-characters-or-more", "phone-hash"),
  emailHash: deriveSubkey("PhoneHashKey", "test-phone-hash-key-of-32-characters-or-more", "email-hash"),
};

interface RawTemplate {
  readonly template: FactoryTemplate;
  readonly items: TemplateRow[];
  readonly settlements: { status: string; seedPath?: string }[];
  readonly [field: string]: unknown;
}

const cache = new Map<FactoryTemplate, RawTemplate>();

function customerOf(row: TemplateRow): string | undefined {
  const fromKey = /#CUS#(cus-[0-9]+)/.exec(row.pk)?.[1];
  return fromKey ?? (typeof row.data.customerId === "string" ? row.data.customerId : undefined);
}

/** A cut of the real template: 12 customers and those the tape names, their history and two register blocks. */
export function smallTemplate(template: FactoryTemplate = "guest"): RawTemplate {
  const cached = cache.get(template);
  if (cached) return cached;
  const full = JSON.parse(readFileSync(join(SEED_DATA, "worlds", `${template === "qa-min" ? "qa-min" : template}.json`), "utf8")) as RawTemplate;
  const allCustomers = full.items.filter((row) => row.entity === "Customer").map((row) => String(row.data.customerId));
  const byRef = new Map(allCustomers.map((customerId) => [hmacSha256Hex(TEMPLATE_CUSTOMER_REF_KEY, customerId), customerId]));
  const onTape = full.items.filter((row) => row.entity === "TapeEntry").map((row) => byRef.get(String(row.data.customerRef)) ?? "");
  const customers = new Set([...allCustomers.slice(0, 12), ...onTape]);
  const complaints = new Set(full.items.filter((row) => row.entity === "Complaint").slice(0, 20).map((row) => String(row.data.complaintId)));
  const networks = full.items.filter((row) => row.table === "Networks");
  const keep = (row: TemplateRow): boolean => {
    switch (row.table) {
      case "Core":
        return customers.has(customerOf(row) ?? "");
      case "Networks":
        return row.entity === "NetworkWorld" || networks.indexOf(row) < 150;
      case "Complaints":
        return complaints.has(String(row.data.complaintId));
      case "Conversations":
        return customers.has(String(row.data.customerId));
      case "Register":
        return row.entity === "RefundEntry" || Number(row.data.seq) <= 230;
      default:
        return true;
    }
  };
  const small: RawTemplate = { ...full, items: full.items.filter(keep), settlements: full.settlements.filter((file) => file.status === "PUBLISHED").slice(0, 3) };
  cache.set(template, small);
  return small;
}

/** S3 as a map of `bucket/key`; the seed objects exist so a copy can find them. */
export function fakeObjects(): WorldObjects & { readonly objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async copySettlement(seedKey, key) {
      objects.set(`Settlements/${key}`, `copy-of:${seedKey}`);
    },
    async deleteUnder(prefix, limit) {
      let deleted = 0;
      for (const name of [...objects.keys()]) {
        if (deleted >= limit) break;
        const [bucket = "", ...rest] = name.split("/");
        if (bucket !== "Exports" && rest.join("/").startsWith(prefix)) {
          objects.delete(name);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

interface FakeActor {
  readonly sessions: Map<string, Set<string>>;
  readonly records: Set<string>;
}

/** Memory: actors with their sessions' events and their records. */
export function fakeMemory(): MemoryAdmin & { readonly actors: Map<string, FakeActor>; add(actorId: string, events?: number, records?: number): void } {
  const actors = new Map<string, FakeActor>();
  const recordOwner = new Map<string, string>();
  return {
    actors,
    add(actorId, events = 2, records = 2) {
      const actor = actors.get(actorId) ?? { sessions: new Map(), records: new Set() };
      actor.sessions.set(`s-${actorId}`, new Set(Array.from({ length: events }, (_, index) => `ev-${actorId}-${actor.sessions.size}-${index}`)));
      for (let index = 0; index < records; index += 1) {
        const id = `rec-${actorId}-${actor.records.size}`;
        actor.records.add(id);
        recordOwner.set(id, actorId);
      }
      actors.set(actorId, actor);
    },
    async listActorIds() {
      return [...actors.keys()];
    },
    async listSessionIds(actorId) {
      return [...(actors.get(actorId)?.sessions.keys() ?? [])];
    },
    async listEventIds(actorId, sessionId) {
      return [...(actors.get(actorId)?.sessions.get(sessionId) ?? [])];
    },
    async deleteEvent(actorId, sessionId, eventId) {
      actors.get(actorId)?.sessions.get(sessionId)?.delete(eventId);
    },
    async listRecordIds(namespacePrefix) {
      const actorId = /^\/customers\/(.+)\/$/.exec(namespacePrefix)?.[1] ?? "";
      return [...(actors.get(actorId)?.records ?? [])];
    },
    async deleteRecord(recordId) {
      const owner = recordOwner.get(recordId);
      if (owner) actors.get(owner)?.records.delete(recordId);
    },
  };
}

/** Accounts of a user pool, deletable. */
export function fakeAccounts(initial: AccountSummary[] = []): GuestAccounts & { readonly accounts: AccountSummary[]; readonly deleted: string[] } {
  const accounts = [...initial];
  const deleted: string[] = [];
  return {
    accounts,
    deleted,
    async list(filter) {
      return accounts.filter((account) => (filter.usernamePrefix ? account.username.startsWith(filter.usernamePrefix) : filter.status ? account.status === filter.status : true));
    },
    async delete(username) {
      deleted.push(username);
      const index = accounts.findIndex((account) => account.username === username);
      if (index >= 0) accounts.splice(index, 1);
    },
  };
}

/** A budget that lasts `blocks` checks and then runs out (a Lambda reaching its 13th minute). */
export function budgetOf(blocks: number): Budget & { checks: number } {
  const budget = {
    checks: 0,
    remainingMs() {
      budget.checks += 1;
      return budget.checks <= blocks ? Number.POSITIVE_INFINITY : 0;
    },
  };
  return budget;
}

export interface WorldsRig {
  readonly deps: WorldsDeps;
  readonly mc: MemoryConnector;
  readonly objects: ReturnType<typeof fakeObjects>;
  readonly memory: ReturnType<typeof fakeMemory>;
  readonly anchors: AnchorRequest[];
  readonly invoked: Parameters<JanitorInvoker["invoke"]>[0][];
  readonly deletedSchedules: string[];
  readonly logs: string[];
  /** Moves the real clock. */
  advance(ms: number): void;
  now(): Date;
}

export function worldsRig(options: { readonly accounts?: GuestAccounts; readonly start?: string } = {}): WorldsRig {
  let at = Date.parse(options.start ?? "2026-10-07T13:10:00.000Z");
  const now = () => new Date(at);
  const mc = testConnector({ now });
  const objects = fakeObjects();
  const memory = fakeMemory();
  const anchors: AnchorRequest[] = [];
  const invoked: WorldsRig["invoked"] = [];
  const deletedSchedules: string[] = [];
  const logs: string[] = [];
  let ids = 0;
  const deps: WorldsDeps = {
    store: mc.store,
    connector: mc.connector,
    templates: memoryTemplateSource({ guest: smallTemplate("guest"), demo: smallTemplate("demo"), "qa-min": smallTemplate("qa-min") }),
    objects,
    schedules: { delete: async (name) => void deletedSchedules.push(name) },
    memory,
    anchors: { request: async (request) => void anchors.push(request) },
    invoker: { invoke: async (event) => void invoked.push(event) },
    keys: () => WORLD_TEST_KEYS,
    log: createLogger({ sink: (line) => void logs.push(line), level: "debug" }),
    now,
    sleep: async (ms) => {
      at += ms;
    },
    newId: () => `01K7${String((ids += 1)).padStart(22, "0")}`,
    ...(options.accounts ? { accounts: options.accounts } : {}),
  };
  return { deps, mc, objects, memory, anchors, invoked, deletedSchedules, logs, advance: (ms) => void (at += ms), now };
}
