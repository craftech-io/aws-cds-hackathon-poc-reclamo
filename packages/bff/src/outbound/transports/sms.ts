// Transport of the SMS code (docs/architecture-guests.md §17). It is not a message to a customer of the
// demo, so it does not go through the gate; it is the app's only SMS send and lives here, with the
// transports, so `lint:chokepoint` finds every send command in one directory. Its own fence: one E.164
// number per message (never a topic: IAM denies publishing to any, infra/messaging-sms.ts), the
// transactional type, and exactly one attempt: the SDK never retries (`maxAttempts: 1`) and neither does
// this code, so a slow answer can never become a second SMS with the same code. A refusal of the
// number by the network is `SmsUndeliverable`; the caller tells the person and burns the code.
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { awsClientConfig } from "../../lib/clients";
import { E164_PATTERN } from "../../second-factor/phone-number";
import { type SmsMessage, type SmsSender, SmsUndeliverable } from "../../second-factor/sms";

const SNS_TIMEOUTS = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 1 } as const;

/** SNS errors that mean "this number cannot get an SMS from us", not "try again". */
const UNDELIVERABLE = new Set(["InvalidParameterException", "InvalidParameterValueException", "OptedOutException", "EndpointDisabledException"]);

/** The longest SMS body this transport sends: one segment even in UCS-2 (the Spanish text has "ó"). */
export const SMS_MAX_LENGTH = 70;

export class SmsRefused extends Error {
  override readonly name = "SmsRefused";
}

export function snsSmsTransport(client: SNSClient = new SNSClient(awsClientConfig(SNS_TIMEOUTS))): SmsSender {
  return {
    async send(message: SmsMessage) {
      if (!E164_PATTERN.test(message.phone) || message.text.length === 0 || message.text.length > SMS_MAX_LENGTH) {
        throw new SmsRefused("the SMS code goes to one E.164 number with a short text");
      }
      try {
        await client.send(
          new PublishCommand({
            PhoneNumber: message.phone,
            Message: message.text,
            MessageAttributes: { "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" } },
          }),
        );
      } catch (error) {
        if (error instanceof Error && UNDELIVERABLE.has(error.name)) throw new SmsUndeliverable(error.name);
        throw error;
      }
    },
  };
}
