// The storage port's conditions, updates and key conditions compile to the DynamoDB expressions they
// stand for, with every name and value behind a placeholder and deterministic numbering.
import { describe, expect, it } from "vitest";
import { cond } from "../store";
import { ExpressionBuilder, compileCondition, compileKeyCondition, compileUpdate } from "./expressions";

function condition(...args: Parameters<typeof compileCondition>[0][]) {
  const builder = new ExpressionBuilder();
  const expressions = args.map((arg) => compileCondition(arg, builder));
  return { expressions, ...builder.attributes() };
}

describe("conditions", () => {
  it("compiles existence, comparisons, IN and functions with placeholders", () => {
    expect(condition(cond.absent())).toEqual({ expressions: ["attribute_not_exists(#n0)"], ExpressionAttributeNames: { "#n0": "pk" } });
    expect(condition(cond.exists("answer.inFlight")).expressions).toEqual(["attribute_exists(#n0.#n1)"]);
    const compiled = condition(cond.and(cond.eq("version", 3), cond.in("status", ["REGISTERED", "INVESTIGATING"])));
    expect(compiled).toEqual({
      expressions: ["(#n0 = :v0 AND #n1 IN (:v1, :v2))"],
      ExpressionAttributeNames: { "#n0": "version", "#n1": "status" },
      ExpressionAttributeValues: { ":v0": 3, ":v1": "REGISTERED", ":v2": "INVESTIGATING" },
    });
    expect(condition(cond.lt("leaseUntilReal", "2026")).expressions).toEqual(["#n0 < :v0"]);
    expect(condition(cond.le("a", 1), cond.gt("a", 2), cond.ge("a", 3)).expressions).toEqual(["#n0 <= :v0", "#n0 > :v1", "#n0 >= :v2"]);
    expect(condition(cond.beginsWith("sk", "EVD#")).expressions).toEqual(["begins_with(#n0, :v0)"]);
    expect(condition(cond.not(cond.contains("disclosedEpochs", 2))).expressions).toEqual(["(NOT contains(#n0, :v0))"]);
    expect(condition(cond.attributeType("inFlight", "L")).expressions).toEqual(["attribute_type(#n0, :v0)"]);
    expect(condition(cond.or(cond.absent(), cond.and(cond.eq("status", "CLAIMED"), cond.lt("leaseUntilReal", "t")))).expressions).toEqual([
      "(attribute_not_exists(#n0) OR (#n1 = :v0 AND #n2 < :v1))",
    ]);
  });

  it("reuses the placeholder of a repeated name and keeps reserved words out of the text", () => {
    const compiled = condition(cond.and(cond.eq("status", "A"), cond.eq("data.status", "B")));
    expect(compiled.expressions[0]).toBe("(#n0 = :v0 AND #n1.#n0 = :v1)");
    expect(compiled.ExpressionAttributeNames).toEqual({ "#n0": "status", "#n1": "data" });
    expect(compiled.expressions[0]).not.toMatch(/status|data/);
  });

  it("never lets a value become part of an expression", () => {
    const hostile = "x) OR attribute_exists(pk";
    const compiled = condition(cond.eq("complaintId", hostile));
    expect(compiled.expressions).toEqual(["#n0 = :v0"]);
    expect(compiled.ExpressionAttributeValues).toEqual({ ":v0": hostile });
  });

  it("refuses an empty IN, AND or OR", () => {
    expect(() => condition(cond.in("status", []))).toThrow(RangeError);
    expect(() => condition({ op: "and", conditions: [] })).toThrow(RangeError);
  });
});

describe("updates", () => {
  it("compiles SET, if_not_exists, list_append, ADD, DELETE and REMOVE in DynamoDB's clause order", () => {
    const builder = new ExpressionBuilder();
    const expression = compileUpdate(
      {
        set: { status: "INVESTIGATING", "answer.deliveryProof": "SENT" },
        setIfNotExists: { createdAt: "2026-10-07T13:10:00.000Z" },
        append: { statusHistory: [{ to: "INVESTIGATING" }] },
        add: { version: 1, inFlight: ["cus-0001#evt-1"] },
        deleteFromSet: { tags: ["old"] },
        remove: ["reset"],
      },
      builder,
    );
    expect(expression).toBe(
      "SET #n0 = :v0, #n1.#n2 = :v1, #n3 = if_not_exists(#n3, :v2), #n4 = list_append(if_not_exists(#n4, :v3), :v4) ADD #n5 :v5, #n6 :v6 DELETE #n7 :v7 REMOVE #n8",
    );
    const { ExpressionAttributeNames, ExpressionAttributeValues } = builder.attributes();
    expect(ExpressionAttributeNames).toEqual({
      "#n0": "status",
      "#n1": "answer",
      "#n2": "deliveryProof",
      "#n3": "createdAt",
      "#n4": "statusHistory",
      "#n5": "version",
      "#n6": "inFlight",
      "#n7": "tags",
      "#n8": "reset",
    });
    expect(ExpressionAttributeValues?.[":v3"]).toEqual([]);
    expect(ExpressionAttributeValues?.[":v5"]).toBe(1);
    // String sets travel as `Set`s so the DocumentClient marshals them as SS.
    expect(ExpressionAttributeValues?.[":v6"]).toEqual(new Set(["cus-0001#evt-1"]));
    expect(ExpressionAttributeValues?.[":v7"]).toEqual(new Set(["old"]));
  });

  it("numbers update placeholders after the condition's when both share a request", () => {
    const builder = new ExpressionBuilder();
    const conditionText = compileCondition(cond.eq("version", 1), builder);
    const updateText = compileUpdate({ set: { version: 2 } }, builder);
    expect([conditionText, updateText]).toEqual(["#n0 = :v0", "SET #n0 = :v1"]);
  });

  it("leaves out an empty name or value map", () => {
    const builder = new ExpressionBuilder();
    expect(compileUpdate({ remove: ["leaseUntilReal"] }, builder)).toBe("REMOVE #n0");
    expect(builder.attributes()).toEqual({ ExpressionAttributeNames: { "#n0": "leaseUntilReal" } });
    expect(new ExpressionBuilder().attributes()).toEqual({});
  });
});

describe("key conditions", () => {
  it("compiles the partition equality and each sort condition", () => {
    const build = (sort: Parameters<typeof compileKeyCondition>[3]) => {
      const builder = new ExpressionBuilder();
      return { text: compileKeyCondition("clockDueKey", "W#demo#CLOCKDUE", "dueSort", sort, builder), ...builder.attributes() };
    };
    expect(build(undefined)).toEqual({ text: "#n0 = :v0", ExpressionAttributeNames: { "#n0": "clockDueKey" }, ExpressionAttributeValues: { ":v0": "W#demo#CLOCKDUE" } });
    expect(build({ op: "le", value: "2026-10-08" }).text).toBe("#n0 = :v0 AND #n1 <= :v1");
    expect(build({ op: "beginsWith", value: "EVD#" }).text).toBe("#n0 = :v0 AND begins_with(#n1, :v1)");
    expect(build({ op: "between", low: "a", high: "b" }).text).toBe("#n0 = :v0 AND #n1 BETWEEN :v1 AND :v2");
    expect(() => compileKeyCondition("numberKey", "W#demo#R-2026-000001", undefined, { op: "eq", value: "x" }, new ExpressionBuilder())).toThrow(RangeError);
  });
});
