// An image a visitor uploads from the phone simulator (SC-03/10, docs/test-plan.md §4.5): a legible
// synthetic receipt of the seed with one extra `tEXt` chunk before `IEND`, so its pixels and its
// `ReceiptCode` chunk stay the same but its hash is no longer a seed hash (a seed copy skips the scan,
// and this step is about the scan resolving before the message). It goes to `Media` through the
// presigned POST of `console.simulator.presignReceipt`, exactly as the browser sends it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG chunk: length, type, data and the CRC-32 of type and data. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** The PNG with a `tEXt` chunk `keyword\0text` inserted right before `IEND`. */
export function withTextChunk(png: Buffer, keyword: string, text: string): Buffer {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new TypeError("not a PNG");
  const iend = png.lastIndexOf(Buffer.from("IEND", "latin1")) - 4;
  if (iend < 8) throw new TypeError("the PNG has no IEND chunk");
  return Buffer.concat([png.subarray(0, iend), pngChunk("tEXt", Buffer.from(`${keyword}\0${text}`, "latin1")), png.subarray(iend)]);
}

/** A seed receipt of the repository (scripts/seed/media/receipts/<variant>/<cnn>-<seq>.png), made unique to the run. */
export function uniqueReceipt(variant: string, model: string, runId: string, seq = 1): Buffer {
  const path = fileURLToPath(new URL(`../../seed/media/receipts/${variant}/${model.toLowerCase()}-${seq}.png`, import.meta.url));
  return withTextChunk(readFileSync(path), "Comment", `qa upload ${runId}`);
}

export interface PresignedPost {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly key: string;
}

/** The presigned POST of the simulator, as the browser sends it (fields first, the file last). */
export async function postUpload(post: PresignedPost, bytes: Buffer, contentType: string): Promise<number> {
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), "receipt.png");
  const response = await fetch(post.url, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  return response.status;
}
