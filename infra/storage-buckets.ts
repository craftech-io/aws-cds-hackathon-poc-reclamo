// Private buckets of docs/architecture.md §6, built from infra/storage-keys.ts.
//
//   Media        receipt images: live WhatsApp media, simulator uploads, seed copies, quarantine.
//                Scanned by GuardDuty (infra/malware.ts). 90 days; `qa/` and `up/` 2 days.
//   Documents    PDFs of the complaints. Life of the stage; `qa/` 2 days.
//   Emails       Raw MIME and viewer JSON of every email sent. 90 days; `qa/` 2 days.
//   Settlements  CSV settlement files the network mock publishes. Life of the stage; `qa/` 2 days.
//   Exports      Register and tape exports of the console. 7 days.
//   Seed         Templates, synthetic receipts and settlement files `seed:load` uploads.
//
// Every bucket is private (the full public access block SST creates), encrypted with SSE-S3 (declared
// here, so GuardDuty needs no KMS grant) and denies any request without TLS (SST's `enforceHttps`
// bucket policy). The three buckets the browser reaches with presigned URLs, `Media`, `Documents` and
// `Emails`, carry the fixed name `<app>-<stage>-<purpose>-<account>` (infra/ci-spec.ts), because the
// Content-Security-Policy of the bootstrap names their exact hosts; their CORS allows only the console
// origin and only the methods it uses. The others keep SST's name inside the bucket prefix the CI role
// is fenced to, and have no CORS.
//
// Links carry only the name and the ARN (`Resource.<Bucket>.name`); access is granted per function by
// infra/storage.ts (`bucketAccess`), never by SST's default `s3:*` link.
//
// Verify: `aws --profile craftech-demos s3api get-bucket-cors --bucket <name>` ·
// `get-bucket-lifecycle-configuration` · `get-public-access-block` · `get-bucket-encryption`.

import { browserBucketName } from "./ci-spec";
import { appUrl } from "./dns";
import type { BucketName } from "./iam-capabilities";
import { BUCKETS, BUCKET_NAMES, LOGICAL_BUCKET_NAME_MAX, bucketCors, lifecycleRules, type BucketSpec } from "./storage-keys";

// Registered before the first bucket exists: SST reads the link of a component right after creating it.
sst.Linkable.wrap(sst.aws.Bucket, (bucket) => ({ properties: { name: bucket.name, arn: bucket.arn } }));

const accountId = aws.getCallerIdentityOutput({}).accountId;

function createBucket(name: BucketName): sst.aws.Bucket {
  if (name.length > LOGICAL_BUCKET_NAME_MAX) throw new Error(`Bucket "${name}": logical names of at most ${LOGICAL_BUCKET_NAME_MAX} characters.`);
  const spec: BucketSpec = BUCKETS[name];
  const purpose = spec.fixed;
  const bucket = new sst.aws.Bucket(name, {
    cors: bucketCors(name, appUrl),
    transform: {
      bucket: (args) => {
        if (purpose !== undefined) args.bucket = accountId.apply((account) => browserBucketName($app.name, $app.stage, purpose, account));
      },
    },
  });
  new aws.s3.BucketServerSideEncryptionConfiguration(`${name}Encryption`, {
    bucket: bucket.name,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
  });
  const rules = lifecycleRules(name);
  if (rules.length > 0) new aws.s3.BucketLifecycleConfiguration(`${name}Lifecycle`, { bucket: bucket.name, rules });
  return bucket;
}

export const buckets = Object.fromEntries(BUCKET_NAMES.map((name) => [name, createBucket(name)])) as Record<BucketName, sst.aws.Bucket>;

// One named export per bucket as well, for modules that resolve a bucket late (infra/late-links.ts).
export const { Media, Documents, Emails, Settlements, Exports, Seed } = buckets;
