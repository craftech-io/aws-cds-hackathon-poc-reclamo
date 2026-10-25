import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countAutomaticReversals } from "../complaints/caps";
import { keys } from "../connector/keys";
import { worldsRig } from "../worlds/testing";
import { QA_REASON } from "./contract";
import { QA_WORLD, RUN, key, qaKit } from "./testing";
import { ModelsDocument, cloneModels, qaPhone } from "./world-models";

const MODELS_FILE = join(import.meta.dirname, "../../../../scripts/seed/data/worlds/models.json");

/** A cut of the real models: the shared clock, timers, networks, C01's pending line and two personas. */
function smallModels(): ModelsDocument {
  const full = ModelsDocument.parse(JSON.parse(readFileSync(MODELS_FILE, "utf8")));
  const shared = full.shared.filter(
    (row) => row.table === "Runtime" || row.table === "Timers" || row.entity === "NetworkWorld" || JSON.stringify(row).includes("cus-0001") || row.pk.includes("#NET#NORTE") && row.entity === "SettlementBatch" && row.sk.includes("2026-10-07"),
  );
  const personas = Object.fromEntries(["C01", "C17"].flatMap((id) => (full.personas[id] ? [[id, full.personas[id]]] : [])));
  return { ...full, shared, personas, settlements: full.settlements.slice(0, 2) };
}

const MODELS = smallModels();
const FILES = MODELS.settlements.flatMap((file) => (file.seedPath ? [file.seedPath] : []));
const CSV = {
  [FILES[0] ?? "a"]: "network;businessDate;operationCode;paidAt;amount;customerRef;loanRef\nNORTE;2026-08-26;NTE-1;2026-08-26T08:24:00-03:00;100.00;cus-0017;L-0017\n",
  [FILES[1] ?? "b"]: "network;businessDate;operationCode;paidAt;amount;customerRef;loanRef\nNORTE;2026-08-27;NTE-2;2026-08-27T08:24:00-03:00;100.00;cus-1001;L-1001\n",
};

function rig() {
  const worlds = worldsRig();
  let at = worlds.now().getTime();
  // Every read of the real clock moves it 5 s: a step runs out of its 50 s within a few blocks.
  const now = () => new Date((at += 5_000));
  const kit = qaKit({ mc: worlds.mc, worlds: () => worlds.deps, models: MODELS, csv: CSV, now });
  return { worlds, kit };
}

const create = { runId: RUN, scenario: "sc01", personas: [{ key: "a", model: "C01" }, { key: "b", model: "C17", emailOverride: "bounce" }] };

async function createReady(kit: ReturnType<typeof rig>["kit"]): Promise<{ steps: number; result: unknown }> {
  for (let steps = 1; steps <= 60; steps += 1) {
    const answer = await kit.driver({ action: "world.create", idempotencyKey: key(1), input: create });
    if (!answer.ok) throw new Error(JSON.stringify(answer.error));
    if ((answer.result as { state: string }).state === "READY") return { steps, result: answer.result };
  }
  throw new Error("the world never became READY");
}

describe("world.create from the models", () => {
  it("builds by blocks as a non-blocking probe, resuming from the cursor, until READY", async () => {
    const { kit, worlds } = rig();
    const { steps, result } = await createReady(kit);
    expect(steps).toBeGreaterThan(1);
    expect(result).toMatchObject({ state: "READY", epoch: 1 });
    expect(await worlds.mc.connector.worlds.getMeta(QA_WORLD)).toMatchObject({ status: "READY", kind: "QA", template: "models" });
    // READY is remembered: the same step answers it again without building anything.
    expect(await kit.driver({ action: "world.create", idempotencyKey: key(1), input: create })).toMatchObject({ ok: true, replayed: true, result: { state: "READY" } });
  });

  it("clones each persona with its own id, a leased QA phone and the run's simulator mailbox", async () => {
    const { kit, worlds } = rig();
    await createReady(kit);
    const a = await worlds.mc.store.get("Core", { pk: `W#${QA_WORLD}#CUS#cus-${QA_WORLD}-a`, sk: "META" });
    const b = await worlds.mc.store.get("Core", { pk: `W#${QA_WORLD}#CUS#cus-${QA_WORLD}-b`, sk: "META" });
    expect(a).toMatchObject({ customerId: `cus-${QA_WORLD}-a`, emailMasked: "s***@simulator.amazonses.com" });
    expect(b).toMatchObject({ customerId: `cus-${QA_WORLD}-b`, emailMasked: "b***@simulator.amazonses.com" });
    // The clear contact data never reaches a table: only its hashes.
    expect(a?.["phoneE164"]).toBeUndefined();
    expect(a?.["email"]).toBeUndefined();
    expect(await worlds.mc.store.get("Core", { pk: `W#${QA_WORLD}#CUS#cus-0001`, sk: "META" })).toBeUndefined();
    const lease = await worlds.mc.connector.claims.getIdempotency(QA_WORLD, "QAPERSONA", "a");
    expect(lease?.result?.["phoneE164"]).toMatch(/^\+5491100009\d{3}$/);
    expect(await worlds.mc.connector.conversations.getMeta(QA_WORLD, `cus-${QA_WORLD}-a`)).toBeDefined();
  });

  it("keeps the personas' history: the shared line now names the clone, and the register is re-sequenced", async () => {
    const { kit, worlds } = rig();
    await createReady(kit);
    const line = await worlds.mc.store.get("Networks", { pk: `W#${QA_WORLD}#NET#NORTE`, sk: "LINE#2026-10-07#NTE-20261006-004817-2" });
    expect(JSON.stringify(line)).toContain(`cus-${QA_WORLD}-a`);
    expect(JSON.stringify(line)).not.toContain("cus-0001");
    const register = await worlds.mc.connector.chains.listRegister("REG", QA_WORLD, 1);
    expect(register.entries.map((entry) => entry.seq)).toEqual(register.entries.map((_entry, index) => index + 1));
    expect(register.entries.length).toBe(MODELS.personas.C17?.registerEvents.length);
    expect(worlds.anchors.length).toBeGreaterThan(0);
  });

  it("rewrites only the published files that name a cloned persona, and copies the rest", async () => {
    const { kit, worlds } = rig();
    await createReady(kit);
    const rewritten = [...kit.recorded.settlements.entries()];
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.[1]).toContain(`cus-${QA_WORLD}-b`);
    expect(rewritten[0]?.[0]).toBe(`qa/${RUN}/${QA_WORLD}/${FILES[0]}`);
    expect(worlds.objects.objects.get(`Settlements/qa/${RUN}/${QA_WORLD}/${FILES[1]}`)).toBe(`copy-of:settlements/models/${FILES[1]}`);
  });

  it("refuses a model cloned twice in one world", () => {
    expect(() => cloneModels(MODELS, [1, 2].map((n) => ({ key: `k${n}`, model: "C01", customerId: `cus-x-${n}`, phoneE164: qaPhone(9000 + n), email: "x" })))).toThrow(
      expect.objectContaining({ code: "INVALID", reason: QA_REASON.DUPLICATE_MODEL }),
    );
  });

  it("starts new complaint numbers above every historical number of the models", async () => {
    const { kit, worlds } = rig();
    await createReady(kit);
    const counter = await worlds.mc.store.get("Runtime", { pk: `W#${QA_WORLD}#COUNTER#CMP#e1#2026`, sk: "META" });
    expect(Number(counter?.["value"])).toBeGreaterThanOrEqual(120);
  });
});

describe("world.create with history [FL-040]", () => {
  const history = [
    { persona: "a", action: "REVERSE_CHARGE", amountCents: 120_000, daysAgo: 6 },
    { persona: "a", action: "REFUND_DUPLICATE", amountCents: 90_000, daysAgo: 15 },
  ];

  async function readyWith(input: Record<string, unknown>) {
    const { kit, worlds } = rig();
    for (let steps = 1; steps <= 60; steps += 1) {
      const answer = await kit.driver({ action: "world.create", idempotencyKey: key(1), input });
      if (!answer.ok) return { worlds, error: answer.error };
      if ((answer.result as { state: string }).state === "READY") return { worlds, error: undefined };
    }
    throw new Error("the world never became READY");
  }

  it("[FL-040] writes each earlier action as a closed complaint the monthly limit counts, chained in the register", async () => {
    const { worlds, error } = await readyWith({ ...create, history });
    expect(error).toBeUndefined();
    const customerId = `cus-${QA_WORLD}-a`;
    const complaints = (await worlds.mc.connector.complaints.listByCustomer(QA_WORLD, customerId)).filter((complaint) => complaint.complaintId.startsWith("cmp-qh-"));
    // Numbered in filing order: the refund of 15 days ago first.
    expect(complaints.map((complaint) => [complaint.complaintNumber, complaint.type, complaint.status]).sort()).toEqual([
      ["R-2026-000121", "DUPLICATE_DEBIT", "CLOSED"],
      ["R-2026-000122", "UNRECOGNIZED_CHARGE", "CLOSED"],
    ]);
    expect(await countAutomaticReversals(worlds.mc.connector, { worldId: QA_WORLD, customerId, simNow: MODELS.startAtSim })).toBe(2);
    const register = await worlds.mc.connector.chains.listRegister("REG", QA_WORLD, 1);
    expect(register.entries).toHaveLength((MODELS.personas.C17?.registerEvents.length ?? 0) + 8);
    expect(register.entries.map((entry) => entry.seq)).toEqual(register.entries.map((_entry, index) => index + 1));
    const counter = await worlds.mc.store.get("Runtime", { pk: `W#${QA_WORLD}#COUNTER#CMP#e1#2026`, sk: "META" });
    expect(Number(counter?.["value"])).toBe(122);
  });

  it("refuses a history of a persona the request did not clone", async () => {
    const { error } = await readyWith({ ...create, history: [{ persona: "z", action: "REVERSE_CHARGE", amountCents: 1_000, daysAgo: 3 }] });
    expect(error).toMatchObject({ code: "INVALID", reason: "HISTORY_PERSONA" });
  });
});

describe("world.destroy", () => {
  it("destroys the world by steps and deletes its QA users", async () => {
    const { kit, worlds } = rig();
    await createReady(kit);
    await kit.driver({ action: "auth.session", idempotencyKey: key(2), input: { worldId: QA_WORLD, sessionKey: "op", role: "OPERATOR" } });
    expect(kit.cognito.users.size).toBe(1);
    let answer: unknown;
    for (let step = 0; step < 30; step += 1) {
      const response = await kit.driver({ action: "world.destroy", idempotencyKey: key(3), input: { worldId: QA_WORLD } });
      answer = response.ok ? response.result : response.error;
      if ((answer as { state?: string }).state === "DESTROYED") break;
    }
    expect(answer).toMatchObject({ state: "DESTROYED", usersDeleted: 4 });
    expect(kit.cognito.users.size).toBe(0);
    expect(await worlds.mc.connector.worlds.getMeta(QA_WORLD)).toBeUndefined();
    expect(await worlds.mc.connector.runtime.getTombstone(QA_WORLD, 1)).toBeDefined();
    expect(await worlds.mc.store.get("Worlds", keys.worldMeta(QA_WORLD))).toBeUndefined();
  });
});
