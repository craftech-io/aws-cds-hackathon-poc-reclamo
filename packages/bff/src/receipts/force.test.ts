import { describe, expect, it } from "vitest";
import { testConnector } from "../connector/testing";
import { RECEIPT_FORCE_ID, RECEIPT_FORCE_SOURCE, receiptFallbackForced } from "./force";

describe("receipt.forceFallback", () => {
  it("is read only in QA worlds, where the QA driver's switch makes read_receipt skip Bedrock", async () => {
    const { connector } = testConnector();
    expect(await receiptFallbackForced(connector, "qa-1234-1-sc04")).toBe(false);
    await connector.claims.claimOnce("qa-1234-1-sc04", RECEIPT_FORCE_SOURCE, RECEIPT_FORCE_ID, { on: true });
    expect(await receiptFallbackForced(connector, "qa-1234-1-sc04")).toBe(true);
    // The same row written in any other world never turns Bedrock off.
    await connector.claims.claimOnce("demo", RECEIPT_FORCE_SOURCE, RECEIPT_FORCE_ID, { on: true });
    expect(await receiptFallbackForced(connector, "demo")).toBe(false);
  });
});
