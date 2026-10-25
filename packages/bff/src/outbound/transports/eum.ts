// The End User Messaging Social command of live WhatsApp (ADR-0006, `lint:chokepoint`): the only
// `SendWhatsAppMessageCommand` of the app. The live transport (channels/whatsapp/live-transport.ts)
// fences the recipient, refuses an unapproved template, builds the input and owns the deadline, the
// retries and the error mapping; this port only runs the command. Built only once a number is
// configured (whatsappLiveApproval in infra/channel-modes.ts; otherwise there is no live transport).
import { SendWhatsAppMessageCommand, type SendWhatsAppMessageInput, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { SEND_TIMEOUTS } from "../../channels/whatsapp/config";
import type { EumSendPort } from "../../channels/whatsapp/live-transport";
import { awsClientConfig } from "../../lib/clients";

let client: SocialMessagingClient | undefined;

function eumClient(): SocialMessagingClient {
  client ??= new SocialMessagingClient(awsClientConfig(SEND_TIMEOUTS));
  return client;
}

export function eumSendPort(send: Pick<SocialMessagingClient, "send"> = eumClient()): EumSendPort {
  return {
    async send(input: SendWhatsAppMessageInput) {
      const output = await send.send(new SendWhatsAppMessageCommand(input));
      return { messageId: output.messageId };
    },
  };
}
