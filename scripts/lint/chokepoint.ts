// CI guard of ADR-0006: one way out. Every message to a customer (agent, operator or system) goes
// through `sendThroughGate` of packages/bff/src/outbound/gate.ts, whose transports are the only
// code that may send an email (SES) or a WhatsApp message (End User Messaging Social); and every
// SQS message goes through packages/bff/src/worker/enqueue.ts, the only producer of the queues.
// Media of a live WhatsApp message is fetched only by packages/bff/src/channels/whatsapp/media.ts.
// A command anywhere else fails the pipeline (docs/architecture.md §18).
//
//   npm run lint:chokepoint
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isTestFile, sourceFiles } from "./shared-walk";

export interface ChokepointFinding {
  readonly file: string;
  readonly line: number;
  readonly command: string;
}

export const TRANSPORTS_DIR = "packages/bff/src/outbound/transports/";
export const ENQUEUE_FILE = "packages/bff/src/worker/enqueue.ts";
export const MEDIA_FILE = "packages/bff/src/channels/whatsapp/media.ts";

const SEND_COMMANDS = /\b(SendEmailCommand|SendRawEmailCommand|SendBulkEmailCommand|SendTemplatedEmailCommand|SendWhatsAppMessageCommand)\b/;
const QUEUE_COMMANDS = /\b(SendMessageCommand|SendMessageBatchCommand)\b/;
const MEDIA_COMMANDS = /\b(GetWhatsAppMessageMediaCommand)\b/;

/** The only place each kind of command may appear. */
export function placeOf(command: string): string {
  if (QUEUE_COMMANDS.test(command)) return ENQUEUE_FILE;
  if (MEDIA_COMMANDS.test(command)) return MEDIA_FILE;
  return TRANSPORTS_DIR;
}

export function allowed(file: string, command: string): boolean {
  const place = placeOf(command);
  return place.endsWith("/") ? file.startsWith(place) : file === place;
}

export function findCommands(file: string, source: string): ChokepointFinding[] {
  const findings: ChokepointFinding[] = [];
  source.split("\n").forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const pattern of [SEND_COMMANDS, QUEUE_COMMANDS, MEDIA_COMMANDS]) {
      const command = pattern.exec(text)?.[1];
      if (command && !allowed(file, command)) findings.push({ file, line: index + 1, command });
    }
  });
  return findings;
}

export function scan(cwd: string): ChokepointFinding[] {
  return sourceFiles(cwd, ["packages", "scripts", "infra"], /\.tsx?$/)
    .filter((file) => !isTestFile(file) && !file.startsWith("scripts/lint/"))
    .flatMap((file) => findCommands(file, readFileSync(resolve(cwd, file), "utf8")));
}

function main(): void {
  const findings = scan(process.cwd());
  if (findings.length > 0) {
    console.error(`chokepoint: ${findings.length} send command(s) outside the single way out (ADR-0006):`);
    for (const { file, line, command } of findings) {
      console.error(`  ${file}:${line}  ${command} (only in ${placeOf(command)})`);
    }
    process.exit(1);
  }
  console.log("chokepoint: every send goes through outbound/transports/ and every queue message through worker/enqueue.ts.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
