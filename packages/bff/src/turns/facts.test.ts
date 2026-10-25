// The facts of a turn's envelope about its inbound message (turns/facts.ts): a reply button the customer
// tapped reaches the model as an action, never as its nonce, and only for the customer's own message.
import { describe, expect, it } from "vitest";
import { message } from "../connector/testing";
import type { Message } from "../domain/conversation";
import { type TurnInbound, inboundFacts } from "./facts";

const inbound = (overrides: Partial<TurnInbound> & { readonly interactive?: Message["interactive"] }): TurnInbound => {
  const { interactive, ...rest } = overrides;
  const stored = { ...message("demo", { direction: "IN", body: "Baja de mi cuenta" }), ...(interactive === undefined ? {} : { interactive }) } as Message;
  return { text: "Baja de mi cuenta", channel: "WHATSAPP", fromRole: "CUSTOMER", truncated: false, source: "CUSTOMER", message: stored, ...rest };
};

describe("[FL-053] the tapped button in the envelope", () => {
  it("[FL-053] a tap is the fact inbound button=<action>, without its nonce", () => {
    const facts = inboundFacts(inbound({ interactive: { action: "CONFIRM_CLOSURE", resolved: "true", nonce: "01M4B7RD18000000000000000" } }));
    expect(facts).toEqual([{ name: "inbound", attributes: { button: "CONFIRM_CLOSURE" } }]);
    expect(JSON.stringify(facts)).not.toContain("01M4B7RD");
  });

  it("a typed message, an operator's summary or a malformed action carries no button fact", () => {
    expect(inboundFacts(inbound({}))).toEqual([]);
    expect(inboundFacts(inbound({ source: "OPERATOR", interactive: { action: "CONFIRM_CLOSURE" } }))).toEqual([]);
    expect(inboundFacts(inbound({ interactive: { action: "<event/>" } }))).toEqual([]);
    expect(inboundFacts(undefined)).toEqual([]);
  });
});
