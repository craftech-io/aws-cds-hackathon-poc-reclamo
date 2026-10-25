// SC-04 (payoff certificate) and SC-17 (email) on the run's model. Whether the certificate can be issued
// and which attachments go out is the code's decision from the loan's state; the model investigates and
// answers in writing. The written answer is an email to the SES mailbox simulator: delivered, its proof
// lands on the complaint; bounced, a person takes the case and the customer is told by template.
import { describe, expect, it } from "vitest";
import type { SentEmail } from "../../flows/support/stage/context";
import { SCRIPTED_RUN, okResultOf, openAgentWorld, turnsSummary } from "../support/agent-world";
import { complain, current, emailsTagged, outboundOf, pursueStatus } from "../support/customer";
import { collectionRulesPassed, conversationProblems } from "../support/oracles";

const CERTIFICATE = "Necesito el libre deuda del préstamo que cancelé";
const DISBURSEMENT = "Me aprobaron el préstamo y no me depositaron la plata";
const FINISHED = ["ANSWERED", "CLOSED"];

describe.skipIf(SCRIPTED_RUN)("payoff certificate and email (agent)", () => {
  it("[SC-04/2] [SC-17/2] [FL-030] [FL-090] C05: a cancelled loan gets the certificate attached to the written answer; delivered, its proof is kept", async () => {
    const world = await openAgentWorld();
    const complaint = await complain(world, "cus-0005", CERTIFICATE);
    if (complaint === undefined) throw new Error("the complaint was not filed");
    await pursueStatus(world, "cus-0005", complaint, FINISHED);

    expect(complaint.type).toBe("PAYOFF_CERTIFICATE");
    expect(okResultOf(world.agent.turns, "answer_complaint_in_writing")?.attachments, turnsSummary(world.agent.turns)).toContain("PAYOFF_CERTIFICATE");
    const [answer] = emailsTagged(world, "FORMAL_ANSWER");
    expect(answer).toBeDefined();
    await world.flow.sesEvent(answer as SentEmail, "Delivery");
    expect(await current(world, complaint)).toMatchObject({ outcome: "IN_FAVOUR", answer: { deliveryProof: "DELIVERED" } });
    expect(await conversationProblems(world, "cus-0005")).toEqual([]);
  });

  it("[SC-04/3] [FL-031] C21: a loan with a balance gets no certificate and no collection: a neutral, informational answer", async () => {
    const world = await openAgentWorld();
    const complaint = await complain(world, "cus-0021", CERTIFICATE);
    if (complaint === undefined) throw new Error("the complaint was not filed");
    await pursueStatus(world, "cus-0021", complaint, [...FINISHED, "HUMAN_REVIEW"]);

    expect(world.flow.s3.keys("Documents").some((key) => key.includes("PAYOFF_CERTIFICATE")), turnsSummary(world.agent.turns)).toBe(false);
    const settled = await current(world, complaint);
    if (settled?.status !== "HUMAN_REVIEW") {
      // Not handed to a person: the refused certificate still closes with an informational written answer.
      expect(settled, turnsSummary(world.agent.turns)).toMatchObject({ outcome: "INFORMATIONAL", answer: { messageId: expect.any(String) } });
      expect(okResultOf(world.agent.turns, "answer_complaint_in_writing")?.attachments ?? []).not.toContain("PAYOFF_CERTIFICATE");
      expect(emailsTagged(world, "FORMAL_ANSWER")).toHaveLength(1);
    }
    expect(await collectionRulesPassed(world, "cus-0021", ["CH-WA-NO-COLLECTION", "CH-WA-NO-PAYMENT-REQUEST"])).toBe(true);
    expect(await conversationProblems(world, "cus-0021")).toEqual([]);
  });

  it("[SC-17/3] [FL-091] C39: the written answer bounces: a person takes the case and the customer is told by template", async () => {
    const world = await openAgentWorld();
    const complaint = await complain(world, "cus-0039", DISBURSEMENT);
    if (complaint === undefined) throw new Error("the complaint was not filed");
    await pursueStatus(world, "cus-0039", complaint, [...FINISHED, "HUMAN_REVIEW"]);

    const [answer] = emailsTagged(world, "FORMAL_ANSWER");
    if (answer === undefined) {
      // The agent handed the case to a person instead of answering: also a correct path, nothing to bounce.
      expect((await current(world, complaint))?.status, turnsSummary(world.agent.turns)).toBe("HUMAN_REVIEW");
      return;
    }
    expect(answer.input.Destination?.ToAddresses).toEqual([expect.stringMatching(/^bounce\+.*@simulator\.amazonses\.com$/)]);
    await world.flow.sesEvent(answer, "Bounce");
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "EMAIL_UNDELIVERABLE" } });
    expect((await outboundOf(world, "cus-0039")).some((message) => message.templateName === "reclamo_respuesta_no_entregada")).toBe(true);
    expect(await conversationProblems(world, "cus-0039")).toEqual([]);
  });
});
