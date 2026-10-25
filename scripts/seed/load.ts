// `npm run seed:load` (docs/seed-spec.md §15): runs in CI after every `sst deploy`, inside
// `sst shell --stage poc`, so tables, buckets and secrets come from the links (`Resource`). The work is
// scripts/seed/load/run.ts; this file only builds its deps and prints a summary without any value of
// `SeedOverrides`.
//
//   npm run seed:load                      idempotent by fingerprint
//   npm run seed:load -- --force           uploads again and resets demo, qamin and gprobe
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { awsClientConfig } from "../../packages/bff/src/lib/clients";
import { createLogger } from "../../packages/bff/src/lib/log";
import { bucketName } from "../../packages/bff/src/lib/resource";
import { withRetry } from "../../packages/bff/src/lib/retry";
import { secretValue } from "../../packages/bff/src/lib/secrets";
import { stageWorldsDeps } from "../../packages/bff/src/worlds/stage";
import { memoryTemplateSource } from "../../packages/bff/src/worlds/template";
import { SEED_ROOT } from "./lib/constants";
import { USAGE, parseLoadArgs } from "./load/args";
import { type SeedUploader, runSeedLoad } from "./load/run";

// A template is 8 MB: a minute per object is generous, three attempts with backoff.
const UPLOAD_TIMEOUTS = { requestTimeoutMs: 60_000, connectionTimeoutMs: 2_000, maxAttempts: 3 } as const;

function s3Uploader(): SeedUploader {
  const client = new S3Client(awsClientConfig(UPLOAD_TIMEOUTS));
  const bucket = bucketName("Seed");
  return {
    async put(key, body, contentType) {
      await withRetry(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })), {
        attempts: 3,
        baseDelayMs: 200,
        shouldRetry: (error) => error instanceof Error && /Throttl|SlowDown|InternalError|ServiceUnavailable|Timeout/.test(error.name),
      });
    },
  };
}

function optionalSecret(): string | undefined {
  try {
    return secretValue("SeedOverrides");
  } catch {
    return undefined;
  }
}

function localTemplates() {
  const read = (name: string) => JSON.parse(readFileSync(join(SEED_ROOT, "data", "worlds", `${name}.json`), "utf8")) as unknown;
  return memoryTemplateSource({ demo: read("demo"), guest: read("guest"), "qa-min": read("qa-min") });
}

async function main(): Promise<void> {
  let force: boolean;
  try {
    ({ force } = parseLoadArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`seed:load: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  const log = createLogger({ bindings: { service: "seed-load" } });
  const stage = stageWorldsDeps({ log });
  stage.assertLinked();
  const summary = await runSeedLoad({ worlds: { ...stage, templates: localTemplates() }, uploader: s3Uploader(), overrides: optionalSecret, root: SEED_ROOT }, { force });
  const worlds = Object.entries(summary.worlds).map(([worldId, outcome]) => `${worldId} ${outcome}`).join(", ");
  console.log(
    `seed:load: ${summary.changed ? `seed loaded (${summary.uploaded} objects, ${summary.referenceRows} reference rows)` : "seed unchanged"}; worlds: ${worlds}; ` +
      `demo phones ${summary.livePhones}, demo recipients ${summary.demoRecipients}; sign-up switch ${summary.signupSwitch === "SEEDED" ? "opened" : "kept as it was"}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? `${String(error.code)}: ` : "";
    console.error(`seed:load: ${code}${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
