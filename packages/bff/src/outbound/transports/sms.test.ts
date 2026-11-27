// The SMS transport (docs/architecture-guests.md §17, FL-131): SNS `Publish` straight to one E.164 number,
// transactional, one attempt only (a retry could repeat the code), a refused number as `SmsUndeliverable`.
// The SNS client is a mock: nothing reaches a phone.
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { SmsUndeliverable } from "../../second-factor/sms";
import { smsCodeText } from "../../copy/sms-code";
import { SMS_MAX_LENGTH, SmsRefused, snsSmsTransport } from "./sms";

const sns = mockClient(SNSClient);

afterEach(() => sns.reset());

describe("SMS transport [FL-131]", () => {
  it("[FL-131] publishes to the number, never to a topic, as a transactional SMS", async () => {
    sns.on(PublishCommand).resolves({ MessageId: "m-1" });
    await snsSmsTransport(new SNSClient({ region: "us-east-1" })).send({ phone: "+5491155550100", text: "Tu código de Reclamo en regla es 123456. Vence en 10 minutos." });
    const [call] = sns.commandCalls(PublishCommand);
    expect(call?.args[0].input).toEqual({
      PhoneNumber: "+5491155550100",
      Message: "Tu código de Reclamo en regla es 123456. Vence en 10 minutos.",
      MessageAttributes: { "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" } },
    });
    expect(call?.args[0].input).not.toHaveProperty("TopicArn");
  });

  it("[FL-131] tries once: a throttled or failed publish is not retried by this code", async () => {
    sns.on(PublishCommand).rejects(Object.assign(new Error("slow down"), { name: "ThrottlingException" }));
    await expect(snsSmsTransport(new SNSClient({ region: "us-east-1", maxAttempts: 1 })).send({ phone: "+5491155550100", text: "x" })).rejects.toThrow("slow down");
    expect(sns.commandCalls(PublishCommand)).toHaveLength(1);
  });

  it("[FL-131] reports a number the network refuses as undeliverable, and never sends a malformed one", async () => {
    sns.on(PublishCommand).rejects(Object.assign(new Error("no route"), { name: "InvalidParameterException" }));
    const transport = snsSmsTransport(new SNSClient({ region: "us-east-1" }));
    await expect(transport.send({ phone: "+12025550123", text: "x" })).rejects.toBeInstanceOf(SmsUndeliverable);
    sns.resetHistory();
    await expect(transport.send({ phone: "1155550100", text: "x" })).rejects.toBeInstanceOf(SmsRefused);
    await expect(transport.send({ phone: "+5491155550100", text: "x".repeat(71) })).rejects.toBeInstanceOf(SmsRefused);
    expect(sns.commandCalls(PublishCommand)).toEqual([]);
  });

  it("[FL-131] the code's texts fit one segment in both languages", () => {
    for (const locale of ["es", "en"] as const) expect(smsCodeText(locale, "123456").length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});
