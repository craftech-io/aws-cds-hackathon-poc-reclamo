// A minimal, deterministic PNG codec for the synthetic receipts (docs/seed-spec.md §9): 8-bit RGB,
// filter 0 on every row, zlib stream from fflate (pure JS, pinned, fixed level) so the bytes never
// depend on the zlib of the machine's Node. Text chunks are `tEXt` (Latin-1 key and value). The
// reader walks the chunks with bounds checks; it is what the validator and the tests use.
import { unzlibSync, zlibSync } from "fflate";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** Fixed deflate level: changing it changes every receipt's bytes and hashes. */
export const DEFLATE_LEVEL = 9;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) throw new RangeError("tEXt chunks are Latin-1 only");
    out[index] = code;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export interface RgbImage {
  readonly width: number;
  readonly height: number;
  /** width × height × 3 bytes, row-major. */
  readonly pixels: Uint8Array;
}

/** Encodes an RGB image with the given `tEXt` chunks, in order (none for blurry and non-receipt images). */
export function encodePng(image: RgbImage, texts: ReadonlyArray<readonly [string, string]> = []): Uint8Array {
  const { width, height, pixels } = image;
  if (pixels.length !== width * height * 3) throw new RangeError("pixel buffer does not match the dimensions");
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const parts = [
    SIGNATURE,
    chunk("IHDR", header),
    ...texts.map(([key, value]) => chunk("tEXt", Uint8Array.from([...latin1(key), 0, ...latin1(value)]))),
    chunk("IDAT", zlibSync(raw, { level: DEFLATE_LEVEL })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly chunkTypes: readonly string[];
  /** Every `tEXt` chunk, in order. */
  readonly texts: ReadonlyArray<readonly [string, string]>;
  /** Whether every chunk's CRC matched. */
  readonly crcOk: boolean;
}

/** Reads the chunk structure of a PNG (bounded: refuses a chunk that overflows the file). */
export function readPng(bytes: Uint8Array): PngInfo {
  if (bytes.length < 8 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkTypes: string[] = [];
  const texts: Array<[string, string]> = [];
  let width = 0;
  let height = 0;
  let crcOk = true;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) throw new Error("chunk overflows the file");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) crcOk = false;
    chunkTypes.push(type);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
    }
    if (type === "tEXt") {
      const zero = data.indexOf(0);
      texts.push([String.fromCharCode(...data.subarray(0, zero)), String.fromCharCode(...data.subarray(zero + 1))]);
    }
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return { width, height, chunkTypes, texts, crcOk };
}

/** Decodes the pixels of a PNG this module wrote (filter 0, RGB 8-bit). */
export function decodePixels(bytes: Uint8Array): RgbImage {
  const info = readPng(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  const raw = unzlibSync(joined);
  const stride = info.width * 3;
  const pixels = new Uint8Array(info.width * info.height * 3);
  for (let y = 0; y < info.height; y += 1) {
    if (raw[y * (stride + 1)] !== 0) throw new Error("only filter 0 rows are supported");
    pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width: info.width, height: info.height, pixels };
}
