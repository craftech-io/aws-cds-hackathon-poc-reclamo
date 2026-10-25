// Points the events of the product's own WhatsApp Business Account at the inbound topic
// `aws-cds-hackathon-poc-reclamo-wa-inbound` (docs/architecture-integrations.md §3.1 and §3.4
// step 4). A WABA has a single event destination. Idempotent: a WABA already pointing at the topic is
// left as it is. Runs inside `sst shell` once a WABA is configured; without `--apply` it only prints
// what it would do.
//
//   npm run channels:waba-event-destination -- --stage poc
//   npm run channels:waba-event-destination -- --stage poc --apply
//
// The topic's account and region come from the linked WABA's own ARN, so nothing is typed by hand, and
// the topic's name from channels/whatsapp/config.ts (the same one infra/workers-spec.ts gives it). The topic's policy accepts
// End User Messaging Social only for this WABA (`aws:SourceArn`), which infra/messaging-whatsapp.ts adds
// on the first CI deploy after the `WabaId` secret is loaded: run this after that deploy.
//
// SDK commands, checked in the installed `@aws-sdk/client-socialmessaging` `.d.ts`:
// `GetLinkedWhatsAppBusinessAccountCommand {id}` → `account{arn, eventDestinations[{eventDestinationArn,
// roleArn?}]}` and `PutWhatsAppBusinessAccountEventDestinationsCommand {id, eventDestinations}` → `{}`.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GetLinkedWhatsAppBusinessAccountCommand, PutWhatsAppBusinessAccountEventDestinationsCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { STAGE_REGION, WA_INBOUND_TOPIC_NAME } from "../../packages/bff/src/channels/whatsapp/config";
import { awsClientConfig } from "../../packages/bff/src/lib/clients";
import { secretValue } from "../../packages/bff/src/lib/secrets";
import { type StageArgs, parseStageArgs, wabaIdOf } from "./whatsapp-templates";

/** `<app>-wa-inbound`, the same name infra/workers-spec.ts gives the topic (`whatsAppTopicName`). */
export const TOPIC_NAME = WA_INBOUND_TOPIC_NAME;

export { parseStageArgs };

/** `arn:aws:sns:<region>:<account>:<topic>` from the WABA's own ARN (`arn:aws:social-messaging:<region>:<account>:waba/<id>`). */
export function topicArnFor(wabaArn: string): string {
  const match = /^arn:(aws[a-z-]*):social-messaging:([a-z0-9-]+):(\d{12}):waba\/[0-9a-zA-Z]+$/.exec(wabaArn);
  if (match === null) throw new RangeError("unexpected ARN of the linked WABA");
  const [, partition, region, account] = match;
  return `arn:${partition ?? "aws"}:sns:${region ?? ""}:${account ?? ""}:${TOPIC_NAME}`;
}

export interface LinkedWaba {
  readonly arn: string;
  readonly eventDestinations: ReadonlyArray<{ readonly eventDestinationArn: string }>;
}

export interface DestinationDeps {
  get(wabaId: string): Promise<LinkedWaba>;
  put(wabaId: string, topicArn: string): Promise<void>;
  /** The raw `WabaId` secret. */
  wabaSecret(): string;
  report(line: string): void;
}

export type DestinationOutcome = "ALREADY_SET" | "WOULD_SET" | "SET";

export async function runDestination(args: StageArgs, deps: DestinationDeps): Promise<DestinationOutcome> {
  const wabaId = wabaIdOf(deps.wabaSecret());
  if (wabaId === undefined) throw new RangeError("the WABA is not configured (secret WabaId is not-connected): link a WhatsApp Business Account in End User Messaging Social first");
  const waba = await deps.get(wabaId);
  const topicArn = topicArnFor(waba.arn);
  if (waba.eventDestinations.length === 1 && waba.eventDestinations[0]?.eventDestinationArn === topicArn) {
    deps.report(`events already go to ${TOPIC_NAME}`);
    return "ALREADY_SET";
  }
  if (!args.apply) {
    deps.report(`would send the WABA's events to ${TOPIC_NAME} (run with --apply)`);
    return "WOULD_SET";
  }
  await deps.put(wabaId, topicArn);
  deps.report(`events now go to ${TOPIC_NAME}`);
  return "SET";
}

const TIMEOUTS = { requestTimeoutMs: 10_000, connectionTimeoutMs: 2_000, maxAttempts: 4 } as const;

export function stageDeps(client = new SocialMessagingClient({ region: STAGE_REGION, ...awsClientConfig(TIMEOUTS) })): DestinationDeps {
  return {
    async get(id) {
      const { account } = await client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id }));
      if (account?.arn === undefined) throw new Error("the WABA is not linked to this account");
      return { arn: account.arn, eventDestinations: (account.eventDestinations ?? []).map((destination) => ({ eventDestinationArn: destination.eventDestinationArn ?? "" })) };
    },
    async put(id, topicArn) {
      await client.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id, eventDestinations: [{ eventDestinationArn: topicArn }] }));
    },
    wabaSecret: () => secretValue("WabaId"),
    report: (line) => process.stdout.write(`channels:waba-event-destination: ${line}\n`),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runDestination(parseStageArgs(process.argv.slice(2)), stageDeps());
  } catch (error: unknown) {
    process.stderr.write(`channels:waba-event-destination: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  }
}
