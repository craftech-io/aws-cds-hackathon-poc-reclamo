import { describe, expect, it } from "vitest";
import { healthVerdict, mxProblems, rootProblems } from "./interim";

const SECURE = {
  "content-security-policy": "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

describe("interim smoke", () => {
  it("accepts the console root with every security header", () => {
    expect(rootProblems(200, SECURE)).toEqual([]);
  });

  it("names each missing header and a non-200 root", () => {
    expect(rootProblems(403, {})).toEqual([
      "GET / answered 403",
      "GET / has no strict Content-Security-Policy",
      "GET / has no Strict-Transport-Security",
      "GET / has no X-Frame-Options DENY",
      "GET / has no X-Content-Type-Options nosniff",
    ]);
    expect(rootProblems(200, { ...SECURE, "x-frame-options": "SAMEORIGIN" })).toEqual(["GET / has no X-Frame-Options DENY"]);
  });

  it("tells the BFF health probe from the console's fallback page", () => {
    expect(healthVerdict(200, "application/json", JSON.stringify({ result: { data: { ok: true, service: "bff" } } }))).toBe("ok");
    expect(healthVerdict(200, "text/html; charset=utf-8", "<!doctype html>")).toBe("not-deployed");
    expect(healthVerdict(503, "application/json", "{}")).toBe("failed");
    expect(healthVerdict(200, "application/json", "not json")).toBe("failed");
    expect(healthVerdict(200, "application/json", JSON.stringify({ result: { data: { ok: false } } }))).toBe("failed");
  });

  it("fails when the app domain has an MX record (email is outbound only)", () => {
    expect(mxProblems([])).toEqual([]);
    expect(mxProblems([{ exchange: "inbound-smtp.us-east-1.amazonaws.com" }])).toEqual(["MX of the app domain must be empty, found inbound-smtp.us-east-1.amazonaws.com"]);
  });
});
