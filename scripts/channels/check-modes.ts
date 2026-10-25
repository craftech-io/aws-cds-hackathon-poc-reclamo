// CI check of the channel modes (ADR-0002, FL-104 (a)): no world may run WhatsApp `live` without an
// explicit approval, and only `demo` and the QA live worlds `qa-live-*` may ever be live. Guest,
// `gtest`, `qa-*` and `sim-*` worlds are always simulated.
//
// Reads `infra/channel-modes.ts`: the email mode is a plain string literal on its own line,
// `liveWorlds` a literal array of strings and `whatsappLiveApproval` either `null` or an object
// literal `{ date: "AAAA-MM-DD", approver: "<rol>" }`. When `liveWorlds` is not empty the approval must
// be present, with an ISO date that is not in the future and a non-empty approver. Anything else fails
// the build with the exact reason, so live mode needs a reviewed PR that sets both the world and the
// approval.
//
// Usage: `npm run channels:check-modes` (from the repository root). Exit 1 on any violation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODES_FILE = "infra/channel-modes.ts";

/** The only worlds that may run WhatsApp live: the operator's world and the QA live worlds of SC-23. */
export const LIVE_WORLD_ALLOWED = /^(demo|qa-live-\*|qa-live-[a-z0-9-]+)$/;

export interface Approval {
  readonly date?: string;
  readonly approver?: string;
}

export interface Modes {
  readonly email?: string;
  readonly liveWorlds?: readonly string[];
  /** `null` when the literal is `null`, undefined when the constant is missing or not a literal. */
  readonly approval?: Approval | null;
}

const EMAIL_LINE = /^\s*email\s*:\s*"([a-z]+)"\s*,?/m;
const LIVE_WORLDS = /\bliveWorlds\s*:\s*\[([^\]]*)\]/;
const STRING_ITEM = /^\s*"([^"]*)"\s*$/;
const APPROVAL = /\bexport const whatsappLiveApproval\s*:[^=]*=\s*(null|\{[^}]*\})\s*;/;
const APPROVAL_FIELD = (name: string) => new RegExp(`\\b${name}\\s*:\\s*"([^"]*)"`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readApproval(source: string): Approval | null | undefined {
  const literal = APPROVAL.exec(source)?.[1];
  if (literal === undefined) return undefined;
  if (literal === "null") return null;
  return { date: APPROVAL_FIELD("date").exec(literal)?.[1], approver: APPROVAL_FIELD("approver").exec(literal)?.[1] };
}

/** Parses the modes file; `liveWorlds` is undefined when any item is not a plain string literal. */
export function readModes(source: string): Modes {
  const email = EMAIL_LINE.exec(source)?.[1];
  const approval = readApproval(source);
  const list = LIVE_WORLDS.exec(source)?.[1];
  if (list === undefined) return { email, approval };
  const items = list.split(",").filter((item) => item.trim() !== "");
  const worlds = items.map((item) => STRING_ITEM.exec(item)?.[1]);
  return {
    email,
    liveWorlds: worlds.every((world): world is string => world !== undefined) ? worlds : undefined,
    approval,
  };
}

function isValidDate(date: string, today: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && date <= today;
}

/** `today` is an ISO date (AAAA-MM-DD); it defaults to the current UTC date. */
export function checkModes(modesSource: string, today = new Date().toISOString().slice(0, 10)): string[] {
  const errors: string[] = [];
  const { email, liveWorlds, approval } = readModes(modesSource);

  if (email !== "live") errors.push(`${MODES_FILE}: email must be "live" as a plain string literal on its own line.`);
  if (liveWorlds === undefined) {
    errors.push(`${MODES_FILE}: whatsapp.liveWorlds not found as a literal array of strings.`);
    return errors;
  }
  for (const world of liveWorlds) {
    if (!LIVE_WORLD_ALLOWED.test(world)) {
      errors.push(`${MODES_FILE}: world "${world}" can never run WhatsApp live; only "demo" and "qa-live-*" may (ADR-0002).`);
    }
  }
  if (liveWorlds.length === 0) return errors;

  const live = liveWorlds.join(", ");
  if (!approval) {
    errors.push(`${MODES_FILE}: WhatsApp is live in ${live} but whatsappLiveApproval is not set (it must be { date, approver }).`);
    return errors;
  }
  if (approval.date === undefined || !isValidDate(approval.date, today)) {
    errors.push(`${MODES_FILE}: WhatsApp is live in ${live} but whatsappLiveApproval.date must be an ISO date (AAAA-MM-DD) not in the future.`);
  }
  if (approval.approver === undefined || approval.approver.trim() === "") {
    errors.push(`${MODES_FILE}: WhatsApp is live in ${live} but whatsappLiveApproval.approver is empty.`);
  }
  return errors;
}

function main(): void {
  const modesSource = readFileSync(resolve(process.cwd(), MODES_FILE), "utf8");

  const errors = checkModes(modesSource);
  if (errors.length > 0) {
    console.error(`check-modes: ${errors.length} violation(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }

  const { liveWorlds = [] } = readModes(modesSource);
  console.log(`check-modes: ok (email=live, whatsapp live in ${liveWorlds.length === 0 ? "no world" : liveWorlds.join(", ")}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
