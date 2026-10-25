// No audit entry carries a username with `@` (docs/architecture-guests.md §3): the pre-token trigger
// never writes one, and the `AuditSink` contract masks any value with `@` whoever writes it.
import { describe, expect, it } from "vitest";
import { maskAuditRefs, maskingAuditSink } from "../auth/audit";
import { connectorAuditSink } from "../auth/directory";
import { createMemoryAudit } from "../auth/testing";
import { testConnector } from "../connector/testing";
import { createLogger } from "../lib/log";
import { auditRefs } from "./pre-token";

describe("audit refs without the email [FL-094] [FL-121]", () => {
  it("names the kind of username, the source and the staff id or sub, and the username only without @", () => {
    const base = { triggerSource: "TokenGeneration_Authentication", request: { userAttributes: { sub: "sub-1" } } };
    const signup = auditRefs({ ...base, userName: "ana@empresa-ficticia.ar" } as never, undefined);
    expect(signup).toEqual({ usernameKind: "SIGNUP", triggerSource: "TokenGeneration_Authentication", sub: "sub-1" });
    const staff = auditRefs({ ...base, userName: "operator-01" } as never, { worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", cognitoSubKey: "SUB#sub-1" });
    expect(staff).toEqual({ usernameKind: "STAFF", triggerSource: "TokenGeneration_Authentication", staffId: "stf-operator-01", username: "operator-01" });
    expect(auditRefs({ ...base, userName: "qa-r1-sc01-operator" } as never, undefined).usernameKind).toBe("QA");
  });

  it("masks every value with an email or a phone, and logs only that it did", async () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => void lines.push(line) });
    expect(maskAuditRefs({ who: "ana@empresa-ficticia.ar", phone: "+5491122334455", path: "inbox.list" }, log)).toEqual({ who: "[EMAIL]", phone: "[TELEFONO]", path: "inbox.list" });
    expect(lines.join("\n")).toContain("audit.refs_masked");
    expect(lines.join("\n")).not.toContain("empresa-ficticia");

    const memory = createMemoryAudit();
    await maskingAuditSink(memory).record({ worldId: "gs-abcdefgh23", epoch: 1, action: "DENY", outcome: "X", actor: "SYSTEM", refs: { username: "ana@empresa-ficticia.ar" } });
    expect(memory.entries[0]?.refs).toEqual({ username: "[EMAIL]" });
  });

  it("masks in the connector's sink too, so no writer stores an email", async () => {
    const { connector, store } = testConnector();
    await connectorAuditSink(connector.audit).record({ worldId: "gs-abcdefgh23", epoch: 1, action: "DENY", outcome: "X", actor: "SYSTEM", refs: { username: "ana@empresa-ficticia.ar" } });
    const page = await store.query({ table: "AuditLog", index: "ByAction", partition: "W#gs-abcdefgh23#DENY" });
    expect(JSON.stringify(page.items)).not.toContain("@");
  });
});
