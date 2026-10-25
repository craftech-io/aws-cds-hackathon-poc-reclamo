/// <reference path="../../../sst-env.d.ts" />
// The email client of a deployed function: everything it needs comes from what SST links in
// (`Resource`, never `process.env`): the `Emails` bucket, the `SeedOverrides` secret (demo recipients;
// absent or malformed means none) and the app and stage that name the configuration set. The function
// that runs the SES command is the only part the caller brings: the gate's email transport in
// outbound/transports/, the one directory where a send command may appear (ADR-0006).
import { z } from "zod";
import { ulid } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { bucketName, currentStage, readLinked } from "../../lib/resource";
import { secretValue } from "../../lib/secrets";
import { configurationSetName } from "./config";
import { type EmailClient, type EmailClientConnector, type SesSendFn, createEmailClient } from "./outbound";
import { demoRecipientsFromSeedOverrides } from "./recipient-fence";
import { s3EmailObjectStore } from "./store";

const AppLink = z.object({ name: z.string().min(1) });

/** The configuration set of this app and stage (`aws-cds-hackathon-poc-reclamo-email-poc`). */
export function stageConfigurationSet(): string {
  return configurationSetName(readLinked("App", AppLink).name, currentStage());
}

function linkedSeedOverrides(): string | undefined {
  try {
    return secretValue("SeedOverrides");
  } catch {
    // Not linked or empty: no demo recipient at all (fails closed).
    return undefined;
  }
}

export function stageEmailClient(input: { readonly sendRaw: SesSendFn; readonly connector: EmailClientConnector; readonly log: Logger }): EmailClient {
  let demoRecipients: readonly string[] | undefined;
  return createEmailClient({
    connector: input.connector,
    objects: s3EmailObjectStore(bucketName("Emails")),
    sendRaw: input.sendRaw,
    demoRecipients: () => (demoRecipients ??= demoRecipientsFromSeedOverrides(linkedSeedOverrides())),
    configurationSet: stageConfigurationSet(),
    stage: currentStage(),
    now: () => new Date(),
    newMailId: () => ulid(),
    log: input.log,
  });
}
