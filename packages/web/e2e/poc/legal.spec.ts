// FL-127 on the deployed stage · the legal pages (ADR-0021 §3, the CTO's decision of 2026-10-06): the
// controller is Craftech, in the Ciudad Autónoma de Buenos Aires, Argentina; privacy and rights go to
// sales@craftech.io and to the contact form https://craftech.io/contact/; retention 24 months since the
// last sign-in, consent as the legal basis, the transfer to AWS in the United States, the Ley 25.326
// control-body legend. Nothing invented (no tax id, no street address) and no "a confirmar". Both
// languages live on each page (`#es`, `#en`).
import { type Page, expect, test } from "@playwright/test";
import { evidence, expectNeutralPage, expectNoHorizontalScroll, sizeOf } from "./support/site";

const CONTACT_FORM = "https://craftech.io/contact/";
const RIGHTS_MAILBOX = "sales@craftech.io";
/** A tax id (CUIT/CUIL), a street address or a phone number: none was given, so none may appear. */
const INVENTED = [/\bCUI[TL]\b/i, /\b\d{2}-?\d{8}-?\d\b/, /\b(?:Av\.|Avenida|Calle|Piso|Oficina|Street|Suite|Floor)\s+[\p{L}\d]/iu, /\bC\.?P\.?\s*\d{4}\b/, /\+54\s?\d/];

/** The text of `#id`: a whole `<section>`, or a numbered `<h2>` with everything up to the next heading. */
async function section(page: Page, id: string): Promise<string> {
  return page.locator(`#${id}`).evaluate((start) => {
    if (!/^H[1-6]$/.test(start.tagName)) return (start as HTMLElement).innerText;
    const parts = [(start as HTMLElement).innerText];
    for (let next = start.nextElementSibling; next && !/^H[1-6]$/.test(next.tagName); next = next.nextElementSibling) parts.push((next as HTMLElement).innerText);
    return parts.join("\n");
  });
}

/** Links inside the numbered section `#id` (the heading's following siblings). */
async function sectionLinks(page: Page, id: string): Promise<string[]> {
  return page.locator(`#${id}`).evaluate((start) => {
    const hrefs: string[] = [];
    for (let next = start.nextElementSibling; next && !/^H[1-6]$/.test(next.tagName); next = next.nextElementSibling) {
      for (const link of next.querySelectorAll("a[href]")) hrefs.push(link.getAttribute("href") ?? "");
    }
    return hrefs;
  });
}

test("[FL-127] privacy: controller, place, rights channels, retention, basis, transfer, control body", async ({ page }, info) => {
  await page.goto("/legal/privacy.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", /^es/);
  for (const lang of ["es", "en"] as const) {
    const controller = await section(page, `${lang}-controller`);
    expect(controller).toContain("Craftech");
    expect(controller).toContain("Ciudad Autónoma de Buenos Aires, Argentina");
    expect(controller).toContain(RIGHTS_MAILBOX);
    expect(controller).toContain(CONTACT_FORM);
    const rights = await section(page, `${lang}-rights`);
    expect(rights).toContain(RIGHTS_MAILBOX);
    expect(rights).toContain(CONTACT_FORM);
    expect(await sectionLinks(page, `${lang}-rights`), "the contact form is a rights channel").toContain(CONTACT_FORM);
    expect(await section(page, `${lang}-retention`)).toMatch(lang === "es" ? /24 meses desde tu último ingreso/ : /24 months since your last sign-in/);
    expect(await section(page, `${lang}-purpose`)).toMatch(lang === "es" ? /consentimiento \(Ley 25\.326, art\. 5\)/ : /consent \(Law 25\.326, art\. 5\)/);
    expect(await section(page, `${lang}-where`)).toMatch(lang === "es" ? /transferencia internacional.*Estados Unidos/s : /international transfer.*United States/s);
    expect(await section(page, `${lang}-authority`)).toContain("Agencia de Acceso a la Información Pública");
  }
  const text = await page.locator("body").innerText();
  for (const pattern of INVENTED) expect(text, `invented datum ${pattern}`).not.toMatch(pattern);
  await expectNoHorizontalScroll(page, "privacy");
  await expectNeutralPage(page, "privacy");
  await evidence(page, `legal-privacy-${sizeOf(info)}`);
});

test("[FL-127] terms: who offers the product, the contact channels and nothing invented", async ({ page }, info) => {
  await page.goto("/legal/terms.html", { waitUntil: "domcontentloaded" });
  for (const lang of ["es", "en"] as const) {
    const contact = await section(page, `${lang}-contact`);
    expect(contact).toContain(CONTACT_FORM);
    expect(contact).toContain(RIGHTS_MAILBOX);
    expect(await section(page, lang)).toContain("Craftech");
    await expect(page.locator(`#${lang} a[href^="/legal/privacy.html"]`)).not.toHaveCount(0);
  }
  const text = await page.locator("body").innerText();
  for (const pattern of INVENTED) expect(text, `invented datum ${pattern}`).not.toMatch(pattern);
  await expectNoHorizontalScroll(page, "terms");
  await expectNeutralPage(page, "terms");
  await evidence(page, `legal-terms-${sizeOf(info)}`);
});

test("[FL-127] the English links of the landing open the English half of each page", async ({ page }) => {
  for (const path of ["/legal/privacy.html#en", "/legal/terms.html#en"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#en")).toHaveAttribute("lang", "en");
    await expect(page.locator("#en h1")).toBeInViewport();
  }
});
