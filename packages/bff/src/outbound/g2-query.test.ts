// The relevance query of G2 (ADR-0021 §10): small talk is scored against the fixed status question,
// a real question against the customer's own words, truncated to the query limit.
import { describe, expect, it } from "vitest";
import { QUERY_MAX_CHARS, STATUS_QUESTION, asksSomething, g2Query } from "./g2-query";

describe("G2 relevance query [FL-001]", () => {
  it.each(["hola", "Hola!", "ok", "gracias", "buen día", "hola, buenas tardes", "  hola  "])("scores small talk %j against the fixed status question [FL-001]", (text) => {
    expect(asksSomething(text)).toBe(false);
    expect(g2Query(text)).toBe(STATUS_QUESTION);
  });

  it("uses the status question when there is no customer message at all (a proactive send) [FL-001]", () => {
    expect(g2Query(undefined)).toBe(STATUS_QUESTION);
    expect(g2Query("   ")).toBe(STATUS_QUESTION);
  });

  it("keeps the customer's words when they ask something: a question mark or more than three words [FL-001]", () => {
    expect(g2Query("¿y mi pago?")).toBe("¿y mi pago?");
    expect(g2Query("pagué la cuota 4 y no figura")).toBe("pagué la cuota 4 y no figura");
    expect(asksSomething("cuota?")).toBe(true);
    expect(asksSomething("pagué la cuota cuatro")).toBe(true);
  });

  it("truncates a long question to the 1,000 characters of the query limit", () => {
    const long = `¿${"por qué no figura mi pago ".repeat(80)}?`;
    const query = g2Query(long);
    expect(query).toHaveLength(QUERY_MAX_CHARS);
    expect(long.startsWith(query)).toBe(true);
  });

  it("never exceeds the limit even when a caller asks for a larger one", () => {
    expect(g2Query("x ".repeat(2_000), 5_000)).toHaveLength(QUERY_MAX_CHARS);
    expect(g2Query("pagué la cuota 4 y no figura", 10)).toBe("pagué la c");
  });

  it("the fixed question is a question about the account and the complaint, never a greeting", () => {
    expect(STATUS_QUESTION).toBe("¿Cómo están mi cuenta y mi reclamo?");
    expect(asksSomething(STATUS_QUESTION)).toBe(true);
  });
});
