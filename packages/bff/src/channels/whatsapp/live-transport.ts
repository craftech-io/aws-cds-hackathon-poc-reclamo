// The live transport (docs/architecture-integrations.md §3.1): `SendWhatsAppMessage` with the WABA's
// `originationPhoneNumberId`, the fixed `metaApiVersion` and the Meta JSON as bytes. Before AWS is
// called, inside the transport: the recipient fence of live WhatsApp (only a live world, only the
// demo phones of `SeedOverrides.demoRecipients.phones`, docs/architecture.md §13) and the refusal of a
// template Meta has not `APPROVED`. The SDK command itself lives in `outbound/transports/` (ADR-0006,
// `lint:chokepoint`): this module hands it a validated input through `EumSendPort` and owns the
// deadline, the retries and the mapping of End User Messaging Social's errors.
import type { SendWhatsAppMessageInput } from "@aws-sdk/client-socialmessaging";
import { ChannelError, ToolError, normalizePhone } from "@reclamo/shared";
import type { Clock } from "../../lib/clock";
import { withDeadline } from "../../lib/deadline";
import { type RetryOptions, withRetry } from "../../lib/retry";
import { EUM_RETRY, META_API_VERSION, SEND_TIMEOUTS } from "./config";
import { eumMessageBytes, toMetaMessage } from "./meta-message";
import type { RecipientResolver, TemplateStatusReader, WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from "./transport";

/** The one call of `SendWhatsAppMessageCommand`, made by `outbound/transports/` (WP-26). */
export interface EumSendPort {
  send(input: SendWhatsAppMessageInput): Promise<{ readonly messageId?: string | undefined }>;
}

/** `WhatsAppPhoneNumberId` and `WabaId` while no WhatsApp Business Account is linked. */
export const NOT_CONNECTED = "not-connected";

export interface LiveTransportDeps {
  /** `WhatsAppPhoneNumberId` (lib/secrets.ts): the live transport exists only once it is connected. */
  readonly phoneNumberId: string;
  /** `SeedOverrides.demoRecipients.phones`: the only numbers live WhatsApp may write to. */
  readonly allowedPhones: readonly string[];
  /** The world's effective mode is `live` (registry.ts `worldWhatsAppMode`). */
  readonly isLiveWorld: (worldId: string) => Promise<boolean>;
  readonly recipients: RecipientResolver;
  readonly templates: TemplateStatusReader;
  readonly eum: EumSendPort;
  readonly realClock: Clock;
  /** Test seam for the backoff. */
  readonly retry?: Pick<RetryOptions, "sleep" | "random">;
}

const THROTTLED = new Set(["ThrottledRequestException", "ThrottlingException", "LimitExceededException"]);
const SERVER_FAILED = new Set(["InternalServiceException", "DependencyException"]);
const TIMED_OUT = new Set(["TimeoutError", "RequestTimeout", "DeadlineError"]);
const REFUSED = new Set(["ValidationException", "InvalidParametersException", "ResourceNotFoundException", "ConflictException", "AccessDeniedByMetaException", "AccessDeniedException"]);

/**
 * One place maps what End User Messaging Social throws to the channel's typed errors. A throttled or
 * failed call was not carried out and is retried; a timeout is retried only for a call that is safe to
 * repeat (a media download), never for a send, which could reach the customer twice.
 */
export function toChannelError(error: unknown, operation: string, repeatable: boolean): ChannelError {
  if (error instanceof ChannelError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = `${operation}: ${name || "unexpected error"}`;
  if (THROTTLED.has(name)) return new ChannelError("RATE_LIMITED", "WHATSAPP", message, { cause: error });
  if (SERVER_FAILED.has(name)) return new ChannelError("SEND_FAILED", "WHATSAPP", message, { cause: error });
  if (TIMED_OUT.has(name)) return new ChannelError("TIMEOUT", "WHATSAPP", message, { cause: error, retryable: repeatable });
  if (REFUSED.has(name)) return new ChannelError("INVALID", "WHATSAPP", message, { cause: error });
  return new ChannelError("UNAVAILABLE", "WHATSAPP", message, { cause: error });
}

/** Retries what End User Messaging Social did not carry out, with our backoff and a deadline per attempt. */
export async function callEum<T>(operation: string, repeatable: boolean, timeoutMs: number, call: () => Promise<T>, retry: Pick<RetryOptions, "sleep" | "random"> = {}): Promise<T> {
  return withRetry(
    async () => {
      try {
        return await withDeadline(operation, timeoutMs, call);
      } catch (error) {
        throw toChannelError(error, operation, repeatable);
      }
    },
    { ...EUM_RETRY, ...retry },
  );
}

function notAllowed(message: string): ToolError {
  return new ToolError("RECIPIENT_NOT_ALLOWED", message);
}

/** The fenced set of live numbers, normalized; a malformed entry is dropped, never matched loosely. */
function allowedSet(phones: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const phone of phones) {
    try {
      out.add(normalizePhone(phone));
    } catch {
      // An entry that is not a phone number can never be a recipient.
    }
  }
  return out;
}

export function liveWhatsAppTransport(deps: LiveTransportDeps): WhatsAppTransport {
  if (deps.phoneNumberId === NOT_CONNECTED || deps.phoneNumberId.trim() === "") throw new ChannelError("UNAVAILABLE", "WHATSAPP", "WhatsApp live transport is not configured (WhatsAppPhoneNumberId is not-connected)");
  const allowed = allowedSet(deps.allowedPhones);

  return {
    mode: "live",

    async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
      const { record, outbound } = request;
      if (!(await deps.isLiveWorld(record.worldId))) throw notAllowed("live WhatsApp only writes from a live world");
      const number = await deps.recipients.whatsAppNumber(record.worldId, record.customerId, "live");
      let to: string;
      try {
        to = normalizePhone(number ?? "");
      } catch {
        throw notAllowed("the customer has no live WhatsApp number");
      }
      if (!allowed.has(to)) throw notAllowed("the live number is not a registered demo recipient");
      if (outbound.kind === "template" && (await deps.templates.status(outbound.name)) !== "APPROVED") {
        throw new ChannelError("INVALID", "WHATSAPP", `template ${outbound.name} is not APPROVED by Meta`);
      }
      const message = toMetaMessage(outbound, to);
      const input: SendWhatsAppMessageInput = { originationPhoneNumberId: deps.phoneNumberId, metaApiVersion: META_API_VERSION, message: eumMessageBytes(message) };
      const output = await callEum("whatsapp.send", false, SEND_TIMEOUTS.requestTimeoutMs + 1_000, () => deps.eum.send(input), deps.retry);
      if (output.messageId === undefined || output.messageId === "") throw new ChannelError("UNAVAILABLE", "WHATSAPP", "whatsapp.send: no message id in the answer");
      return { providerMessageId: output.messageId, simulated: false, status: "SENT", payload: message, sentAtReal: (await deps.realClock.now()).toISOString() };
    },
  };
}
