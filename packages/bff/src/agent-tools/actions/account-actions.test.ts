import { describe, expect, it } from "vitest";
import { gatewayContext } from "../common/principal";
import { WORLD } from "../common/testing";
import { ANSWER_CLAIM_SOURCE } from "../identity/customer-answer";
import { extractNewValue, looksLikeAddress } from "./data-change-value";
import { createActionsTarget } from "./handler";
import { effectWorld } from "./testing";

async function dataChangeWorld(accountStatus: "ACTIVE" | "BLOCKED" = "ACTIVE", inboundMessageId?: string) {
  const world = await effectWorld([{ customerId: "cus-0001", accountStatus }]);
  const target = createActionsTarget(world.deps, { core: () => world.core.client, networks: () => world.networks.client, complaints: world.complaintsDeps });
  const complaint = await world.addComplaint({ type: "DATA_CHANGE" });
  await world.connector.conversations.putMessage({
    worldId: WORLD,
    customerId: "cus-0001",
    messageId: "wamid-in-1",
    direction: "IN",
    channel: "WHATSAPP",
    body: "Quiero cambiar mi email a success+qa-dc@simulator.amazonses.com por favor",
    status: "RECEIVED",
    simulated: true,
    atSim: "2026-10-07T10:05:00-03:00",
    flags: {},
  });
  const inbound = (messageId: string, body: string, atSim: string) =>
    world.connector.conversations.putMessage({ worldId: WORLD, customerId: "cus-0001", messageId, direction: "IN", channel: "WHATSAPP", body, status: "RECEIVED", simulated: true, atSim, flags: {} });
  await inbound("wamid-in-addr", "Mi nuevo domicilio es Calle de los Tilos 220, Ciudad Ficticia", "2026-10-07T10:11:00-03:00");
  await inbound("wamid-in-answer", "12/9", "2026-10-07T10:12:00-03:00");
  await world.connector.conversations.putMessage({ worldId: WORLD, customerId: "cus-0001", messageId: "wamid-out-1", direction: "OUT", channel: "WHATSAPP", body: "Hola", status: "SENT", simulated: true, atSim: "2026-10-07T10:06:00-03:00", flags: {} });
  const turn = await world.openTurn({ complaintIds: [complaint.complaintId], ...(inboundMessageId === undefined ? {} : { inboundMessageId }) });
  await world.identify();
  const call = (input: Record<string, unknown>) => target.handle({ sessionToken: turn.token, ...input }, gatewayContext("actions___request_data_change"));
  return { world, complaint, turn, call, target };
}

describe("request_data_change", () => {
  it("an email change is registered PENDING_CONFIRMATION with the value code extracted, confirmation to the address on file", async () => {
    const { world, complaint, call } = await dataChangeWorld();
    const answer = await call({ field: "EMAIL", sourceMessageId: "wamid-in-1" });
    expect(answer).toMatchObject({ ok: true, status: "PENDING_CONFIRMATION" });
    expect(JSON.stringify(answer)).not.toContain("success+qa-dc");
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([expect.objectContaining({ kind: "DATA_CHANGE", status: "PENDING_CONFIRMATION" })]);
    const audit = (await world.auditRows()).find((row) => row.action === "DATA_CHANGE");
    expect(audit).toMatchObject({ outcome: "PENDING_CONFIRMATION", detail: { field: "EMAIL", valueExtracted: true } });
    expect(JSON.stringify(audit)).not.toContain("simulator.amazonses.com");
  });

  it("a phone change, or any change on an account under review, is REFERRED and the complaint goes to a person by code", async () => {
    for (const [field, status, source] of [["PHONE", "ACTIVE", "wamid-in-1"], ["ADDRESS", "BLOCKED", "wamid-in-addr"]] as const) {
      const { world, complaint, call } = await dataChangeWorld(status);
      expect(await call({ field, sourceMessageId: source })).toMatchObject({ ok: true, status: "REFERRED" });
      const after = await world.connector.complaints.get(WORLD, complaint.complaintId);
      expect(after).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RISKY_DATA_CHANGE" } });
      const register = await world.connector.chains.listRegisterByComplaint(WORLD, 1, complaint.complaintNumber);
      expect(register.map((entry) => entry.reason)).toContain("HANDOFF_RISKY_DATA_CHANGE");
    }
  });

  it("[FL-054] [FL-055] without sourceMessageId the value is read from the customer's message of the turn; a phone needs no message at all", async () => {
    const withTurnMessage = await dataChangeWorld("ACTIVE", "wamid-in-1");
    expect(await withTurnMessage.call({ field: "EMAIL" })).toMatchObject({ ok: true, status: "PENDING_CONFIRMATION" });
    expect((await withTurnMessage.world.auditRows()).find((row) => row.action === "DATA_CHANGE")).toMatchObject({ detail: { field: "EMAIL", valueExtracted: true } });
    const bare = await dataChangeWorld();
    expect(await bare.call({ field: "ADDRESS" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "NO_SOURCE_MESSAGE" } });
    expect(await bare.call({ field: "PHONE" })).toMatchObject({ ok: true, status: "REFERRED" });
    expect(await bare.world.connector.complaints.get(WORLD, bare.complaint.complaintId)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RISKY_DATA_CHANGE" } });
  });

  it("[FL-054] a reply to the identity challenge is never the new address: the code reads the customer's earlier message of the complaint", async () => {
    const { world, complaint, call } = await dataChangeWorld("ACTIVE", "wamid-in-answer");
    await world.connector.claims.claimOnce(WORLD, ANSWER_CLAIM_SOURCE, "wamid-in-answer");
    const answer = await call({ field: "ADDRESS" });
    expect(answer).toMatchObject({ ok: true, status: "PENDING_CONFIRMATION" });
    expect(await call({ field: "ADDRESS", sourceMessageId: "wamid-in-addr" })).toMatchObject({ ok: true, alreadyRequested: true, actionId: (answer as { actionId?: string }).actionId });
    expect((await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).map((action) => [action.kind, action.status])).toEqual([["DATA_CHANGE", "PENDING_CONFIRMATION"]]);
    expect((await world.auditRows()).filter((row) => row.action === "DATA_CHANGE").map((row) => row.outcome).sort()).toEqual(["ALREADY_PENDING", "PENDING_CONFIRMATION"]);
  });

  it("[FL-054] a message without an address, a named challenge answer or a date gives NO_NEW_VALUE and registers nothing", async () => {
    const named = await dataChangeWorld();
    await named.world.connector.claims.claimOnce(WORLD, ANSWER_CLAIM_SOURCE, "wamid-in-answer");
    expect(await named.call({ field: "ADDRESS", sourceMessageId: "wamid-in-answer" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "NO_NEW_VALUE" } });
    expect(await named.call({ field: "EMAIL", sourceMessageId: "wamid-in-addr" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "NO_NEW_VALUE" } });
    expect(await named.world.connector.caseItems.listActions(WORLD, named.complaint.complaintId)).toEqual([]);
  });

  it("the source message must be one the customer sent (never the agent's own, never another customer's)", async () => {
    const { call } = await dataChangeWorld();
    expect(await call({ field: "ADDRESS", sourceMessageId: "wamid-out-1" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await call({ field: "ADDRESS", sourceMessageId: "wamid-unknown" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("extracts the value by code: the first email, the address text bounded, nothing for a phone", () => {
    expect(extractNewValue("EMAIL", "mi nuevo mail es success+qa-x@simulator.amazonses.com, gracias")).toBe("success+qa-x@simulator.amazonses.com");
    expect(extractNewValue("EMAIL", "mi nuevo mail es [EMAIL]")).toBeUndefined();
    expect(extractNewValue("ADDRESS", "  Calle Falsa   123,\n piso 2 ")).toBe("Calle Falsa 123, piso 2");
    expect(extractNewValue("ADDRESS", `Avenida ${"x".repeat(300)} 1450`)).toHaveLength(200);
    for (const notAddress of ["12/9", "12/09/1985", "  ", "Me mudé y quiero cambiar el domicilio", "1985", "nací el 12 de septiembre de 1985"]) expect(extractNewValue("ADDRESS", notAddress), notAddress).toBeUndefined();
    expect(looksLikeAddress("Pasaje Los Ceibos s/n, Villa Ficticia")).toBe(true);
    expect(extractNewValue("PHONE", "+54 9 11 5555 0000")).toBeUndefined();
  });
});

describe("the fences of the actions target", () => {
  it("NOT_IDENTIFIED before the challenge and CONTROL_OPERATOR after a take-over: nothing reaches the core", async () => {
    const world = await effectWorld([{ customerId: "cus-0001" }]);
    const target = createActionsTarget(world.deps, { core: () => world.core.client, networks: () => world.networks.client, complaints: world.complaintsDeps });
    const complaint = await world.addComplaint({ type: "UNKNOWN_OPERATION" });
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    const freeze = () => target.handle({ sessionToken: turn.token, reason: "UNKNOWN_OPERATION" }, gatewayContext("actions___freeze_outgoing"));
    expect(await freeze()).toMatchObject({ ok: false, error: { code: "NOT_IDENTIFIED" } });
    await world.identify();
    await world.takeOver();
    expect(await freeze()).toMatchObject({ ok: false, error: { code: "CONTROL_OPERATOR" } });
    expect(await world.connector.caseItems.listActions(WORLD, complaint.complaintId)).toEqual([]);
  });
});
