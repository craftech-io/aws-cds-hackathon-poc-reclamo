// Registers the four `UTILITY` `es_AR` WhatsApp templates with Meta through End User Messaging Social
// (docs/architecture-integrations.md §3.1 and §3.3, docs/architecture-integrations.md §3.4 step 5). The texts have one
// source, packages/bff/src/copy/templates.ts; the button titles, copy/buttons.ts. Runs inside `sst shell`
// once the product's own WABA is connected (the `WabaId` secret is no longer `not-connected`); without
// `--apply` it only prints what it would do. Idempotent: a template Meta already has is never created
// again, only its id and status are recorded.
//
//   npm run channels:whatsapp-templates -- --stage poc            plan: which exist, which would be created
//   npm run channels:whatsapp-templates -- --stage poc --apply    creates the missing ones and records
//                                                                 `metaTemplateId`, `status` and Meta's
//                                                                 category in `Reference/TEMPLATE#WHATSAPP`
//
// A template Meta files under any category other than UTILITY is recorded `DISABLED` (the live
// transport sends only `APPROVED` ones) and reported: fix its text in copy/templates.ts and repeat.
// The row must exist (`seed:load` writes it `LOCAL_ONLY`); the update is conditional on it.
//
// SDK commands, checked in the installed `@aws-sdk/client-socialmessaging` `.d.ts`:
// `ListWhatsAppMessageTemplatesCommand {id, nextToken}` → `templates[{templateName, templateLanguage,
// metaTemplateId, templateStatus, templateCategory}]`, and `CreateWhatsAppMessageTemplateCommand
// {id, templateDefinition: Uint8Array}` → `{metaTemplateId, templateStatus, category}`. The definition is
// Meta's template JSON (name, language, category, components). Nothing here sends a message.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateWhatsAppMessageTemplateCommand, ListWhatsAppMessageTemplatesCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { STAGE_REGION } from "../../packages/bff/src/channels/whatsapp/config";
import { TEMPLATE_REFERENCE, TemplateStatus } from "../../packages/bff/src/channels/whatsapp/template-records";
import { DynamoStore } from "../../packages/bff/src/connector/dynamo/engine";
import { keys } from "../../packages/bff/src/connector/keys";
import { cond, type TableStore } from "../../packages/bff/src/connector/store";
import { WHATSAPP_TEMPLATES, templateButtonTitles, type WhatsAppTemplate } from "../../packages/bff/src/copy/templates";
import type { TemplateName } from "../../packages/bff/src/copy/types";
import { awsClientConfig } from "../../packages/bff/src/lib/clients";
import { secretValue } from "../../packages/bff/src/lib/secrets";
import { parseFlags } from "./cli-args";

export const STAGE = "poc";
export const NOT_CONNECTED = "not-connected";
export const EXPECTED_CATEGORY = "UTILITY";

export interface StageArgs {
  stage?: string;
  apply?: boolean;
}

/** `--stage poc` (required, the only stage) and `--apply`; any other flag is refused. */
export function parseStageArgs(argv: readonly string[]): StageArgs {
  const args: StageArgs = {};
  parseFlags(argv, { "--stage": (value) => void (args.stage = value()), "--apply": () => void (args.apply = true) });
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  return args;
}

/**
 * The id End User Messaging Social takes (`waba-<id>`) from the `WabaId` secret, which may hold that id
 * or the WABA's ARN; `undefined` while it is `not-connected`. The value is never echoed in an error.
 */
export function wabaIdOf(secret: string): string | undefined {
  const value = secret.trim();
  if (value === NOT_CONNECTED) return undefined;
  if (/^waba-[0-9a-zA-Z]+$/.test(value)) return value;
  const fromArn = /^arn:aws:social-messaging:[a-z0-9-]+:\d{12}:waba\/([0-9a-zA-Z]+)$/.exec(value)?.[1];
  if (fromArn !== undefined) return `waba-${fromArn}`;
  throw new RangeError("the WabaId secret is neither not-connected, waba-<id> nor a WABA ARN; load it again with npx sst secret set WabaId … --stage poc");
}

/** Meta's template JSON for one of the templates of copy/templates.ts. */
export function metaDefinition(template: WhatsAppTemplate): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [{ type: "BODY", text: template.body, example: { body_text: [[...template.examples]] } }];
  const titles = templateButtonTitles(template.name);
  if (titles.length > 0) components.push({ type: "BUTTONS", buttons: titles.map((text) => ({ type: "QUICK_REPLY", text })) });
  return { name: template.name, language: template.language, category: template.category, components };
}

/** Meta's status as the `Reference` row stores it; anything unknown is still under review. */
export function statusOf(remote: string | undefined, category: string | undefined): TemplateStatus {
  if (category !== undefined && category.toUpperCase() !== EXPECTED_CATEGORY) return "DISABLED";
  const parsed = TemplateStatus.safeParse(remote?.toUpperCase());
  return parsed.success && parsed.data !== "LOCAL_ONLY" ? parsed.data : "PENDING";
}

export interface RemoteTemplate {
  readonly name: string;
  readonly language: string;
  readonly metaTemplateId?: string;
  readonly status?: string;
  readonly category?: string;
}

export interface TemplateUpdate {
  readonly status: TemplateStatus;
  readonly metaTemplateId?: string;
  readonly metaCategory?: string;
}

export interface TemplatesDeps {
  list(wabaId: string): Promise<RemoteTemplate[]>;
  create(wabaId: string, definition: Record<string, unknown>): Promise<Omit<RemoteTemplate, "name" | "language">>;
  record(name: TemplateName, update: TemplateUpdate): Promise<void>;
  /** The raw `WabaId` secret. */
  wabaSecret(): string;
  report(line: string): void;
}

function updateOf(remote: Omit<RemoteTemplate, "name" | "language">): TemplateUpdate {
  return {
    status: statusOf(remote.status, remote.category),
    ...(remote.metaTemplateId === undefined ? {} : { metaTemplateId: remote.metaTemplateId }),
    ...(remote.category === undefined ? {} : { metaCategory: remote.category }),
  };
}

export async function runTemplates(args: StageArgs, deps: TemplatesDeps): Promise<{ readonly created: number; readonly existing: number }> {
  const wabaId = wabaIdOf(deps.wabaSecret());
  if (wabaId === undefined) throw new RangeError("the WABA is not configured (secret WabaId is not-connected): link a WhatsApp Business Account in End User Messaging Social first");
  const remote = await deps.list(wabaId);
  let created = 0;
  let existing = 0;
  for (const template of Object.values(WHATSAPP_TEMPLATES)) {
    const found = remote.find((entry) => entry.name === template.name && entry.language === template.language);
    if (found !== undefined) {
      existing += 1;
      deps.report(`${template.name}: exists (${found.status ?? "unknown status"})`);
    } else if (!args.apply) {
      deps.report(`${template.name}: would be created (run with --apply)`);
      continue;
    }
    const answer = found ?? (await deps.create(wabaId, metaDefinition(template)));
    if (found === undefined) {
      created += 1;
      deps.report(`${template.name}: created (${answer.status ?? "PENDING"})`);
    }
    const update = updateOf(answer);
    if (update.status === "DISABLED") deps.report(`${template.name}: Meta filed it as ${answer.category ?? "?"}, not ${EXPECTED_CATEGORY}; recorded DISABLED, fix copy/templates.ts and repeat`);
    if (args.apply) await deps.record(template.name, update);
  }
  return { created, existing };
}

const TIMEOUTS = { requestTimeoutMs: 10_000, connectionTimeoutMs: 2_000, maxAttempts: 4 } as const;

export function stageDeps(client = new SocialMessagingClient({ region: STAGE_REGION, ...awsClientConfig(TIMEOUTS) }), store: TableStore = new DynamoStore()): TemplatesDeps {
  return {
    async list(id) {
      const templates: RemoteTemplate[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(new ListWhatsAppMessageTemplatesCommand({ id, ...(nextToken === undefined ? {} : { nextToken }) }));
        for (const entry of page.templates ?? []) {
          templates.push({
            name: entry.templateName ?? "",
            language: entry.templateLanguage ?? "",
            ...(entry.metaTemplateId === undefined ? {} : { metaTemplateId: entry.metaTemplateId }),
            ...(entry.templateStatus === undefined ? {} : { status: entry.templateStatus }),
            ...(entry.templateCategory === undefined ? {} : { category: entry.templateCategory }),
          });
        }
        nextToken = page.nextToken;
      } while (nextToken);
      return templates;
    },
    async create(id, definition) {
      const answer = await client.send(new CreateWhatsAppMessageTemplateCommand({ id, templateDefinition: new TextEncoder().encode(JSON.stringify(definition)) }));
      return {
        ...(answer.metaTemplateId === undefined ? {} : { metaTemplateId: answer.metaTemplateId }),
        ...(answer.templateStatus === undefined ? {} : { status: answer.templateStatus }),
        ...(answer.category === undefined ? {} : { category: answer.category }),
      };
    },
    async record(name, update) {
      const key = keys.reference(TEMPLATE_REFERENCE.type, TEMPLATE_REFERENCE.scope, name);
      await store.write({ kind: "update", table: "Reference", key, update: { set: { ...update } }, condition: cond.present() });
    },
    wabaSecret: () => secretValue("WabaId"),
    report: (line) => process.stdout.write(`channels:whatsapp-templates: ${line}\n`),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseStageArgs(process.argv.slice(2));
    await runTemplates(args, stageDeps());
  } catch (error: unknown) {
    process.stderr.write(`channels:whatsapp-templates: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  }
}
