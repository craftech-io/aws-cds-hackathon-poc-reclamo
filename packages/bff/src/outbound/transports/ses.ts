// The SES command of the customer emails (ADR-0006, `lint:chokepoint`): the only `SendEmailCommand`
// besides the lead notice. It runs exactly what the single SES client (channels/email/outbound.ts)
// validated, fenced, stored and built: one attempt per call (SES has no idempotency key, so the SDK
// never retries on its own), aborted at the client's deadline; the client retries only throttling.
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { SES_SEND_TIMEOUTS } from "../../channels/email/config";
import type { SesSendFn } from "../../channels/email/outbound";
import { awsClientConfig } from "../../lib/clients";

let client: SESv2Client | undefined;

/** One `SESv2Client` per container, with the send budget of channels/email/config.ts. */
function sesClient(): SESv2Client {
  client ??= new SESv2Client(awsClientConfig(SES_SEND_TIMEOUTS));
  return client;
}

/** `SendEmail` for the SES client; tests pass their own `send`. */
export function sesSendRaw(send: Pick<SESv2Client, "send"> = sesClient()): SesSendFn {
  return async (input: SendEmailCommandInput, signal: AbortSignal) => {
    const output = await send.send(new SendEmailCommand(input), { abortSignal: signal });
    return { MessageId: output.MessageId };
  };
}
