import { describe, expect, it } from "vitest";
import { attachmentIndexes, attachmentName, type EmailDetail, integrityVerdict, kindText, proofText, proofTone, realText, refOf, sentText } from "./emails-model";

const view: NonNullable<EmailDetail["view"]> = {
  mailId: "mail-1",
  worldId: "g04",
  headers: { from: "Jarilla (ficticio) vía Reclamo en regla <respuestas@example.test>", toMasked: "s***@simulator.amazonses.com", subject: "Aviso", date: "2026-10-07T13:10:00.000Z" },
  text: "Hola",
  html: "<p>Hola</p>",
  attachments: [{ filename: "jarilla-collection-notice.pdf", docKind: "COLLECTION_NOTICE", sha256: "bf".repeat(32), bytes: 3016 }],
  rawSha256: "6c".repeat(32),
};

describe("email viewer: exact render [FL-093]", () => {
  it("says the stored .eml matches only when its SHA-256 equals the one recorded at send time", () => {
    expect(integrityVerdict({ sha256: "6c".repeat(32), recorded: "6c".repeat(32), matches: true, bytes: 7603 })).toBe("matches");
    expect(integrityVerdict({ sha256: "6c".repeat(32), recorded: "aa".repeat(32), matches: false, bytes: 7603 })).toBe("differs");
    expect(integrityVerdict({ sha256: null, recorded: "aa".repeat(32), matches: false, bytes: null })).toBe("missing");
  });

  it("saves an attachment under the name it was sent with, or a fixed one by position", () => {
    expect(attachmentName({ view }, 0)).toBe("jarilla-collection-notice.pdf");
    expect(attachmentName({ view: null }, 1)).toBe("adjunto-2.pdf");
    expect(attachmentIndexes({ view, attachments: 1 })).toEqual([0]);
    expect(attachmentIndexes({ view: null, attachments: 2 })).toEqual([0, 1]);
  });

  it("names the kind, the proof and the simulated time in words", () => {
    expect(kindText("COLLECTION_NOTICE_EMAIL")).not.toMatch(/_/);
    expect(proofText("DELIVERED")).toBe("Entregado");
    expect(proofText(null)).toBe("—");
    expect(proofTone("BOUNCED")).toBe("danger");
    expect(proofTone("SENT")).toBe("info");
    expect(sentText({ sentAtSim: "2026-10-07T13:10:00.000Z" })).toBe("mié 07/10 10:10");
    expect(refOf({ customerId: "cus-0009", mailId: "mail-1" })).toEqual({ customerId: "cus-0009", mailId: "mail-1" });
  });

  it("names the real clock of an SES event, so a delivery is never read on the world's simulated time", () => {
    expect(realText("2026-10-09T21:12:00.000Z")).toBe("vie 09/10 18:12 · hora real");
    expect(realText("2026-10-09T21:12:00.000Z")).not.toBe(sentText({ sentAtSim: "2026-10-09T21:12:00.000Z" }));
  });
});
