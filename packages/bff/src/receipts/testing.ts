// Test helpers of the receipt reader: tiny but well-formed PNG and JPEG files (a header, a text chunk
// with valid CRC, opaque image data: nothing here decodes pixels), the `ReceiptCode` chunk of a
// synthetic receipt, Bedrock answers as `record_receipt` would carry them, and a capturing logger.
import { type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { sha256Hex } from "../lib/crypto";
import { type LogSink, type Logger, createLogger } from "../lib/log";
import type { BedrockReading, BedrockReceiptReader } from "./bedrock-reader";
import { RECORD_RECEIPT_TOOL, type RawReading } from "./schema";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: Uint8Array, options: { badCrc?: boolean } = {}): number[] {
  const typed = Uint8Array.from([...type].map((char) => char.charCodeAt(0)).concat([...data]));
  const crc = crc32(typed) ^ (options.badCrc ? 1 : 0);
  return [...u32(data.length), ...typed, ...u32(crc >>> 0)];
}

function latin1(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0) & 0xff);
}

export interface PngOptions {
  readonly width?: number;
  readonly height?: number;
  readonly texts?: ReadonlyArray<readonly [string, string]>;
  readonly badCrc?: boolean;
  /** Bytes of opaque image data (to reach a size). */
  readonly dataBytes?: number;
}

/** A PNG: signature, IHDR, the text chunks (before IDAT, as the seed writes them), IDAT and IEND. */
export function png(options: PngOptions = {}): Uint8Array {
  const header = Uint8Array.from([...u32(options.width ?? 900), ...u32(options.height ?? 1400), 8, 2, 0, 0, 0]);
  const texts = (options.texts ?? []).flatMap(([key, value]) => chunk("tEXt", Uint8Array.from([...latin1(key), 0, ...latin1(value)]), { badCrc: options.badCrc ?? false }));
  const data = new Uint8Array(options.dataBytes ?? 64).fill(0x5a);
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", header), ...texts, ...chunk("IDAT", data), ...chunk("IEND", new Uint8Array(0))]);
}

/** A JPEG with an EXIF-like APP1 segment before its start-of-frame. */
export function jpeg(width = 1200, height = 1600): Uint8Array {
  const app1 = [0xff, 0xe1, 0x00, 0x10, ...latin1("Exif\0\0"), 0, 0, 0, 0, 0, 0, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, ...app1, ...sof, 0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9]);
}

export interface ChunkFields {
  readonly network: "NORTE" | "SUR" | "WALLET";
  readonly operationCode: string;
  /** Pesos with two decimals, as printed. */
  readonly amount: string;
  readonly paidAtLocal: string;
}

/** `RC1|<network>|<code>|<amount>|<paidAtLocal>|<check>` as the seed writes it. */
export function receiptCode(fields: ChunkFields, check?: string): string {
  const body = `RC1|${fields.network}|${fields.operationCode}|${fields.amount}|${fields.paidAtLocal}`;
  return `${body}|${check ?? sha256Hex(body).slice(0, 8)}`;
}

/** A synthetic readable receipt carrying its chunk. */
export function receiptPng(fields: ChunkFields, options: Omit<PngOptions, "texts"> = {}): Uint8Array {
  return png({ ...options, texts: [["ReceiptCode", receiptCode(fields)]] });
}

/** C04's receipt of the scenarios: Red de cobro Sur, valid check digit. */
export const SUR_FIELDS: ChunkFields = { network: "SUR", operationCode: "SUR-20261002-004211-7", amount: "118640.00", paidAtLocal: "2026-10-02T11:20" };

/** What Bedrock reads off `SUR_FIELDS` (pesos as a number). */
export function clearReading(overrides: Partial<RawReading> = {}): RawReading {
  return {
    isReceipt: true,
    network: "SUR",
    operationCode: SUR_FIELDS.operationCode,
    amount: 118_640,
    currency: "ARS",
    paidAtLocal: SUR_FIELDS.paidAtLocal,
    payerReference: "cus-0004",
    legibility: "CLEAR",
    suspiciousText: false,
    ...overrides,
  };
}

/** A `Converse` answer whose only content is the forced `record_receipt` call. */
export function converseAnswer(input: unknown): Pick<ConverseCommandOutput, "output" | "stopReason"> {
  return { stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "tu-1", name: RECORD_RECEIPT_TOOL, input: input as never } }] } } };
}

/** A Bedrock port that answers from a script and counts its calls. */
export function scriptedBedrock(...answers: BedrockReading[]): BedrockReceiptReader & { calls: number } {
  const reader = {
    calls: 0,
    async read() {
      const answer = answers[Math.min(reader.calls, answers.length - 1)];
      reader.calls += 1;
      if (answer === undefined) throw new Error("no scripted answer");
      return answer;
    },
  };
  return reader;
}

export function testLog(): { log: Logger; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  const sink: LogSink = (line) => raw.push(line);
  return { log: createLogger({ sink, level: "debug" }), lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>) };
}
