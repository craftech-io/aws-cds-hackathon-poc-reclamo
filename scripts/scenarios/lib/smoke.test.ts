import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { publicAnswerOf } from "./edge";
import { QA_ACTIONS } from "@reclamo/bff/qa-driver/contract";
import { availabilityProblem, guestTemplateComplaints, reservedSignup } from "./smoke";
import { pageProblems, trpcData } from "./site";
import { pngChunk, uniqueReceipt, withTextChunk } from "./upload";
import { checkEmailShape } from "@reclamo/bff/guests/email-domain";

const SECURE = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

describe("SMK/10: what the edge answered, told apart from what the Bff answered [FL-119] [FL-122]", () => {
  it("a 403 that is not JSON, or a 202 challenge, is the edge refusing", () => {
    expect(publicAnswerOf(403, "text/html", undefined, "<html>")).toEqual({ status: 403, edgeRefused: true });
    expect(publicAnswerOf(202, "text/html", "challenge", "")).toEqual({ status: 202, edgeRefused: true });
    expect(publicAnswerOf(200, "application/json", undefined, JSON.stringify({ result: { data: { status: "INVALID_EMAIL" } } }))).toEqual({ status: 200, edgeRefused: false, result: "INVALID_EMAIL" });
    expect(publicAnswerOf(403, "application/json", undefined, JSON.stringify({ error: { reason: "EDGE_REQUIRED" } }))).toEqual({ status: 403, edgeRefused: false });
  });

  it("tells a WAF block of the runner's GET signup.availability apart from a closed signup", () => {
    const json = { "content-type": "application/json" };
    expect(availabilityProblem({ status: 200, headers: json, body: JSON.stringify({ result: { data: { status: "open" } } }) })).toBeUndefined();
    expect(availabilityProblem({ status: 200, headers: json, body: JSON.stringify({ result: { data: { status: "closed" } } }) })).toContain("is closed, expected open");
    const blocked = availabilityProblem({ status: 403, headers: { "content-type": "text/html" }, body: "<html>403 ERROR</html>" });
    expect(blocked).toContain("the edge web ACL refused GET signup.availability");
    expect(blocked).not.toContain("unanswered");
  });

  it("never reads the user pool through the QA driver: a self-signup's username is the lead's email", () => {
    expect(QA_ACTIONS).not.toContain("probe.staffEmails");
  });

  it("the smoke's sign-up uses a reserved domain the service refuses before creating anything", () => {
    const input = reservedSignup("812-1");
    expect(checkEmailShape(input.email)).toEqual({ ok: false, reason: "INVALID_EMAIL" });
    expect(input.acceptTerms && !input.acceptContact).toBe(true);
    expect(input.password.length).toBeGreaterThanOrEqual(12);
  });
});

describe("SMK/1-2: pages and the BFF from outside [FL-102] [FL-094]", () => {
  it("names the page whose headers are missing", () => {
    expect(pageProblems("/legal/terms.html", { status: 200, headers: SECURE, body: "" })).toEqual([]);
    expect(pageProblems("/legal/terms.html", { status: 200, headers: { ...SECURE, "x-frame-options": "" }, body: "" })).toEqual(["GET /legal/terms.html has no X-Frame-Options DENY"]);
  });

  it("reads the data of a tRPC answer, and nothing from HTML", () => {
    expect(trpcData({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ result: { data: { worldId: "qa-812-1-smk" } } }) })).toEqual({ worldId: "qa-812-1-smk" });
    expect(trpcData({ status: 200, headers: { "content-type": "text/html" }, body: "<html>" })).toBeUndefined();
  });
});

describe("SMK/9: the template a reset restores [FL-100]", () => {
  it("reads the seeded complaints of the guest template from the seed manifest", () => {
    expect(guestTemplateComplaints()).toBe(122);
  });
});

describe("SC-03/10: an upload that is not a seed copy [FL-101]", () => {
  it("adds a valid tEXt chunk before IEND: same pixels, another hash", () => {
    const seed = uniqueReceipt("legible", "C04", "812-1");
    const again = uniqueReceipt("legible", "C04", "813-1");
    expect(seed.equals(again)).toBe(false);
    expect(seed.includes(Buffer.from("tEXtComment\0qa upload 812-1", "latin1"))).toBe(true);
    expect(seed.subarray(-12).toString("hex")).toBe("0000000049454e44ae426082");
    const idat = (png: Buffer) => {
      const parts: Buffer[] = [];
      for (let at = 8; at < png.length; ) {
        const length = png.readUInt32BE(at);
        if (png.subarray(at + 4, at + 8).toString("latin1") === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
        at += 12 + length;
      }
      return inflateSync(Buffer.concat(parts));
    };
    const base = withTextChunk(seed, "x", "y");
    expect(idat(base).equals(idat(seed))).toBe(true);
  });

  it("writes the chunk with its CRC-32", () => {
    expect(pngChunk("IEND", Buffer.alloc(0)).toString("hex")).toBe("0000000049454e44ae426082");
    expect(() => withTextChunk(Buffer.from("not a png"), "a", "b")).toThrow(TypeError);
  });
});
