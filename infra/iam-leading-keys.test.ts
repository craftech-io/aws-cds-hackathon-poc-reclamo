// The QaDriver's leading-key fence against every key SC-24 touches when it runs the sign-up service in
// process (`guest.signup`, `guest.confirm`, `guest.session`, the edge audit of a QA refusal and
// `notice.probe`), built with the BFF's own key functions and evaluated against the table statements the
// role actually gets (`dataPlan`, the IAM `StringLike` of each statement). A visitor's partitions stay out.
import { describe, expect, it } from "vitest";
import { keys } from "../packages/bff/src/connector/keys";
import { signupAuditPartition, signupRuntimeKeys } from "../packages/bff/src/leads/keys";
import { QA_GUEST_CAP_KEY } from "../packages/bff/src/worlds/meta";
import { WORLD_LEADING_KEYS, stringLike, type Access, type TableName } from "./iam-capabilities";
import { leadingKeyFits } from "./storage-keys";
import { dataPlan } from "./workers-spec";

type Mode = "read" | "write" | "append";
const AT = new Date("2026-10-10T13:10:00.000Z");
const QA_WORLD = "qa-4815162342-1-su1";

/** Whether a grant of `access` serves a request of `mode` (a write grant reads too; append only puts). */
function serves(access: Access, mode: Mode): boolean {
  if (mode === "read") return access === "read" || access === "write";
  if (mode === "append") return access === "append" || access === "write";
  return access === "write";
}

/** What the QaDriver's statements decide for one key of one table. */
function qaDriverAllows(table: TableName, key: string, mode: Mode): boolean {
  return dataPlan("QaDriver").tables.some((grant) => grant.table === table && serves(grant.access, mode) && (grant.leadingKeys ?? []).some((pattern) => stringLike(pattern, key)));
}

/** Every key the runner's sign-up reaches outside `Leads` (LEADS_GRANTS fences that table on its own). */
const QA_SIGNUP_KEYS: ReadonlyArray<readonly [TableName, string, Mode]> = [
  // guest.signup → signupService.start → caps.signupOpen, then the QA buckets.
  ["Runtime", signupRuntimeKeys.switch().pk, "read"],
  ["Runtime", signupRuntimeKeys.kill().pk, "read"],
  ["Runtime", signupRuntimeKeys.qaHour(AT).pk, "write"],
  ["Runtime", signupRuntimeKeys.qaDay(AT).pk, "write"],
  // A QA refusal, and `notice.probe`, audited in the runner's own partition of the edge.
  ["AuditLog", signupAuditPartition(AT, true), "append"],
  // guest.confirm → registerSignup and the world's capacity: META, the GUEST row, the ticket, the audit.
  ["Worlds", keys.worldMeta(QA_WORLD).pk, "write"],
  ["Worlds", keys.staff(QA_WORLD, `stf-${QA_WORLD}`).pk, "write"],
  ["Runtime", keys.runtime(QA_WORLD, "PROVISIONREQ", "01K7TICKET").pk, "write"],
  ["Runtime", QA_GUEST_CAP_KEY.pk, "write"],
  ["AuditLog", keys.auditPartition(QA_WORLD, 1, "2026-10"), "append"],
];

describe("the QaDriver's fence for SC-24's sign-up (docs/architecture-guests.md §12) [FL-112] [FL-113]", () => {
  it("reaches every key guest.signup, guest.confirm and guest.session touch for a QA scope", () => {
    for (const [table, key, mode] of QA_SIGNUP_KEYS) expect(qaDriverAllows(table, key, mode), `${mode} ${table} ${key}`).toBe(true);
  });

  it("only reads the switch and the kill, on Runtime alone", () => {
    for (const key of ["SWITCH#SIGNUP", "KILL#SIGNUP"]) {
      expect(qaDriverAllows("Runtime", key, "write"), key).toBe(false);
      expect(leadingKeyFits("Runtime", key), key).toBe(true);
      expect(dataPlan("QaDriver").tables.filter((grant) => grant.leadingKeys?.includes(key)).map((grant) => [grant.table, grant.access])).toEqual([["Runtime", "read"]]);
    }
    expect(WORLD_LEADING_KEYS.QaDriver.readOnly).toEqual(["W#gprobe#*", "SWITCH#SIGNUP", "KILL#SIGNUP"]);
  });

  it("never reaches a visitor's sign-up partitions, caps or worlds", () => {
    const visitor: ReadonlyArray<readonly [TableName, string, Mode]> = [
      ["AuditLog", signupAuditPartition(AT), "append"],
      ["Runtime", signupRuntimeKeys.globalDay(AT).pk, "write"],
      ["Runtime", signupRuntimeKeys.authMailHour(AT).pk, "write"],
      ["Runtime", signupRuntimeKeys.ipDay("abcdef0123456789", AT).pk, "write"],
      ["Runtime", "GUESTCAP#ACTIVE", "write"],
      ["Worlds", keys.worldMeta("gs-abcdefghij").pk, "read"],
    ];
    for (const [table, key, mode] of visitor) expect(qaDriverAllows(table, key, mode), `${mode} ${table} ${key}`).toBe(false);
  });
});
