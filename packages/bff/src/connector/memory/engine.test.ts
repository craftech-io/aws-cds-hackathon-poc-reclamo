// The in-memory engine keeps DynamoDB's semantics the domain relies on: conditions on missing
// attributes, nested paths, all-or-nothing transactions, sparse indexes, key order, append-only.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@reclamo/shared";
import { TransactionCancelledError } from "../errors";
import { type WriteOp, cond } from "../store";
import { MemoryStore } from "./engine";
import { applyUpdate, evaluate } from "./evaluate";

const key = { pk: "W#demo#CMP#cmp-1", sk: "META" };
const item = { ...key, status: "INVESTIGATING", version: 3, answer: { messageId: "msg-1" }, tags: new Set(["a"]), list: [1, 2], name: "Ana" };

async function expectCode(promise: Promise<unknown>, code: string): Promise<ConnectorError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).code).toBe(code);
  return error as ConnectorError;
}

describe("conditions, as DynamoDB evaluates them", () => {
  it("reads a missing attribute or item as absent, never as equal", () => {
    expect(evaluate(cond.notExists("pk"), undefined)).toBe(true);
    expect(evaluate(cond.exists("pk"), undefined)).toBe(false);
    expect(evaluate(cond.eq("version", 3), undefined)).toBe(false);
    expect(evaluate(cond.not(cond.eq("version", 3)), undefined)).toBe(true);
    expect(evaluate(cond.notExists("answer.inFlight"), item)).toBe(true);
    expect(evaluate(cond.eq("answer.messageId", "msg-1"), item)).toBe(true);
  });

  it("compares only values of the same type", () => {
    expect(evaluate(cond.lt("version", 4), item)).toBe(true);
    expect(evaluate(cond.lt("version", "4"), item)).toBe(false);
    expect(evaluate(cond.ge("name", "Ana"), item)).toBe(true);
    expect(evaluate(cond.in("status", ["REGISTERED", "INVESTIGATING"]), item)).toBe(true);
    expect(evaluate(cond.in("status", ["RESOLVED"]), item)).toBe(false);
  });

  it("supports begins_with, contains on strings, sets and lists, and boolean composition", () => {
    expect(evaluate(cond.beginsWith("pk", "W#demo#"), item)).toBe(true);
    expect(evaluate(cond.contains("tags", "a"), item)).toBe(true);
    expect(evaluate(cond.contains("list", 2), item)).toBe(true);
    expect(evaluate(cond.contains("name", "n"), item)).toBe(true);
    expect(evaluate(cond.and(cond.eq("version", 3), cond.or(cond.eq("status", "X"), cond.present())), item)).toBe(true);
  });
});

describe("updates, as DynamoDB applies them", () => {
  it("sets, appends, adds, deletes from sets and removes, and refuses a nested path without its parent", () => {
    const after = applyUpdate(item, {
      set: { "answer.deliveryProof": "SENT" },
      setIfNotExists: { createdAt: "x", name: "kept?" },
      append: { history: ["h1"] },
      add: { version: 1, tags: ["b"] },
      remove: ["list"],
    });
    expect(after).toMatchObject({ answer: { messageId: "msg-1", deliveryProof: "SENT" }, createdAt: "x", name: "Ana", history: ["h1"], version: 4 });
    expect(after.tags).toEqual(new Set(["a", "b"]));
    expect(after.list).toBeUndefined();
    expect(applyUpdate(after, { deleteFromSet: { tags: ["a", "b"] } }).tags).toBeUndefined();
    expect(() => applyUpdate({ ...key }, { set: { "answer.inFlight": "m" } })).toThrow(ConnectorError);
    expect(item.version).toBe(3);
  });
});

describe("MemoryStore", () => {
  it("returns copies: a caller never mutates what is stored", async () => {
    const store = new MemoryStore();
    await store.write({ kind: "put", table: "Complaints", item: { ...key, nested: { a: 1 } } });
    const read = (await store.get("Complaints", key)) as unknown as { nested: { a: number } };
    read.nested.a = 99;
    expect(await store.get("Complaints", key)).toMatchObject({ nested: { a: 1 } });
  });

  it("fails a conditional write with CONFLICT and leaves the item as it was", async () => {
    const store = new MemoryStore();
    await store.write({ kind: "put", table: "Complaints", item: { ...key, version: 1 }, condition: cond.absent() });
    await expectCode(store.write({ kind: "put", table: "Complaints", item: { ...key, version: 9 }, condition: cond.absent() }), "CONFLICT");
    const after = await store.write({ kind: "update", table: "Complaints", key, condition: cond.eq("version", 1), update: { set: { version: 2 } } });
    expect(after).toMatchObject({ version: 2 });
    await expectCode(store.write({ kind: "update", table: "Complaints", key, condition: cond.eq("version", 1), update: { set: { version: 3 } } }), "CONFLICT");
    expect(await store.get("Complaints", key)).toMatchObject({ version: 2 });
  });

  it("runs a transaction all or nothing and reports the reason of each operation", async () => {
    const store = new MemoryStore();
    await store.write({ kind: "put", table: "Runtime", item: { pk: "W#demo#COUNTER#REGSEQ#e1", sk: "META", value: 4 } });
    const ops: WriteOp[] = [
      { kind: "update", table: "Runtime", key: { pk: "W#demo#COUNTER#REGSEQ#e1", sk: "META" }, condition: cond.eq("value", 4), update: { set: { value: 5 } } },
      { kind: "put", table: "Register", item: { pk: "W#demo#REG#e1", sk: "000000005" }, condition: cond.absent() },
      { kind: "update", table: "Complaints", key, condition: cond.eq("version", 7), update: { set: { status: "RESOLVED" } } },
    ];
    const error = await expectCode(store.transact(ops), "CONFLICT");
    expect(error).toBeInstanceOf(TransactionCancelledError);
    expect((error as TransactionCancelledError).reasons).toEqual(["None", "None", "ConditionalCheckFailed"]);
    expect((error as TransactionCancelledError).failedConditions()).toEqual([2]);
    expect(await store.get("Runtime", { pk: "W#demo#COUNTER#REGSEQ#e1", sk: "META" })).toMatchObject({ value: 4 });
    expect(await store.get("Register", { pk: "W#demo#REG#e1", sk: "000000005" })).toBeUndefined();
  });

  it("cancels a transaction whose condition check fails, and refuses a check outside a transaction", async () => {
    const store = new MemoryStore();
    store.load("Worlds", [{ pk: "W#g01#WORLD", sk: "META", status: "RESETTING" }]);
    const ready: WriteOp = { kind: "check", table: "Worlds", key: { pk: "W#g01#WORLD", sk: "META" }, condition: cond.eq("status", "READY") };
    const error = await expectCode(store.transact([ready, { kind: "put", table: "Complaints", item: { ...key } }]), "CONFLICT");
    expect((error as TransactionCancelledError).reasons).toEqual(["ConditionalCheckFailed", "None"]);
    expect(await store.get("Complaints", key)).toBeUndefined();
    await expectCode(store.write(ready), "VALIDATION");
  });

  it("refuses a transaction that touches one item twice, is empty or has more than 100 operations", async () => {
    const store = new MemoryStore();
    const put: WriteOp = { kind: "put", table: "Complaints", item: { ...key } };
    await expectCode(store.transact([put, { kind: "delete", table: "Complaints", key }]), "VALIDATION");
    await expectCode(store.transact([]), "VALIDATION");
    const many = Array.from({ length: 101 }, (_, index): WriteOp => ({ kind: "put", table: "Complaints", item: { pk: `W#demo#CMP#c${index}`, sk: "META" } }));
    await expectCode(store.transact(many), "VALIDATION");
  });

  it("never updates, deletes or blindly overwrites an append-only table", async () => {
    const store = new MemoryStore();
    const entry = { pk: "W#demo#REG#e1", sk: "000000001" };
    for (const table of ["Register", "ComplianceTape", "AuditLog"] as const) {
      await expectCode(store.write({ kind: "update", table, key: entry, update: { set: { hash: "x" } } }), "VALIDATION");
      await expectCode(store.write({ kind: "delete", table, key: entry }), "VALIDATION");
      await expectCode(store.write({ kind: "put", table, item: entry }), "VALIDATION");
      await store.write({ kind: "put", table, item: entry, condition: cond.absent() });
      await expectCode(store.write({ kind: "put", table, item: entry, condition: cond.absent() }), "CONFLICT");
    }
  });

  it("refuses an update on a key attribute, overlapping paths and an empty update", async () => {
    const store = new MemoryStore();
    await expectCode(store.write({ kind: "update", table: "Complaints", key, update: { set: { pk: "W#g01#CMP#x" } } }), "VALIDATION");
    await expectCode(store.write({ kind: "update", table: "Complaints", key, update: { set: { answer: {} }, remove: ["answer.inFlight"] } }), "VALIDATION");
    await expectCode(store.write({ kind: "update", table: "Complaints", key, update: { set: { a: undefined } } }), "VALIDATION");
  });

  it("queries a sparse index in sort order with a key condition and pages with a cursor", async () => {
    const store = new MemoryStore();
    const due = (id: string, dueSort: string, scheduled: boolean) => ({
      pk: `W#demo#TIMER#SLA#${id}`,
      sk: "META",
      dueSort,
      ...(scheduled ? { clockDueKey: "W#demo#CLOCKDUE" } : {}),
    });
    store.load("Timers", [due("c", "2026-10-09T13:00:00.000Z#000000000", true), due("a", "2026-10-08T13:00:00.000Z#000000000", true), due("b", "2026-10-08T12:00:00.000Z#000000000", false)]);
    const all = await store.query({ table: "Timers", index: "ClockDue", partition: "W#demo#CLOCKDUE" });
    expect(all.items.map((row) => row.pk)).toEqual(["W#demo#TIMER#SLA#a", "W#demo#TIMER#SLA#c"]);
    const until = await store.query({ table: "Timers", index: "ClockDue", partition: "W#demo#CLOCKDUE", sort: { op: "le", value: "2026-10-08T23:59:59.999Z" } });
    expect(until.items).toHaveLength(1);
    const first = await store.query({ table: "Timers", index: "ClockDue", partition: "W#demo#CLOCKDUE", limit: 1 });
    expect(first.cursor).toBeDefined();
    const second = await store.query({ table: "Timers", index: "ClockDue", partition: "W#demo#CLOCKDUE", limit: 1, cursor: first.cursor as string });
    expect(second.items.map((row) => row.pk)).toEqual(["W#demo#TIMER#SLA#c"]);
    expect(second.cursor).toBeUndefined();
    const descending = await store.query({ table: "Timers", index: "ClockDue", partition: "W#demo#CLOCKDUE", descending: true, limit: 1 });
    expect(descending.items[0]?.pk).toBe("W#demo#TIMER#SLA#c");
  });

  it("projects only keys from WorldIndex and refuses a consistent read or an unknown index", async () => {
    const store = new MemoryStore();
    store.load("Complaints", [{ pk: "W#demo#CMP#c1", sk: "META", worldIndexKey: "W#demo#", worldIndexSort: "W#demo#CMP#c1|META", summary: "secret" }]);
    const page = await store.query({ table: "Complaints", index: "WorldIndex", partition: "W#demo#" });
    expect(page.items).toEqual([{ pk: "W#demo#CMP#c1", sk: "META", worldIndexKey: "W#demo#", worldIndexSort: "W#demo#CMP#c1|META" }]);
    await expectCode(store.query({ table: "Complaints", index: "WorldIndex", partition: "W#demo#", consistent: true }), "VALIDATION");
    await expectCode(store.query({ table: "Complaints", index: "Nope", partition: "x" }), "VALIDATION");
    await expectCode(store.query({ table: "Complaints", partition: "x", cursor: "not-a-cursor" }), "VALIDATION");
  });

  it("lets a test run a competing writer before the commit", async () => {
    let raced = false;
    const store: MemoryStore = new MemoryStore({
      beforeWrite: async () => {
        if (raced) return;
        raced = true;
        await store.write({ kind: "put", table: "Runtime", item: { pk: "W#demo#COUNTER#EPOCH", sk: "META", value: 2 } });
      },
    });
    await expectCode(store.transact([{ kind: "put", table: "Runtime", item: { pk: "W#demo#COUNTER#EPOCH", sk: "META", value: 1 }, condition: cond.absent() }]), "CONFLICT");
    expect(store.dump("Runtime")).toEqual([{ pk: "W#demo#COUNTER#EPOCH", sk: "META", value: 2 }]);
  });
});
