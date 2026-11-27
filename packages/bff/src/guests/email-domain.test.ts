// The email rules of the self-signup (docs/architecture-guests.md §4).
import { describe, expect, it } from "vitest";
import { isDisposableDomain } from "./disposable-domains";
import { canonicalEmail, checkEmail, checkEmailShape, normalizeEmail } from "./email-domain";

describe("email of a self-signup [FL-112]", () => {
  it("normalizes to lower case, trimmed", () => {
    expect(normalizeEmail("  Ana.Prospecto@Empresa-Ficticia.AR ")).toBe("ana.prospecto@empresa-ficticia.ar");
  });

  it.each(["ana", "ana@", "@empresa.ar", "ana..x@empresa.ar", "ana@empresa", "ana@-empresa.ar", "ana@empresa.a", "añá@empresa.ar", "ana@empresá.ar", "ana@empre\nsa.ar"])("refuses %j as INVALID_EMAIL", (email) => {
    expect(checkEmailShape(email)).toEqual({ ok: false, reason: "INVALID_EMAIL" });
  });

  it("refuses a qa- local part, reserved names, the SES simulator and the app's own zone", () => {
    for (const email of ["qa-x@empresa-ficticia.ar", "QA-run@empresa-ficticia.ar", "ana@example.com", "ana@corp.test", "ana@host.localhost", "success@simulator.amazonses.com", "x@reclamo.demo.craftech.io"]) {
      expect(checkEmailShape(email), email).toEqual({ ok: false, reason: "INVALID_EMAIL" });
    }
  });

  it("refuses a disposable domain, or a subdomain of one, as EMAIL_NOT_ACCEPTED", () => {
    expect(checkEmailShape("ana@yopmail.com")).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(checkEmailShape("ana@euploading.com")).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(isDisposableDomain("inbox.mailinator.com")).toBe(true);
    expect(isDisposableDomain("empresa-ficticia.ar")).toBe(false);
  });

  it("needs a domain that receives mail", async () => {
    const resolver = { inspect: async (domain: string) => ({ receives: domain !== "sin-correo.ar", exchangers: [] }) };
    expect(await checkEmail("ana@sin-correo.ar", resolver)).toEqual({ ok: false, reason: "INVALID_EMAIL" });
    expect(await checkEmail("ana@empresa-ficticia.ar", resolver)).toEqual({ ok: true, email: "ana@empresa-ficticia.ar", domain: "empresa-ficticia.ar" });
  });

  it("refuses a domain whose MX is a temporary-mail provider or a listed disposable domain, and keeps a privacy provider", async () => {
    const mx: Readonly<Record<string, readonly string[]>> = {
      "dominio-nuevo.ar": ["mx.smtp.is"],
      "alias-propio.ar": ["MAIL.mailinator.com."],
      "privado.ar": ["mail.protonmail.ch", "mailsec.protonmail.ch"],
      "proton.me": ["mail.protonmail.ch"],
    };
    const resolver = { inspect: async (domain: string) => ({ receives: true, exchangers: (mx[domain] ?? []).map((host) => host.toLowerCase().replace(/\.$/, "")) }) };
    expect(await checkEmail("ana@dominio-nuevo.ar", resolver)).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(await checkEmail("ana@alias-propio.ar", resolver)).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect((await checkEmail("ana@privado.ar", resolver)).ok).toBe(true);
    expect((await checkEmail("ana@proton.me", resolver)).ok).toBe(true);
  });

  it("counts the caps by the canonical address: no +tag, Gmail without dots", () => {
    expect(canonicalEmail("ana+demo@empresa-ficticia.ar")).toBe("ana@empresa-ficticia.ar");
    expect(canonicalEmail("a.n.a+x@googlemail.com")).toBe("ana@gmail.com");
    expect(canonicalEmail("a.na@empresa-ficticia.ar")).toBe("a.na@empresa-ficticia.ar");
  });
});
