import { describe, expect, it } from "vitest";
import { type ChainBuild, appendChained } from "../complaints/register";
import { MemoryAnchorLog, TEST_CHAIN_KEY, complaintsKit } from "../complaints/testing";
import { SIM_NOW, TEST_NOW, worldMeta } from "../connector/testing";
import { writeAnchors } from "../handlers/anchor-writer";
import type { TamperPorts } from "./ports";
import { errorTypeOf, toItem } from "./stage-tamper";
import { QA_WORLD, key, qaKit } from "./testing";

const TABLE_ARNS = ["Register", "ComplianceTape", "AuditLog"].map((table) => `arn:aws:dynamodb:us-east-1:776805327629:table/app-poc-${table}`);

/** What IAM does with the driver's role, over the memory tables: update, delete and conditional puts denied. */
function iamLike(store: unknown, anchors: MemoryAnchorLog): TamperPorts {
  const register = () => (store as { readonly tables: Map<string, Map<string, Record<string, unknown>>> }).tables.get("Register");
  return {
    appendOnlyTableArns: () => TABLE_ARNS,
    updateRegister: async () => "AccessDeniedException",
    deleteRegister: async () => "AccessDeniedException",
    async putRegister(item, condition) {
      if (condition !== undefined || !String(item.pk).startsWith(`W#${QA_WORLD}#`)) return "AccessDeniedException";
      register()?.set(`${String(item.pk)}\u0000${String(item.sk)}`, { ...item });
      return "OK";
    },
    async putAnchor(stream, message, timestamp) {
      if (!stream.startsWith("qa-")) return "AccessDeniedException";
      anchors.add(stream, message, timestamp);
      return "OK";
    },
  };
}

async function anchoredQaRegister(count: number) {
  const anchors = new MemoryAnchorLog();
  const kit = complaintsKit({
    worldId: QA_WORLD,
    onAnchor: async (request) => {
      await writeAnchors(request, { connector: kit.connector, sink: anchors.sink(), log: kit.log, now: () => TEST_NOW });
    },
  });
  await kit.connector.worlds.register(worldMeta(QA_WORLD, { status: "READY" }));
  await kit.connector.runtime.putClock({ worldId: QA_WORLD, mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
  for (let index = 1; index <= count; index += 1) {
    await appendChained(kit.deps, {
      chain: "REG",
      worldId: QA_WORLD,
      epoch: 1,
      build: (): ChainBuild<"REG"> => ({ entry: { eventType: index === 1 ? "FILED" : "STATUS", atSim: SIM_NOW, complaintId: "cmp-0001", complaintNumber: "R-2026-000123", kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED", channel: "WHATSAPP", origin: "LIVE", reason: `step-${index}` } }),
    });
  }
  const qa = qaKit({ mc: { connector: kit.connector, store: kit.store }, overrides: { anchors, chainKey: () => TEST_CHAIN_KEY, tamper: () => iamLike(kit.store, anchors) } });
  return { kit, qa };
}

describe("register.tamperProbe [FL-014]", () => {
  it("[FL-014] update and delete are denied, an overwrite is detected at its seq, a rehashed rewrite with a back-dated anchor conflicts", async () => {
    const { qa } = await anchoredQaRegister(5);
    const answer = await qa.driver({ action: "register.tamperProbe", idempotencyKey: key(1, "sc18"), input: { worldId: QA_WORLD, overwriteSeq: 2, rechainSeq: 4 } });
    expect(answer).toMatchObject({
      ok: true,
      result: {
        updateDenied: true,
        deleteDenied: true,
        overwriteDetected: true,
        anchorConflict: true,
        foreignAnchorDenied: true,
        crossWorldDenied: true,
        tables: TABLE_ARNS,
        steps: { afterOverwrite: { result: "broken", brokenAt: 2 }, afterRechain: { result: "broken", anchorConflicts: [4] } },
      },
    });
  });

  it("[FL-014] never claims a detection the chain did not make", async () => {
    const { qa } = await anchoredQaRegister(5);
    const silent: TamperPorts = { appendOnlyTableArns: () => TABLE_ARNS, updateRegister: async () => "OK", deleteRegister: async () => "OK", putRegister: async () => "OK", putAnchor: async () => "OK" };
    const driver = qaKit({ mc: { connector: qa.ports.data, store: qa.ports.store }, overrides: { anchors: qa.ports.anchors, chainKey: () => TEST_CHAIN_KEY, tamper: () => silent } }).driver;
    const answer = await driver({ action: "register.tamperProbe", idempotencyKey: key(2, "sc18"), input: { worldId: QA_WORLD, overwriteSeq: 2, rechainSeq: 4 } });
    expect(answer).toMatchObject({ ok: true, result: { updateDenied: false, deleteDenied: false, overwriteDetected: false, anchorConflict: false, foreignAnchorDenied: false, crossWorldDenied: false } });
  });

  it("refuses a rewrite order that would repair the overwrite", async () => {
    const { qa } = await anchoredQaRegister(3);
    expect(await qa.driver({ action: "register.tamperProbe", idempotencyKey: key(3, "sc18"), input: { worldId: QA_WORLD, overwriteSeq: 3, rechainSeq: 2 } })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("speaks DynamoDB's JSON and reads its error types", () => {
    expect(toItem({ pk: "W#x#REG#e1", seq: 2, ok: true, list: ["a"], map: { n: null } })).toEqual({ pk: { S: "W#x#REG#e1" }, seq: { N: "2" }, ok: { BOOL: true }, list: { L: [{ S: "a" }] }, map: { M: { n: { NULL: true } } } });
    expect(errorTypeOf({ __type: "com.amazon.coral.service#AccessDeniedException" })).toBe("AccessDeniedException");
    expect(errorTypeOf(undefined)).toBe("unknown");
  });
});
