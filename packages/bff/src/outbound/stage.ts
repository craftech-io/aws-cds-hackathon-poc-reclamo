/// <reference path="../../sst-env.d.ts" />
// The gate's ports in a deployed function (role with `PIPELINE`), from what SST links into it
// (`Resource` through lib/resource.ts and lib/secrets.ts, never `process.env`): DynamoDB and the chain
// key and anchors (complaints/deps.ts), the core (`CoreMock`), `GuardrailG2`, the `Documents` and
// `Emails` buckets, the SES client with its transport, the phone simulator and, once a number is
// configured (`WhatsAppPhoneNumberId` other than `not-connected`), the live transport over End User
// Messaging Social, both resolving the live number from the core (outbound/directory.ts
// `coreRecipients`); `PhoneHashKey` (nonces) and `SeedOverrides` (demo recipients). Built once per
// container, lazily: a function that never sends never reads a link.
import { z } from "zod";
import { addressHash } from "@reclamo/shared";
import { stageEmailClient } from "../channels/email/stage";
import { demoRecipientsFromSeedOverrides } from "../channels/email/recipient-fence";
import { NOT_CONNECTED, liveWhatsAppTransport } from "../channels/whatsapp/live-transport";
import { type WhatsAppTransports, worldWhatsAppMode } from "../channels/whatsapp/registry";
import { simulatedWhatsAppTransport } from "../channels/whatsapp/simulated-transport";
import { timerMilestoneScheduler } from "../timers/milestones";
import { linkedScheduleGroup, stageTimerDeps } from "../timers/stage";
import { referenceTemplateStatus } from "../channels/whatsapp/template-records";
import { type MilestoneScheduler, stageComplaintsDeps } from "../complaints/deps";
import { linkedCoreClient } from "../core/linked";
import { systemClock, worldClock } from "../lib/clock";
import { deriveSubkey } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { bucketName, channelModes } from "../lib/resource";
import { keySecret, secretValue } from "../lib/secrets";
import type { DemoRecipientList, OutboundDeps } from "./deps";
import { coreCustomerReader, coreDebtReader, coreRecipients, personaRecipients, simulatorEmailDirectory } from "./directory";
import { s3DocumentStore } from "./documents";
import { createBedrockG2 } from "./g2";
import { eumSendPort } from "./transports/eum";
import { sesSendRaw } from "./transports/ses";

const DemoPhones = z.looseObject({ demoRecipients: z.looseObject({ phones: z.array(z.string().max(32)).max(5).default([]) }).optional() });

function optionalSecret(name: "SeedOverrides" | "WhatsAppPhoneNumberId"): string | undefined {
  try {
    return secretValue(name);
  } catch {
    // Not linked to this function, or empty: the feature it enables stays off.
    return undefined;
  }
}

/** `SeedOverrides.demoRecipients` (emails fenced to `@craftech.io`, phones as given); malformed → none. */
export function demoRecipientsOf(raw: string | undefined): DemoRecipientList {
  const emails = demoRecipientsFromSeedOverrides(raw);
  let phones: readonly string[] = [];
  try {
    phones = DemoPhones.parse(JSON.parse(raw ?? "{}")).demoRecipients?.phones ?? [];
  } catch {
    phones = [];
  }
  return { emails, phones };
}

export interface StageOutboundOptions {
  /** The timers' scheduler (timers/milestones.ts); by default, the linked `Scheduler`'s when the role holds `TIMERS`. */
  readonly milestones?: MilestoneScheduler;
}

/**
 * The schedules of a `DEFERRED_SEND` in a running world: only where `Scheduler` is linked (the role
 * holds `TIMERS`); elsewhere the timer waits in the clock's due list and the next clock move fires it.
 */
function linkedMilestones(log: Logger): MilestoneScheduler | undefined {
  return linkedScheduleGroup() === undefined ? undefined : timerMilestoneScheduler(stageTimerDeps(log, { networks: false, scheduler: true }));
}

/** The ports of the gate inside a Lambda of the stage. */
export function stageOutboundDeps(log: Logger, options: StageOutboundOptions = {}): OutboundDeps {
  const milestones = options.milestones ?? linkedMilestones(log);
  const chains = stageComplaintsDeps({ log, ...(milestones === undefined ? {} : { milestones }) });
  const { connector } = chains;
  const core = linkedCoreClient();
  const templates = referenceTemplateStatus(connector);
  let demo: DemoRecipientList | undefined;
  const demoRecipients = (): DemoRecipientList => (demo ??= demoRecipientsOf(optionalSecret("SeedOverrides")));
  let phoneKey: Uint8Array | undefined;
  const whatsapp: WhatsAppTransports = {
    simulated: simulatedWhatsAppTransport({ data: connector, recipients: personaRecipients, templates, realClock: systemClock, log }),
  };
  const phoneNumberId = optionalSecret("WhatsAppPhoneNumberId");
  const stageModes = channelModes();
  const simNow = (worldId: string) => worldClock(worldId, connector.runtime.clockState).now();
  // The same resolver for the gate's fence and for the live transport: the core's live number.
  const recipients = coreRecipients({ core, simNow, stageModes });
  const live =
    phoneNumberId === undefined || phoneNumberId === NOT_CONNECTED
      ? undefined
      : liveWhatsAppTransport({
          phoneNumberId,
          allowedPhones: demoRecipients().phones,
          isLiveWorld: async (worldId) => worldWhatsAppMode(worldId, await connector.worlds.getSettings(worldId), stageModes) === "live",
          recipients,
          templates,
          eum: eumSendPort(),
          realClock: systemClock,
        });
  return {
    chains,
    simNow,
    customers: coreCustomerReader(core),
    emails: simulatorEmailDirectory,
    recipients,
    phoneHash: (phoneE164) => addressHash("WHATSAPP", phoneE164, (phoneKey ??= deriveSubkey("PhoneHashKey", keySecret("PhoneHashKey"), "phone-hash"))),
    debts: coreDebtReader(core),
    documents: s3DocumentStore({ bucket: bucketName("Documents"), reference: connector }),
    guardrail: createBedrockG2(),
    email: stageEmailClient({ sendRaw: sesSendRaw(), connector, log }),
    whatsapp: live === undefined ? whatsapp : { ...whatsapp, live },
    stageModes,
    demoRecipients,
  };
}
