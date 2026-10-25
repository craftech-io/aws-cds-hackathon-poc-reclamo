// `emails.*` (FL-093): the email viewer renders exactly what left, proves it with the SHA-256 of the
// `.eml` read now against the one recorded at send time, and shows only the principal's world.
import { beforeEach, describe, expect, it } from "vitest";
import { email } from "../connector/testing";
import { sha256Hex } from "../lib/crypto";
import { COMPLIANCE, type ConsoleRig, GUEST, OPERATOR, consoleRig, refusalOf } from "./testing";

const RAW = new TextEncoder().encode("From: x\r\nTo: success+demo-cus-0001@simulator.amazonses.com\r\nSubject: Reclamo R-2026-000123\r\n\r\nhola\r\n");
const RAW_KEY = "W/demo/2026-10-07/mail-0001.eml";
const RENDER_KEY = "W/demo/2026-10-07/mail-0001.json";
const PDF_KEY = "W/demo/complaints/cmp-0001/ACK-0123456789abcdef.pdf";

const VIEW = {
  mailId: "mail-0001",
  worldId: "demo",
  headers: { from: "Jarilla (ficticio) vía Reclamo en regla <respuestas@reclamo.demo.craftech.io>", toMasked: "s***@simulator.amazonses.com", subject: "Reclamo R-2026-000123 · Acuse de recibo", date: "2026-10-07T13:10:05.000Z" },
  text: "hola",
  html: "<p>hola</p>",
  attachments: [{ filename: "acuse-R-2026-000123.pdf", docKind: "ACK", sha256: "d".repeat(64), bytes: 1_234 }],
  rawSha256: sha256Hex(RAW),
};

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("demo");
  await rig.seedWorld("g03");
  await rig.connector.emails.put(
    email("demo", {
      s3RawKey: RAW_KEY,
      s3RenderKey: RENDER_KEY,
      rawSha256: sha256Hex(RAW),
      complaintId: "cmp-0001",
      attachments: [
        { docKind: "ACK", s3Key: PDF_KEY, sha256: "d".repeat(64) },
        { docKind: "ANSWER", s3Key: "W/g03/complaints/cmp-9/ANSWER-x.pdf", sha256: "e".repeat(64) },
      ],
      events: [{ type: "DELIVERY", atReal: "2026-10-07T13:10:07.000Z" }],
      deliveryProof: "DELIVERED",
      providerMessageId: "0100019a-test",
    }),
  );
  await rig.connector.emails.put(email("demo", { mailId: "mail-0002", sentAtSim: "2026-10-07T11:00:00-03:00", s3RawKey: "W/demo/2026-10-07/mail-0002.eml" }));
  await rig.connector.emails.put(email("g03", { mailId: "mail-g03", s3RawKey: "W/g03/2026-10-07/mail-g03.eml" }));
  rig.emailObjects.set(RAW_KEY, RAW);
  rig.emailObjects.set(RENDER_KEY, new TextEncoder().encode(JSON.stringify(VIEW)));
});

describe("emails.list [FL-093]", () => {
  it("[FL-093] lists the world's emails newest first with the masked recipient and the delivery proof", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const { emails } = await caller.emails.list();
    expect(emails.map((item) => item.mailId)).toEqual(["mail-0002", "mail-0001"]);
    expect(emails[1]).toMatchObject({ toMasked: "s***@simulator.amazonses.com", deliveryProof: "DELIVERED", attachments: 2, lastEvent: "DELIVERY", complaintId: "cmp-0001" });
    expect(JSON.stringify(emails)).not.toContain("success+");
  });

  it("[FL-093] shows a guest only the emails of their world", async () => {
    const { caller } = await rig.as(GUEST);
    expect((await caller.emails.list()).emails.map((item) => item.mailId)).toEqual(["mail-g03"]);
    expect(await refusalOf(() => caller.emails.get({ customerId: "cus-0001", mailId: "mail-0001" }))).toBe("EMAIL_NOT_FOUND");
  });
});

describe("emails.get [FL-093]", () => {
  it("[FL-093] renders the stored view and proves the .eml shown is the one sent (SHA-256)", async () => {
    const { caller } = await rig.as(OPERATOR);
    const detail = await caller.emails.get({ customerId: "cus-0001", mailId: "mail-0001" });
    expect(detail.view).toEqual(VIEW);
    expect(detail.events).toEqual([{ type: "DELIVERY", atReal: "2026-10-07T13:10:07.000Z" }]);
    expect(detail.integrity).toEqual({ sha256: sha256Hex(RAW), recorded: sha256Hex(RAW), matches: true, bytes: RAW.byteLength });
  });

  it("[FL-093] says so when the stored .eml is not the one recorded at send time", async () => {
    rig.emailObjects.set(RAW_KEY, new TextEncoder().encode("tampered"));
    const { caller } = await rig.as(OPERATOR);
    const detail = await caller.emails.get({ customerId: "cus-0001", mailId: "mail-0001" });
    expect(detail.integrity.matches).toBe(false);
    expect(detail.integrity.sha256).toBe(sha256Hex("tampered"));
  });

  it("answers without a view when the render is missing, never failing the viewer", async () => {
    const { caller } = await rig.as(OPERATOR);
    const detail = await caller.emails.get({ customerId: "cus-0001", mailId: "mail-0002" });
    expect(detail.view).toBeNull();
    expect(detail.integrity).toMatchObject({ sha256: null, matches: false });
  });
});

describe("emails.attachmentUrl [FL-093]", () => {
  it("[FL-093] signs a 5-minute GET of an attached PDF of the world, with its hash", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const link = await caller.emails.attachmentUrl({ customerId: "cus-0001", mailId: "mail-0001", index: 0 });
    expect(link).toMatchObject({ contentType: "application/pdf", sha256: "d".repeat(64), expiresInSeconds: 300 });
    expect(rig.documentUrls).toEqual([PDF_KEY]);
  });

  it("never signs a key outside the world's root nor an attachment that does not exist", async () => {
    const { caller } = await rig.as(OPERATOR);
    expect(await refusalOf(() => caller.emails.attachmentUrl({ customerId: "cus-0001", mailId: "mail-0001", index: 1 }))).toBe("ATTACHMENT_NOT_FOUND");
    expect(await refusalOf(() => caller.emails.attachmentUrl({ customerId: "cus-0001", mailId: "mail-0001", index: 5 }))).toBe("ATTACHMENT_NOT_FOUND");
    expect(rig.documentUrls).toEqual([]);
  });
});
