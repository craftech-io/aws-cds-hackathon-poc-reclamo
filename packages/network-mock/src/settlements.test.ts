import { createHash } from "node:crypto";
import { type CollectionRequest, parseSettlementCsv } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { businessDateOf, publishAtOf } from "./business-date";
import { luhnDigit, operationCodeFor, otherPayerLines } from "./other-payers";
import { DEFAULT_SETTLEMENT_DELAYS, items } from "./store/items";
import { TEST_HOLIDAYS, TEST_REAL_NOW, createInProcessNetworkMock } from "./testing";
import { settlementKey, worldRoot } from "./world-root";

const NORTE = DEFAULT_SETTLEMENT_DELAYS.NORTE;
const SUR = DEFAULT_SETTLEMENT_DELAYS.SUR;
const HOLIDAYS = [...TEST_HOLIDAYS];
const SIM_NOW = "2026-10-07T10:10:00-03:00";
/** A scenario world: registered collections come from the QA driver, which only reaches QA worlds. */
const QA_WORLD = "qa-812345-1-sc01";
const QA_ROOT = "qa/812345-1/qa-812345-1-sc01/";

/** C01's payment of the main story (docs/seed-spec.md §8): NORTE, Tue 06/10 18:40, after the cut-off. */
const C01: CollectionRequest = {
  network: "NORTE",
  operationCode: operationCodeFor("NORTE", "2026-10-06", "004817"),
  paidAtSim: "2026-10-06T18:40:00-03:00",
  amount: 11_864_000,
  customerRef: "cus-0001",
  loanRef: "L-0001",
  instalment: 4,
  terminal: "T-0412",
};

function setup(worldId = QA_WORLD, options: Parameters<ReturnType<typeof createInProcessNetworkMock>["seedWorld"]>[1] = {}) {
  const mock = createInProcessNetworkMock();
  mock.seedWorld(worldId, options);
  const collect = (body: CollectionRequest, simNow = SIM_NOW) => mock.call("QaDriver", { method: "POST", path: `/v1/${worldId}/collections`, simNow, body });
  const publish = (network: string, date: string, simNow = "2026-10-08T08:30:00-03:00", role: "ScheduleDispatch" | "QaDriver" = "ScheduleDispatch") =>
    mock.call(role, { method: "POST", path: `/v1/${worldId}/settlements/${network}/${date}/publish`, simNow });
  const list = (network: string, from: string, to: string) => mock.call("ToolInvestigation", { method: "GET", path: `/v1/${worldId}/settlements/${network}`, query: `from=${from}&to=${to}`, simNow: SIM_NOW });
  return { mock, collect, publish, list };
}

/** The template's pending batch NORTE 07/10 (docs/seed-spec.md §7): C01's payment and another payer's. */
function seedTemplateBatch(mock: ReturnType<typeof createInProcessNetworkMock>, worldId: string): void {
  const { paidAtSim, ...collection } = C01;
  const line = { ...collection, paidAt: paidAtSim, businessDate: "2026-10-07" };
  const other = { ...line, operationCode: operationCodeFor("NORTE", "2026-10-07", "001017"), paidAt: "2026-10-07T12:00:00-03:00", customerRef: "cus-1017", loanRef: "L-1017", amount: 5_000_000 };
  mock.store.putRaw(
    items.batch({ worldId, network: "NORTE", businessDate: "2026-10-07", status: "PENDING", publishAtSim: "2026-10-08T08:30:00-03:00", seq: 1, version: 1 }, TEST_REAL_NOW),
    items.line({ worldId, line, origin: "SEED" }, TEST_REAL_NOW),
    items.line({ worldId, line: other, origin: "SEED" }, TEST_REAL_NOW),
  );
}

describe("business dates by cut-off", () => {
  it("[FL-017] a NORTE payment after 18:00 belongs to the next business day, published D+1 at 08:30", () => {
    expect(businessDateOf("2026-10-06T18:40:00-03:00", NORTE, HOLIDAYS)).toBe("2026-10-07");
    expect(publishAtOf("2026-10-07", NORTE, HOLIDAYS)).toBe("2026-10-08T08:30:00-03:00");
  });

  it("keeps a payment before the cut-off on its own day; the cut-off itself is already after it", () => {
    expect(businessDateOf("2026-10-06T17:59:00-03:00", NORTE, HOLIDAYS)).toBe("2026-10-06");
    expect(businessDateOf("2026-10-06T18:00:00-03:00", NORTE, HOLIDAYS)).toBe("2026-10-07");
    // The same instant written in UTC lands on the same Argentina date.
    expect(businessDateOf("2026-10-06T21:40:00Z", NORTE, HOLIDAYS)).toBe("2026-10-07");
  });

  it("SUR cuts at 16:00 and publishes D+2 at 11:00", () => {
    expect(businessDateOf("2026-10-06T15:00:00-03:00", SUR, HOLIDAYS)).toBe("2026-10-06");
    expect(publishAtOf("2026-10-06", SUR, HOLIDAYS)).toBe("2026-10-08T11:00:00-03:00");
    expect(businessDateOf("2026-10-06T16:30:00-03:00", SUR, HOLIDAYS)).toBe("2026-10-07");
    expect(publishAtOf("2026-10-07", SUR, HOLIDAYS)).toBe("2026-10-09T11:00:00-03:00");
  });

  it("skips weekends and the world's holidays", () => {
    // Fri 09/10 after the cut-off → Tue 13/10 (Mon 12/10 is a holiday); a Saturday payment too.
    expect(businessDateOf("2026-10-09T19:00:00-03:00", NORTE, HOLIDAYS)).toBe("2026-10-13");
    expect(businessDateOf("2026-10-10T10:00:00-03:00", NORTE, HOLIDAYS)).toBe("2026-10-13");
    expect(publishAtOf("2026-10-09", NORTE, HOLIDAYS)).toBe("2026-10-13T08:30:00-03:00");
    expect(businessDateOf("2026-10-09T19:00:00-03:00", NORTE, [])).toBe("2026-10-12");
  });
});

describe("operation codes of other payers", () => {
  it("computes the Luhn digit over the 14 digits and opens batches with distinct payers", () => {
    expect(luhnDigit("7992739871")).toBe(3);
    expect(operationCodeFor("SUR", "2026-10-06", "123456")).toMatch(/^SUR-20261006-123456-\d$/);
    const lines = otherPayerLines("demo", "NORTE", "2026-10-07");
    expect(lines).toEqual(otherPayerLines("demo", "NORTE", "2026-10-07"));
    expect(new Set(lines.map((line) => line.operationCode)).size).toBe(lines.length);
    for (const line of lines) {
      expect(line.customerRef).toMatch(/^cus-9\d{3}$/);
      expect(line.loanRef).toMatch(/^L-9\d{3}$/);
      expect(line.businessDate).toBe("2026-10-07");
    }
  });
});

describe("[FL-017] pending batch, settled when the network publishes", () => {
  it("[FL-017] registers C01's payment in the PENDING batch of 07/10 with its publication time", async () => {
    const { mock, collect } = setup();
    const response = await collect(C01);
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      network: "NORTE",
      operationCode: C01.operationCode,
      businessDate: "2026-10-07",
      batch: { network: "NORTE", businessDate: "2026-10-07", status: "PENDING", publishAtSim: "2026-10-08T08:30:00-03:00" },
      batchCreated: true,
    });
    // The batch the mock opened carries other payers' payments besides C01's.
    const lines = mock.store.dump().filter((raw) => raw.entity === "SettlementLine");
    expect(lines.filter((raw) => raw.origin === "OTHER_PAYER")).toHaveLength(3);
    expect(lines.every((raw) => raw.worldIndexKey === `W#${QA_WORLD}#` && String(raw.pk).startsWith(`W#${QA_WORLD}#NET#NORTE`))).toBe(true);
  });

  it("[FL-017] publishes the CSV in Settlements with its sha256, the customer's line and other payers' lines", async () => {
    const { mock, collect, publish, list } = setup();
    await collect(C01);
    await collect({ ...C01, operationCode: operationCodeFor("NORTE", "2026-10-07", "000777"), paidAtSim: "2026-10-07T09:00:00-03:00", customerRef: "cus-0002", loanRef: "L-0002" });
    expect((await list("NORTE", "2026-10-01", "2026-10-07")).json).toMatchObject({ network: "NORTE", batches: [{ businessDate: "2026-10-07", status: "PENDING" }] });

    const published = await publish("NORTE", "2026-10-07");
    expect(published.statusCode).toBe(200);
    const key = `${QA_ROOT}NORTE/2026-10-07/batch-1.csv`;
    const csv = mock.objects.get(key) ?? "";
    expect(published.json).toEqual({
      outcome: "PUBLISHED",
      batch: {
        network: "NORTE",
        businessDate: "2026-10-07",
        status: "PUBLISHED",
        publishAtSim: "2026-10-08T08:30:00-03:00",
        publishedAtSim: "2026-10-08T08:30:00-03:00",
        s3Key: key,
        lineCount: 5,
        sha256: createHash("sha256").update(csv, "utf8").digest("hex"),
      },
    });
    const lines = parseSettlementCsv(csv, { network: "NORTE", businessDate: "2026-10-07" });
    expect(lines).toHaveLength(5);
    expect(lines.find((line) => line.operationCode === C01.operationCode)).toMatchObject({ customerRef: "cus-0001", loanRef: "L-0001", amount: 11_864_000, paidAt: C01.paidAtSim });
    expect(lines.filter((line) => !["cus-0001", "cus-0002"].includes(line.customerRef))).toHaveLength(3);
    // In time order: C01's 06/10 18:40 payment first.
    expect(lines[0]?.operationCode).toBe(C01.operationCode);

    // Idempotent: the second publication (a retried timer) changes nothing.
    const again = await publish("NORTE", "2026-10-07", "2026-10-08T09:00:00-03:00");
    expect(again.json).toMatchObject({ outcome: "ALREADY_PUBLISHED", batch: { sha256: (published.json as { batch: { sha256: string } }).batch.sha256 } });
    expect((await list("NORTE", "2026-10-07", "2026-10-07")).json).toMatchObject({ batches: [{ status: "PUBLISHED", s3Key: key, lineCount: 5 }] });
  });

  it("[FL-017] answers an idempotent retry of a registration with its first answer, and refuses a reused code", async () => {
    const { collect } = setup();
    const first = await collect(C01);
    const retry = await collect(C01, "2026-10-07T10:11:00-03:00");
    expect(retry.statusCode).toBe(200);
    expect(retry.json).toEqual(first.json);
    const reused = await collect({ ...C01, amount: 100 });
    expect(reused.statusCode).toBe(409);
    expect(reused.json).toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a payment registered before it is made, and one for a batch already published", async () => {
    const { collect, publish } = setup();
    const early = await collect(C01, "2026-10-06T18:00:00-03:00");
    expect(early.statusCode).toBe(400);
    await collect(C01);
    await publish("NORTE", "2026-10-07");
    const late = await collect({ ...C01, operationCode: operationCodeFor("NORTE", "2026-10-07", "000999"), paidAtSim: "2026-10-07T09:00:00-03:00" }, "2026-10-08T09:00:00-03:00");
    expect(late.statusCode).toBe(409);
  });

  it("never loses a collection that races the publication: the publisher rereads and the file has it", async () => {
    const { mock, collect } = setup();
    await collect(C01);
    const store = mock.store;
    const listLines = store.listLines.bind(store);
    let raced = false;
    store.listLines = async (...args) => {
      const lines = await listLines(...args);
      if (!raced) {
        raced = true;
        const racing = await collect({ ...C01, operationCode: operationCodeFor("NORTE", "2026-10-07", "000555"), paidAtSim: "2026-10-07T11:00:00-03:00", customerRef: "cus-0003", loanRef: "L-0003" }, "2026-10-07T12:00:00-03:00");
        expect(racing.statusCode).toBe(200);
      }
      return lines;
    };
    const published = await mock.call("ScheduleDispatch", { method: "POST", path: `/v1/${QA_WORLD}/settlements/NORTE/2026-10-07/publish`, simNow: "2026-10-08T08:30:00-03:00" });
    expect(published.json).toMatchObject({ outcome: "PUBLISHED", batch: { lineCount: 5 } });
    expect(parseSettlementCsv(mock.objects.get(`${QA_ROOT}NORTE/2026-10-07/batch-1.csv`) ?? "").map((line) => line.customerRef)).toContain("cus-0003");
  });

  it("[FL-017] publishes the demo template's pending batch of 07/10 when ScheduleDispatch fires its timer", async () => {
    const { mock, publish } = setup("demo");
    seedTemplateBatch(mock, "demo");
    const published = await publish("NORTE", "2026-10-07");
    expect(published.json).toMatchObject({ outcome: "PUBLISHED", batch: { s3Key: "W/demo/NORTE/2026-10-07/batch-1.csv", lineCount: 2, publishedAtSim: "2026-10-08T08:30:00-03:00" } });
    const lines = parseSettlementCsv(mock.objects.get("W/demo/NORTE/2026-10-07/batch-1.csv") ?? "");
    expect(lines.map((line) => line.customerRef)).toEqual(["cus-0001", "cus-1017"]);
    // demo items never expire; a QA world's do.
    expect(mock.store.dump().find((raw) => raw.entity === "SettlementBatch")?.expiresAt).toBeUndefined();
    expect(worldRoot("qamin")).toBe("qa/qamin/");
    expect(worldRoot("gs-abcdefghij")).toBe("W/gs-abcdefghij/");
    expect(settlementKey("demo", "SUR", "2026-10-06", 2)).toBe("W/demo/SUR/2026-10-06/batch-2.csv");
  });

  it("answers 404 for a batch that does not exist and 400 for a range over 31 days", async () => {
    const { publish, list } = setup();
    expect((await publish("SUR", "2026-10-06")).json).toMatchObject({ code: "NOT_FOUND" });
    expect((await list("NORTE", "2026-09-01", "2026-10-07")).statusCode).toBe(400);
    expect((await list("NORTE", "2026-10-07", "2026-10-01")).statusCode).toBe(400);
  });

  it("uses the world's own settlement delays", async () => {
    const { collect } = setup(QA_WORLD, { settlementDelays: { NORTE: { businessDays: 2, publishAt: "07:00", cutoff: "20:00" } } });
    const response = await collect(C01);
    expect(response.json).toMatchObject({ businessDate: "2026-10-06", batch: { publishAtSim: "2026-10-08T07:00:00-03:00" } });
  });
});

describe("faults per world", () => {
  it("LATE_PUBLISH defers the first publication once, then publishes at the new time", async () => {
    const worldId = "qa-812345-1-sc01";
    const { collect, publish } = setup(worldId, { faults: [{ kind: "LATE_PUBLISH", network: "NORTE", minutes: 90 }] });
    await collect(C01);
    const deferred = await publish("NORTE", "2026-10-07");
    expect(deferred.json).toMatchObject({ outcome: "DEFERRED", batch: { status: "PENDING", publishAtSim: "2026-10-08T10:00:00-03:00" } });
    expect((await publish("NORTE", "2026-10-07", "2026-10-08T09:00:00-03:00")).json).toMatchObject({ outcome: "DEFERRED", batch: { publishAtSim: "2026-10-08T10:00:00-03:00" } });
    expect((await publish("NORTE", "2026-10-07", "2026-10-08T10:00:00-03:00")).json).toMatchObject({ outcome: "PUBLISHED", batch: { publishedAtSim: "2026-10-08T10:00:00-03:00" } });
  });

  it("MISSING_LINE omits the line from the published file", async () => {
    const worldId = "qamin";
    const { mock, collect, publish } = setup(worldId, { faults: [{ kind: "MISSING_LINE", network: "NORTE", operationCode: C01.operationCode }] });
    await collect(C01);
    expect((await publish("NORTE", "2026-10-07")).json).toMatchObject({ outcome: "PUBLISHED", batch: { lineCount: 3 } });
    const csv = mock.objects.get("qa/qamin/NORTE/2026-10-07/batch-1.csv") ?? "";
    expect(parseSettlementCsv(csv).map((line) => line.operationCode)).not.toContain(C01.operationCode);
  });

  it("ERROR_503 answers 503 on every world route of a QA world; health still answers", async () => {
    const worldId = "qa-812345-1-sc02";
    const { mock, collect } = setup(worldId, { faults: [{ kind: "ERROR_503" }] });
    expect((await collect(C01)).json).toMatchObject({ code: "UNAVAILABLE" });
    expect((await mock.call("QaDriver", { method: "GET", path: "/v1/health" })).statusCode).toBe(200);
  });

  it("outside QA worlds only a fault scoped to one batch applies, and never ERROR_503", async () => {
    const { mock, list, publish } = setup("demo", {
      faults: [{ kind: "ERROR_503" }, { kind: "MISSING_LINE", network: "NORTE" }, { kind: "LATE_PUBLISH", network: "NORTE", businessDate: "2026-10-07", minutes: 30 }],
    });
    seedTemplateBatch(mock, "demo");
    expect((await list("NORTE", "2026-10-07", "2026-10-07")).statusCode).toBe(200);
    expect((await publish("NORTE", "2026-10-07")).json).toMatchObject({ outcome: "DEFERRED", batch: { publishAtSim: "2026-10-08T09:00:00-03:00" } });
    expect((await publish("NORTE", "2026-10-07", "2026-10-08T09:00:00-03:00")).json).toMatchObject({ outcome: "PUBLISHED", batch: { lineCount: 2 } });
  });
});
