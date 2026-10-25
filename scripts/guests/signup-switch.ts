// The switch of the self-signup (docs/architecture-guests.md §7, docs/landing-spec.md §9.9). The
// sign-up is open (ADR-0021): `seed:load` writes SWITCH#SIGNUP open when absent, an absent row reads
// closed, and only the operator or KILL#SIGNUP closes it:
//
//   npm run guests:signup-switch -- --on       opens it (SWITCH#SIGNUP open) and lifts KILL#SIGNUP
//   npm run guests:signup-switch -- --off      closes it (SWITCH#SIGNUP closed)
//   npm run guests:signup-switch -- --check    prints the state, writes nothing
//
// Every change is audited (`SIGNUP_SWITCHED`). `KILL#SIGNUP` is also set by the budget and the SES
// reputation alarms; `--on` after reviewing them is how it is lifted.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoStore } from "../../packages/bff/src/connector/dynamo/engine";
import type { TableStore } from "../../packages/bff/src/connector/store";
import { signupKilled } from "../../packages/bff/src/guests/caps";
import { signupRuntimeKeys } from "../../packages/bff/src/leads/keys";
import { edgeAuditOp } from "../../packages/bff/src/leads/repo";
import { ulid } from "../../packages/bff/src/lib/crypto";
import { parseFlags } from "../channels/cli-args";

export type SwitchAction = "on" | "off" | "check";

export function parseSwitchArgs(argv: readonly string[]): SwitchAction {
  const actions: SwitchAction[] = [];
  parseFlags(argv, { "--on": () => void actions.push("on"), "--off": () => void actions.push("off"), "--check": () => void actions.push("check") });
  if (actions.length !== 1 || !actions[0]) throw new RangeError("pass exactly one of --on, --off or --check");
  return actions[0];
}

export interface SwitchState {
  readonly open: boolean;
  readonly killed: boolean;
}

export async function readSwitch(store: TableStore): Promise<SwitchState> {
  const [gate, kill] = await Promise.all([store.get("Runtime", signupRuntimeKeys.switch(), { consistent: true }), store.get("Runtime", signupRuntimeKeys.kill(), { consistent: true })]);
  return { open: gate?.open === true, killed: signupKilled(kill) };
}

export async function applySwitch(action: SwitchAction, store: TableStore, now: () => Date = () => new Date()): Promise<SwitchState> {
  if (action === "check") return readSwitch(store);
  const at = now();
  const open = action === "on";
  await store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.switch(), entity: "SignupSwitch", open, changedAtReal: at.toISOString() } });
  if (open) await store.write({ kind: "delete", table: "Runtime", key: signupRuntimeKeys.kill() });
  await store.write(edgeAuditOp({ action: "SIGNUP_SWITCHED", outcome: open ? "OPEN" : "CLOSED", refs: { by: "operator" } }, ulid(at.getTime()), at));
  return readSwitch(store);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const state = await applySwitch(parseSwitchArgs(process.argv.slice(2)), new DynamoStore());
    console.log(`guests:signup-switch: sign-up ${state.open && !state.killed ? "OPEN" : "CLOSED"} (switch ${state.open ? "on" : "off"}, kill ${state.killed ? "on" : "off"}).`);
  } catch (error) {
    console.error(`guests:signup-switch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
