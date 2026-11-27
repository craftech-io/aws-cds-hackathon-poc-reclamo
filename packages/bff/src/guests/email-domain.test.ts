// The email rules of the self-signup (docs/architecture-guests.md §4).
import { describe, expect, it } from "vitest";
import { DISPOSABLE_DOMAINS, DISPOSABLE_MAIL_SERVER_ADDRESSES, OWN_DISPOSABLE_DOMAINS, isDisposableDomain, isDisposableMailServerAddress } from "./disposable-domains";
import { type DnsLookups, type MailDomain, canonicalEmail, checkEmail, checkEmailShape, dnsMailDomainResolver, normalizeEmail } from "./email-domain";

const receives = (exchangers: readonly string[] = [], addresses?: readonly string[]): MailDomain => ({ status: "RECEIVES", exchangers, ...(addresses ? { addresses } : {}) });

/** A DNS failure with its code, as `node:dns` raises it. */
const dnsError = (code: string) => Object.assign(new Error(code), { code });

/** Lookups that answer from a table: a function per record type, `undefined` = no such record. */
function lookups(table: { readonly mx?: (name: string) => Promise<readonly { exchange: string }[]>; readonly a?: (name: string) => Promise<readonly unknown[]>; readonly aaaa?: (name: string) => Promise<readonly unknown[]> }): DnsLookups {
  const absent = () => Promise.reject(dnsError("ENODATA"));
  return { resolveMx: table.mx ?? absent, resolve4: table.a ?? absent, resolve6: table.aaaa ?? absent };
}

describe("email of a self-signup [FL-112]", () => {
  it("normalizes to lower case, trimmed", () => {
    expect(normalizeEmail("  Ana.Prospecto@Empresa-Ficticia.AR ")).toBe("ana.prospecto@empresa-ficticia.ar");
  });

  it.each(["ana", "ana@", "@empresa.ar", "ana..x@empresa.ar", "ana@empresa", "ana@-empresa.ar", "ana@empresa.a", "añá@empresa.ar", "ana@empresá.ar", "ana@empre\nsa.ar"])("refuses %j as INVALID_EMAIL", (email) => {
    expect(checkEmailShape(email)).toEqual({ ok: false, reason: "INVALID_EMAIL" });
  });

  it("refuses a qa- local part, the SES simulator and the app's own zone as INVALID_EMAIL", () => {
    for (const email of ["qa-x@empresa-ficticia.ar", "QA-run@empresa-ficticia.ar", "success@simulator.amazonses.com", "x@reclamo.demo.craftech.io", "ana@host.local"]) {
      expect(checkEmailShape(email), email).toEqual({ ok: false, reason: "INVALID_EMAIL" });
    }
  });

  it("refuses reserved and test domains like a disposable mailbox", () => {
    for (const email of ["ana@test.com", "ana@example.com", "ana@example.org", "ana@example.net", "ana@mail.example.com", "ana@corp.test", "ana@corp.example", "ana@corp.invalid", "ana@host.localhost"]) {
      expect(checkEmailShape(email), email).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    }
    expect(checkEmailShape("ana@contest.com").ok).toBe(true);
  });

  it("refuses the domains of the public list and of the repository's own, and keeps common providers", () => {
    expect(DISPOSABLE_DOMAINS.size).toBeGreaterThan(100_000);
    expect(checkEmailShape("ana@vomoto.com")).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(checkEmailShape("ana@10mail.org")).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    for (const domain of ["euploading.com", "10mail.org", "emltmp.com", "emlpro.com", "vomoto.com", "blondmail.com", "guerrillamailblock.com", "tempmail.lol", "1secmail.com"]) {
      expect(OWN_DISPOSABLE_DOMAINS.has(domain), domain).toBe(true);
      expect(checkEmailShape(`ana@${domain}`), domain).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    }
    for (const domain of ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com.ar", "icloud.com", "proton.me", "empresa-ficticia.ar"]) expect(isDisposableDomain(domain), domain).toBe(false);
  });

  it("refuses a disposable domain, or a subdomain of one, as EMAIL_NOT_ACCEPTED", () => {
    expect(checkEmailShape("ana@yopmail.com")).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(checkEmailShape("ana@euploading.com")).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(isDisposableDomain("inbox.mailinator.com")).toBe(true);
    expect(isDisposableDomain("empresa-ficticia.ar")).toBe(false);
  });

  it("refuses a domain with nowhere to receive mail like a disposable one, and lets one DNS cannot tell about go on", async () => {
    const answers: Readonly<Record<string, MailDomain>> = { "sin-correo.ar": { status: "NO_MAIL" }, "dns-caido.ar": { status: "UNKNOWN" } };
    const resolver = { inspect: async (domain: string) => answers[domain] ?? receives() };
    expect(await checkEmail("ana@sin-correo.ar", resolver)).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(await checkEmail("ana@dns-caido.ar", resolver)).toEqual({ ok: true, email: "ana@dns-caido.ar", domain: "dns-caido.ar" });
    expect(await checkEmail("ana@empresa-ficticia.ar", resolver)).toEqual({ ok: true, email: "ana@empresa-ficticia.ar", domain: "empresa-ficticia.ar" });
  });

  it("refuses a domain whose MX is a temporary-mail provider or a listed disposable domain, and keeps a privacy provider", async () => {
    const mx: Readonly<Record<string, readonly string[]>> = {
      "dominio-nuevo.ar": ["mx.smtp.is"],
      "alias-propio.ar": ["MAIL.mailinator.com."],
      "privado.ar": ["mail.protonmail.ch", "mailsec.protonmail.ch"],
      "proton.me": ["mail.protonmail.ch"],
    };
    const resolver = { inspect: async (domain: string) => receives((mx[domain] ?? []).map((host) => host.toLowerCase().replace(/\.$/, ""))) };
    expect(await checkEmail("ana@dominio-nuevo.ar", resolver)).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect(await checkEmail("ana@alias-propio.ar", resolver)).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    expect((await checkEmail("ana@privado.ar", resolver)).ok).toBe(true);
    expect((await checkEmail("ana@proton.me", resolver)).ok).toBe(true);
  });

  it("reads DNS: MX hosts, an implicit MX, a domain that does not exist, a null MX, no records", async () => {
    const inspect = (table: Parameters<typeof lookups>[0]) => dnsMailDomainResolver({ lookups: lookups(table) }).inspect("dominio.ar");
    expect(await inspect({ mx: async () => [{ exchange: "MX1.Smtp.IS." }] })).toEqual(receives(["mx1.smtp.is"], []));
    expect(await inspect({ a: async () => ["192.0.2.10"] })).toEqual(receives([], ["192.0.2.10"]));
    expect(await inspect({ aaaa: async () => ["2001:db8::1"] })).toEqual(receives([], ["2001:db8::1"]));
    const nxdomain = () => Promise.reject(dnsError("ENOTFOUND"));
    expect(await inspect({ mx: nxdomain, a: nxdomain, aaaa: nxdomain })).toEqual({ status: "NO_MAIL" });
    expect(await inspect({ mx: async () => [{ exchange: "" }] })).toEqual({ status: "NO_MAIL" });
    expect(await inspect({})).toEqual({ status: "NO_MAIL" });
  });

  it("DNS down, failing or slow is UNKNOWN within the 2 s budget, never a refusal", async () => {
    const fail = (code: string) => () => Promise.reject(dnsError(code));
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED"]) {
      expect(await dnsMailDomainResolver({ lookups: lookups({ mx: fail(code) }) }).inspect("dominio.ar"), code).toEqual({ status: "UNKNOWN" });
    }
    expect(await dnsMailDomainResolver({ lookups: lookups({ a: fail("ESERVFAIL") }) }).inspect("dominio.ar")).toEqual({ status: "UNKNOWN" });
    const never = () => new Promise<never>(() => undefined);
    const started = performance.now();
    expect(await dnsMailDomainResolver({ timeoutMs: 50, lookups: lookups({ mx: never }) }).inspect("dominio.ar")).toEqual({ status: "UNKNOWN" });
    expect(performance.now() - started).toBeLessThan(1_000);
    const resolver = { inspect: async () => ({ status: "UNKNOWN" }) as const };
    expect((await checkEmail("ana@dominio.ar", resolver)).ok).toBe(true);
  });

  it("refuses a new domain whose mail server is at the address of a temporary-mail service (servidor_descartable), whatever its name", async () => {
    const mx: Readonly<Record<string, string>> = { "nombre-nuevo-de-hoy.com": "mx.nombre-nuevo-de-hoy.com", "empresa-ficticia.ar": "mail.empresa-ficticia.ar" };
    const a: Readonly<Record<string, readonly string[]>> = { "mx.nombre-nuevo-de-hoy.com": ["78.47.124.133"], "mail.empresa-ficticia.ar": ["192.0.2.25"] };
    const resolver = dnsMailDomainResolver({
      lookups: lookups({
        mx: async (name) => (mx[name] ? [{ exchange: `${mx[name]}.` }] : Promise.reject(dnsError("ENOTFOUND"))),
        a: async (name) => a[name] ?? Promise.reject(dnsError("ENODATA")),
      }),
    });
    expect(await checkEmail("ana@nombre-nuevo-de-hoy.com", resolver)).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED", cause: "DISPOSABLE_MAIL_SERVER" });
    expect((await checkEmail("ana@empresa-ficticia.ar", resolver)).ok).toBe(true);
    // Without MX, the domain itself is the mail server (implicit MX).
    const implicit = dnsMailDomainResolver({ lookups: lookups({ a: async () => ["178.32.61.35"] }) });
    expect(await checkEmail("ana@sin-mx-nuevo.com", implicit)).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED", cause: "DISPOSABLE_MAIL_SERVER" });
  });

  it("lets the address go on when the address of its mail server fails to resolve or comes too late", async () => {
    const mxOnly = { mx: async () => [{ exchange: "mx.otro-nuevo.com." }] };
    const failing = dnsMailDomainResolver({ lookups: lookups({ ...mxOnly, a: () => Promise.reject(dnsError("ESERVFAIL")), aaaa: () => Promise.reject(dnsError("ETIMEOUT")) }) });
    expect(await checkEmail("ana@otro-nuevo.com", failing)).toEqual({ ok: true, email: "ana@otro-nuevo.com", domain: "otro-nuevo.com" });
    const slow = dnsMailDomainResolver({ timeoutMs: 50, lookups: lookups({ ...mxOnly, a: () => new Promise<never>(() => undefined), aaaa: () => new Promise<never>(() => undefined) }) });
    expect(await slow.inspect("otro-nuevo.com")).toEqual(receives(["mx.otro-nuevo.com"], []));
    expect((await checkEmail("ana@otro-nuevo.com", slow)).ok).toBe(true);
  });

  it("keeps one list of the temporary-mail servers' addresses, next to the repository's own domains, which now has today's six", () => {
    expect([...DISPOSABLE_MAIL_SERVER_ADDRESSES.keys()]).toEqual(["78.47.124.133", "94.130.108.80", "49.12.18.190", "15.204.213.223", "178.162.170.166", "178.32.61.35"]);
    for (const description of DISPOSABLE_MAIL_SERVER_ADDRESSES.values()) expect(description.length).toBeGreaterThan(0);
    expect(isDisposableMailServerAddress("192.0.2.25")).toBe(false);
    for (const domain of ["mailpwr.com", "mimimail.me", "pickmail.org", "freeml.net", "mailtowin.com", "maximail.vip"]) {
      expect(OWN_DISPOSABLE_DOMAINS.has(domain), domain).toBe(true);
      expect(checkEmailShape(`ana@${domain}`), domain).toEqual({ ok: false, reason: "EMAIL_NOT_ACCEPTED" });
    }
  });

  it("counts the caps by the canonical address: no +tag, Gmail without dots", () => {
    expect(canonicalEmail("ana+demo@empresa-ficticia.ar")).toBe("ana@empresa-ficticia.ar");
    expect(canonicalEmail("a.n.a+x@googlemail.com")).toBe("ana@gmail.com");
    expect(canonicalEmail("a.na@empresa-ficticia.ar")).toBe("a.na@empresa-ficticia.ar");
  });
});
