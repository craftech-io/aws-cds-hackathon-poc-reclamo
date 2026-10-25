// The buckets of an in-process world (`Media`, `Documents`, `Emails`, `Settlements`, `Seed`) behind the
// one call every S3 helper of the BFF makes, `send(command)`: the real helpers (media-store.ts,
// media-intake/objects.ts, receipts/s3-object.ts, outbound/documents.ts, networks/settlement-files.ts)
// run unchanged over it. Only the commands the code sends are answered; any other one throws, loudly.
// `Settlements` reads the network mock's own objects, so a file the mock publishes is the file the
// reconciliation reads. Nothing leaves the process.
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly tags: Readonly<Record<string, string>>;
}

/** A bucket whose objects live somewhere else (the network mock's `Map<key, csv>`). */
export interface MountedBucket {
  get(key: string): string | undefined;
}

class NotFound extends Error {
  constructor(name: "NotFound" | "NoSuchKey") {
    super("the object does not exist");
    this.name = name;
  }
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  throw new TypeError("the fake S3 takes a Uint8Array or a string body");
}

function bodyOf(bytes: Uint8Array) {
  return {
    transformToByteArray: async () => Uint8Array.from(bytes),
    transformToString: async () => new TextDecoder().decode(bytes),
  };
}

/** `bucket/key` with each key segment URL-encoded, as `CopySource` carries it. */
function parseCopySource(source: string): { readonly bucket: string; readonly key: string } {
  const [bucket = "", ...rest] = source.replace(/^\//, "").split("/");
  return { bucket, key: rest.map(decodeURIComponent).join("/") };
}

export class FakeS3 {
  private readonly buckets = new Map<string, Map<string, StoredObject>>();
  private readonly mounted = new Map<string, MountedBucket>();
  /** Every command answered, as `<Command> <bucket>/<key>`. */
  readonly calls: string[] = [];

  mount(bucket: string, source: MountedBucket): void {
    this.mounted.set(bucket, source);
  }

  put(bucket: string, key: string, bytes: Uint8Array, contentType = "application/octet-stream", tags: Readonly<Record<string, string>> = {}): void {
    this.bucketOf(bucket).set(key, { bytes: Uint8Array.from(bytes), contentType, tags: { ...tags } });
  }

  get(bucket: string, key: string): StoredObject | undefined {
    const stored = this.buckets.get(bucket)?.get(key);
    if (stored !== undefined) return stored;
    const mounted = this.mounted.get(bucket)?.get(key);
    return mounted === undefined ? undefined : { bytes: new TextEncoder().encode(mounted), contentType: "text/csv", tags: {} };
  }

  /** Sets one tag of an object (GuardDuty's scan status, `media-intake/schema.ts` `SCAN_STATUS_TAG`). */
  tag(bucket: string, key: string, name: string, value: string): void {
    const stored = this.get(bucket, key);
    if (stored === undefined) throw new NotFound("NoSuchKey");
    this.bucketOf(bucket).set(key, { ...stored, tags: { ...stored.tags, [name]: value } });
  }

  keys(bucket: string, prefix = ""): string[] {
    return [...(this.buckets.get(bucket)?.keys() ?? [])].filter((key) => key.startsWith(prefix)).sort();
  }

  async send(command: object): Promise<Record<string, unknown>> {
    if (command instanceof PutObjectCommand) {
      const { Bucket = "", Key = "", Body, ContentType } = command.input;
      this.calls.push(`PutObject ${Bucket}/${Key}`);
      this.put(Bucket, Key, toBytes(Body), ContentType ?? "application/octet-stream");
      return { ETag: `"${Key.length}"` };
    }
    if (command instanceof GetObjectCommand) {
      const { Bucket = "", Key = "" } = command.input;
      this.calls.push(`GetObject ${Bucket}/${Key}`);
      const stored = this.require(Bucket, Key, "NoSuchKey");
      return { Body: bodyOf(stored.bytes), ContentLength: stored.bytes.byteLength, ContentType: stored.contentType };
    }
    if (command instanceof HeadObjectCommand) {
      const { Bucket = "", Key = "" } = command.input;
      this.calls.push(`HeadObject ${Bucket}/${Key}`);
      const stored = this.require(Bucket, Key, "NotFound");
      return { ContentLength: stored.bytes.byteLength, ContentType: stored.contentType };
    }
    if (command instanceof CopyObjectCommand) {
      const { Bucket = "", Key = "", CopySource = "", ContentType } = command.input;
      this.calls.push(`CopyObject ${Bucket}/${Key}`);
      const source = parseCopySource(CopySource);
      const stored = this.require(source.bucket, source.key, "NoSuchKey");
      this.put(Bucket, Key, stored.bytes, ContentType ?? stored.contentType, stored.tags);
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      const { Bucket = "", Key = "" } = command.input;
      this.calls.push(`DeleteObject ${Bucket}/${Key}`);
      this.buckets.get(Bucket)?.delete(Key);
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const { Bucket = "", Prefix = "", MaxKeys = 1_000 } = command.input;
      this.calls.push(`ListObjectsV2 ${Bucket}/${Prefix}`);
      const keys = this.keys(Bucket, Prefix).slice(0, MaxKeys);
      return { Contents: keys.map((key) => ({ Key: key, Size: this.get(Bucket, key)?.bytes.byteLength ?? 0 })) };
    }
    if (command instanceof GetObjectTaggingCommand) {
      const { Bucket = "", Key = "" } = command.input;
      this.calls.push(`GetObjectTagging ${Bucket}/${Key}`);
      const stored = this.require(Bucket, Key, "NoSuchKey");
      return { TagSet: Object.entries(stored.tags).map(([name, value]) => ({ Key: name, Value: value })) };
    }
    throw new Error(`the fake S3 does not answer ${command.constructor.name}`);
  }

  private bucketOf(bucket: string): Map<string, StoredObject> {
    let objects = this.buckets.get(bucket);
    if (objects === undefined) {
      objects = new Map();
      this.buckets.set(bucket, objects);
    }
    return objects;
  }

  private require(bucket: string, key: string, missing: "NotFound" | "NoSuchKey"): StoredObject {
    const stored = this.get(bucket, key);
    if (stored === undefined) throw new NotFound(missing);
    return stored;
  }
}
