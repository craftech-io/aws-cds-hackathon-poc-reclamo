// WhatsApp through AWS End User Messaging Social (ADR-0002, ADR-0021 §5, docs/architecture-integrations.md
// §3, docs/architecture.md §1, §13 and §14, docs/build-plan.md WP-20): the inbound topic, its policy,
// `InboundWhatsApp`, and what every Lambda that runs the outbound gate links and may do.
//
// Inbound. The WhatsApp Business Account (a NEW one of this product, ADR-0021 §5) publishes
// its events to one standard SNS topic with a fixed name, `aws-cds-hackathon-poc-reclamo-wa-inbound`
// (a WABA has a single event destination, so no stage in it), with `SignatureVersion 2` (SHA256withRSA,
// the only one channels/whatsapp/sns-signature.ts accepts). `scripts/channels/waba-event-destination.ts`
// points the WABA at it when a WABA is configured (docs/architecture-integrations.md §3.4). The topic policy lets End User Messaging Social publish
// only for this account and this WABA (`aws:SourceAccount` + `aws:SourceArn`); while `WabaId` is
// `not-connected` that statement is omitted and nobody outside the account may publish.
// `InboundWhatsApp` is subscribed to it and is also what the phone simulator invokes (the Bff and the
// QaDriver link `inboundWhatsApp`, which grants `lambda:InvokeFunction` on it and nothing else): both
// paths enter through the same SNS envelope and the same normalizer (WP-32's handler).
//
// Sending. `social-messaging:SendWhatsAppMessage` (SEND_WHATSAPP) and, for live media,
// `social-messaging:GetWhatsAppMessageMedia` exist only on the phone number of the
// `WhatsAppPhoneNumberId` secret. While it is `not-connected` (every world `simulated`) there is no
// statement at all; after the operator loads the real id the next CI deploy adds it and nothing else
// changes. Every holder of PIPELINE links `pipelineLinks` (SES sender, G2, channel modes, phone number,
// demo recipients), adds `sendWhatsAppPermissions` and the late `pipelineLateLinks` (TIMERS).
//
// InboundWhatsApp: reserved concurrency 5, fixed role name (a caller of CoreMock), its data from
// infra/iam-capabilities.ts, G1 (pre-filter) and the classifier's model (late, WP-31), `s3:ListBucket`
// of Media only under `wa/` (the real key under the prefix of a live media download), and the
// producers of the three customer queues and `ScanDeadlines` plus AnchorWriter, late from
// infra/workers.ts (which imports this module).
//
// Cost: SNS and Lambda per message; nothing bills while no WhatsApp event arrives.
//
// Verify (reads only):
//   aws --profile craftech-demos sns get-topic-attributes --topic-arn arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-reclamo-wa-inbound
//     → SignatureVersion 2 · Policy: no social-messaging statement while WabaId is not-connected; afterwards
//       social-messaging.amazonaws.com with aws:SourceAccount 776805327629 and aws:SourceArn …:waba/<id>
//   aws --profile craftech-demos sns list-subscriptions-by-topic --topic-arn <same ARN>   → one lambda subscription
//   aws --profile craftech-demos iam get-role-policy --role-name aws-cds-hackathon-poc-reclamo-poc-inbound-whatsapp --policy-name inline
//     → no social-messaging statement while WhatsAppPhoneNumberId is not-connected

import { ChannelModes } from "./channel-modes";
import { GuardrailG1, GuardrailG2 } from "./guardrail";
import { lateLinks, links, type LinkList } from "./late-links";
import { emailSender } from "./messaging-email";
import { fixedRole, functionData, grantMockInvoke } from "./mocks";
import { SeedOverrides, WabaId, WhatsAppPhoneNumberId } from "./secrets";
import { buckets } from "./storage";
import {
  FUNCTION_BUDGETS,
  HANDLERS,
  LATE_LINKS,
  LIVE_MEDIA_LIST_PREFIX,
  QUEUE_PRODUCERS,
  RESERVED_CONCURRENCY,
  WHATSAPP_MEDIA_ACTIONS,
  WHATSAPP_SEND_ACTIONS,
  WHATSAPP_TOPIC_SIGNATURE_VERSION,
  phoneNumberIdArn,
  phoneStatements,
  wabaArn,
  whatsAppTopicName,
  whatsAppTopicPolicy,
} from "./workers-spec";

const accountId = aws.getCallerIdentityOutput({}).accountId;
const region = aws.getRegionOutput({}).region;

const phoneArn = $util.all([region, accountId, WhatsAppPhoneNumberId.value]).apply(([regionName, account, value]) => phoneNumberIdArn({ region: regionName, account }, value));
const appWabaArn = $util.all([region, accountId, WabaId.value]).apply(([regionName, account, value]) => wabaArn({ region: regionName, account }, value));

/** SEND_WHATSAPP (docs/architecture.md §14) for the `permissions` of every holder of PIPELINE; none while not connected. */
export const sendWhatsAppPermissions = phoneArn.apply((arn) => phoneStatements(arn, WHATSAPP_SEND_ACTIONS));

/**
 * What every holder of PIPELINE links for the outbound gate besides its data: the SES sender (SEND_EMAIL),
 * G2, the channel modes, the phone number of live sends and the demo recipients of the fence.
 */
export const pipelineLinks: unknown[] = [emailSender, GuardrailG2, ChannelModes, WhatsAppPhoneNumberId, SeedOverrides];

/** TIMERS of every holder of PIPELINE: the Linkable of infra/scheduler.ts (WP-31), late and optional. */
export function pipelineLateLinks(consumer: string): LinkList {
  return lateLinks(consumer, "scheduler", () => import("./scheduler"), LATE_LINKS.scheduler, "optional");
}

export const whatsAppTopic = new sst.aws.SnsTopic("WhatsAppInbound", {
  transform: {
    topic: (args) => {
      args.name = whatsAppTopicName($app.name);
      args.signatureVersion = WHATSAPP_TOPIC_SIGNATURE_VERSION;
    },
  },
});

export const whatsAppTopicPolicyResource = new aws.sns.TopicPolicy("WhatsAppInboundPolicy", {
  arn: whatsAppTopic.arn,
  policy: $util.all([whatsAppTopic.arn, accountId, appWabaArn]).apply(([topicArn, account, waba]) => JSON.stringify(whatsAppTopicPolicy({ topicArn, account, wabaArn: waba }))),
});

const inboundData = functionData("InboundWhatsApp");
const budget = FUNCTION_BUDGETS.InboundWhatsApp;

/** Producers of its queues and AnchorWriter (ANCHOR), from infra/workers.ts, which imports this module. */
const inboundWorkerLinks = [...(QUEUE_PRODUCERS.InboundWhatsApp ?? []), "anchorWriter"];

export const inboundWhatsApp = new sst.aws.Function("InboundWhatsApp", {
  description: "WhatsApp events of End User Messaging Social and the phone simulator: origin, identity, number, acknowledgement, queue.",
  handler: HANDLERS.InboundWhatsApp,
  timeout: `${budget.timeoutSeconds} seconds`,
  memory: `${budget.memoryMb} MB`,
  concurrency: { reserved: RESERVED_CONCURRENCY.InboundWhatsApp },
  link: links(
    [...inboundData.links, ...pipelineLinks, GuardrailG1],
    lateLinks("messaging-whatsapp", "workers", () => import("./workers"), inboundWorkerLinks),
    pipelineLateLinks("messaging-whatsapp"),
    lateLinks("messaging-whatsapp", "agentcore", () => import("./agentcore"), LATE_LINKS.classifier, "optional"),
  ),
  permissions: $util.all([$util.output(inboundData.permissions), buckets.Media.arn, phoneArn]).apply(([data, mediaArn, phone]) => [
    ...data,
    { actions: ["s3:ListBucket"], resources: [mediaArn], conditions: [{ test: "StringLike", variable: "s3:prefix", values: [LIVE_MEDIA_LIST_PREFIX] }] },
    ...phoneStatements(phone, [...WHATSAPP_SEND_ACTIONS, ...WHATSAPP_MEDIA_ACTIONS]),
  ]),
  transform: { role: fixedRole("InboundWhatsApp") },
});

/** Resource side of calling CoreMock (infra/mocks.ts). */
export const inboundWhatsAppMockGrants = grantMockInvoke("InboundWhatsApp", inboundWhatsApp);

export const inboundWhatsAppSubscription = whatsAppTopic.subscribe("InboundWhatsApp", inboundWhatsApp.arn);
