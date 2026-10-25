// What an image is, read from its bytes and never from its name or declared type (docs/architecture.md
// §6): magic number (`FFD8FF` JPEG, `89504E47` PNG), size at most 3.75 MB and both sides at most
// 8,000 px, read from the header without decoding the image. Media intake runs it after the scan, the
// receipt reader again before Bedrock: an image that fails never reaches a model.
import { type ImageType, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from "./schema";

export type ImageProblem = "EMPTY" | "TOO_LARGE" | "BAD_MAGIC" | "UNREADABLE_HEADER" | "TOO_MANY_PIXELS";

export type ImageCheck =
  | { readonly ok: true; readonly contentType: ImageType; readonly width: number; readonly height: number; readonly sizeBytes: number }
  | { readonly ok: false; readonly problem: ImageProblem };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The type the magic number says, or `undefined` for anything that is not a JPEG or a PNG. */
export function magicType(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "image/png";
  return undefined;
}

function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) >>> 0) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

/** Width and height of the PNG's `IHDR`, which must be the first chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (type !== "IHDR" || u32(bytes, 8) !== 13) return undefined;
  return { width: u32(bytes, 16), height: u32(bytes, 20) };
}

// Start-of-frame markers (C0-CF except DHT C4, JPG C8 and DAC CC) carry the frame size.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Markers without a length: SOI, EOI, RSTn and TEM. */
const STANDALONE = new Set([0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0x01]);
/** Segments walked before giving up: a real header has a dozen. */
const MAX_JPEG_SEGMENTS = 256;

/** Width and height of the JPEG's first start-of-frame segment, walking the marker segments. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS && offset + 4 <= bytes.length; segments += 1) {
    if (bytes[offset] !== 0xff) return undefined;
    let marker = bytes[offset + 1] ?? 0;
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1] ?? 0;
    }
    if (marker === 0xda || marker === 0xd9) return undefined;
    if (STANDALONE.has(marker)) {
      offset += 2;
      continue;
    }
    const length = u16(bytes, offset + 2);
    if (length < 2) return undefined;
    if (SOF.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return { height: u16(bytes, offset + 5), width: u16(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

/** The checks of §6 on the whole object. */
export function inspectImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, problem: "EMPTY" };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, problem: "TOO_LARGE" };
  const contentType = magicType(bytes);
  if (contentType === undefined) return { ok: false, problem: "BAD_MAGIC" };
  const size = contentType === "image/png" ? pngSize(bytes) : jpegSize(bytes);
  if (size === undefined || size.width < 1 || size.height < 1) return { ok: false, problem: "UNREADABLE_HEADER" };
  if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) return { ok: false, problem: "TOO_MANY_PIXELS" };
  return { ok: true, contentType, width: size.width, height: size.height, sizeBytes: bytes.length };
}

/** `Converse`'s image format of a content type. */
export function converseFormat(contentType: ImageType): "png" | "jpeg" {
  return contentType === "image/png" ? "png" : "jpeg";
}
