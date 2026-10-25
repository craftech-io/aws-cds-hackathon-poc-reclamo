// `channels:waba-event-destination` (docs/architecture-integrations.md §3.4 step 4) against a mocked End User Messaging
// Social SDK: the topic ARN comes from the linked WABA's own ARN, a WABA already pointing at it is left
// alone, nothing is written without --apply, and nothing at all runs while the WABA is not connected.
import { GetLinkedWhatsAppBusinessAccountCommand, PutWhatsAppBusinessAccountEventDestinationsCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { whatsAppTopicName } from "../../infra/workers-spec";
import { type DestinationDeps, TOPIC_NAME, parseStageArgs, runDestination, stageDeps, topicArnFor } from "./waba-event-destination";

const social = mockClient(SocialMessagingClient);
const WABA_ID = "waba-0123456789abcdef";
const WABA_ARN = "arn:aws:social-messaging:us-east-1:776805327629:waba/0123456789abcdef";
const TOPIC_ARN = `arn:aws:sns:us-east-1:776805327629:${TOPIC_NAME}`;

let lines: string[];

function deps(secret = WABA_ID): DestinationDeps {
  return { ...stageDeps(new SocialMessagingClient({ region: "us-east-1" })), wabaSecret: () => secret, report: (line) => void lines.push(line) };
}

function linkedWith(destinations: string[]): void {
  social.on(GetLinkedWhatsAppBusinessAccountCommand, { id: WABA_ID }).resolves({
    account: {
      arn: WABA_ARN,
      id: WABA_ID,
      wabaId: "0123456789abcdef",
      registrationStatus: "COMPLETE",
      linkDate: new Date("2026-10-20T12:00:00Z"),
      wabaName: "Reclamo en regla (demo)",
      eventDestinations: destinations.map((eventDestinationArn) => ({ eventDestinationArn })),
      phoneNumbers: [],
    },
  });
  social.on(PutWhatsAppBusinessAccountEventDestinationsCommand).resolves({});
}

beforeEach(() => {
  social.reset();
  lines = [];
});

describe("channels:waba-event-destination", () => {
  it("names the same topic the infrastructure creates and derives its ARN from the WABA's", () => {
    expect(TOPIC_NAME).toBe(whatsAppTopicName("aws-cds-hackathon-poc-reclamo"));
    expect(topicArnFor(WABA_ARN)).toBe(TOPIC_ARN);
    expect(() => topicArnFor("arn:aws:sns:us-east-1:776805327629:other")).toThrow(RangeError);
    expect(() => parseStageArgs(["--apply"])).toThrow(/--stage poc/);
  });

  it("leaves a WABA that already points at the topic as it is", async () => {
    linkedWith([TOPIC_ARN]);
    expect(await runDestination({ stage: "poc", apply: true }, deps())).toBe("ALREADY_SET");
    expect(social.commandCalls(PutWhatsAppBusinessAccountEventDestinationsCommand)).toHaveLength(0);
  });

  it("writes nothing without --apply", async () => {
    linkedWith([]);
    expect(await runDestination(parseStageArgs(["--stage", "poc"]), deps())).toBe("WOULD_SET");
    expect(social.commandCalls(PutWhatsAppBusinessAccountEventDestinationsCommand)).toHaveLength(0);
    expect(lines).toEqual([`would send the WABA's events to ${TOPIC_NAME} (run with --apply)`]);
  });

  it("with --apply replaces any other destination with the topic alone", async () => {
    linkedWith(["arn:aws:sns:us-east-1:776805327629:old-destination"]);
    expect(await runDestination(parseStageArgs(["--stage", "poc", "--apply"]), deps())).toBe("SET");
    const puts = social.commandCalls(PutWhatsAppBusinessAccountEventDestinationsCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.args[0].input).toEqual({ id: WABA_ID, eventDestinations: [{ eventDestinationArn: TOPIC_ARN }] });
  });

  it("accepts the WABA's ARN in the secret and does nothing while it is not connected", async () => {
    linkedWith([TOPIC_ARN]);
    expect(await runDestination({ stage: "poc" }, deps(WABA_ARN))).toBe("ALREADY_SET");
    social.reset();
    await expect(runDestination({ stage: "poc", apply: true }, deps("not-connected"))).rejects.toThrow(/WabaId is not-connected/);
    expect(social.calls()).toHaveLength(0);
  });
});
