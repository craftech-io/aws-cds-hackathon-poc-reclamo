// Test kit of the identity target: the targets kit (account/testing.ts) with the conversation the
// challenge lives in. `asked` stores the challenge as the gate leaves a sent `IDENTITY_CHALLENGE`;
// `wrote` stores what the customer writes; each one a later real instant, as on a phone. Synthetic data only.
import { CHALLENGE_PROMPT, WHATSAPP_TEXT } from "../../copy";
import { message } from "../../connector/testing";
import type { MessageStatus } from "../../domain/conversation";
import { gatewayContext } from "../common/principal";
import type { OpenedTurn } from "../common/testing";
import { createAccountTarget } from "../account/target";
import { CUSTOMER, WORLD, monthlyInstalments, targetsKit } from "../account/testing";
import { createIdentityTarget } from "./target";

export const LOAN = { loanId: "L-0001", principal: 60_000_000, instalments: monthlyInstalments() };

/** Real time between two things a person does on the phone. */
const PHONE_PAUSE_MS = 1_000;

export async function identityKit(customer: Parameters<typeof targetsKit>[0][number] = { customerId: CUSTOMER, balance: 5_000_000, loans: [LOAN] }) {
  const kit = await targetsKit([customer]);
  const identity = createIdentityTarget(kit.toolDeps, { core: kit.core, complaints: () => kit.complaintsDeps, gate: kit.gate.gate });
  const account = createAccountTarget(kit.toolDeps, { core: kit.core });
  let messages = 0;
  const nextId = (prefix: string) => `${prefix}-${String(++messages).padStart(4, "0")}`;

  /** The agent's challenge went out (`status` SENT unless said). */
  const asked = async (options: { readonly status?: MessageStatus; readonly customerId?: string } = {}) => {
    kit.advanceReal(PHONE_PAUSE_MS);
    await kit.connector.conversations.putMessage(
      message(WORLD, {
        messageId: nextId("msg-out"),
        customerId: options.customerId ?? CUSTOMER,
        direction: "OUT",
        kind: "IDENTITY_CHALLENGE",
        sender: "AGENT",
        status: options.status ?? "SENT",
        body: WHATSAPP_TEXT[CHALLENGE_PROMPT.LAST_DUE_DATE],
      }),
    );
  };
  /** The customer writes `text` on their phone. */
  const wrote = async (text: string, customerId: string = CUSTOMER) => {
    kit.advanceReal(PHONE_PAUSE_MS);
    await kit.connector.conversations.putMessage(message(WORLD, { messageId: nextId("msg-in"), customerId, body: text }));
  };
  /** Challenge asked, the customer answers `text`, and the turn their message opened. */
  const answered = async (text: string, turn: Parameters<typeof kit.openTurn>[0] = {}): Promise<OpenedTurn> => {
    await asked();
    await wrote(text);
    return kit.openTurn(turn);
  };

  return {
    kit,
    identity,
    asked,
    wrote,
    answered,
    identify: (token: string) => identity.handle({ sessionToken: token }, gatewayContext("identity___identify_customer")),
    verify: (token: string, answer: string) => identity.handle({ sessionToken: token, answer }, gatewayContext("identity___verify_challenge")),
    getAccount: (token: string) => account.handle({ sessionToken: token }, gatewayContext("account___get_account")),
  };
}
