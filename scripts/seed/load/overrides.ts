// `SeedOverrides` (infra/secrets.ts, docs/seed-spec.md §5 and §15): the only real data the load
// touches, checked before anything is written. `demoRecipients.emails` are at most 5 and every one is a
// `@craftech.io` mailbox (the load fails otherwise; the gate re-checks them at send time); the load
// only audits how many there are and their keyed hashes. `personaPhones` (persona → E.164) apply only
// to the `demo` world. The value is PII: it is never printed, logged or audited in clear.
import { z } from "zod";
import { normalizeEmail } from "@reclamo/shared";

export const MAX_DEMO_RECIPIENTS = 5;

const CRAFTECH_MAILBOX = /^[a-z0-9._%+-]+@craftech\.io$/;

const Raw = z.looseObject({
  demoRecipients: z.looseObject({ emails: z.array(z.string().max(254)).optional() }).optional(),
  personaPhones: z.record(z.string(), z.string()).optional(),
});

export interface SeedOverrides {
  readonly demoEmails: readonly string[];
  /** `C01 → +549…`: only for the `demo` world. */
  readonly personaPhones: Readonly<Record<string, string>>;
}

export class OverridesError extends Error {
  override readonly name = "OverridesError";
}

/** The overrides, or an `OverridesError` that names the rule without echoing any value. */
export function parseOverrides(raw: string | undefined): SeedOverrides {
  const text = raw === undefined || raw.trim() === "" || raw.trim() === "not-configured" ? "{}" : raw;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OverridesError("SeedOverrides is not valid JSON");
  }
  const parsed = Raw.safeParse(json);
  if (!parsed.success) throw new OverridesError("SeedOverrides does not have the expected shape");
  const emails = (parsed.data.demoRecipients?.emails ?? []).map((email) => {
    let normalized: string;
    try {
      normalized = normalizeEmail(email);
    } catch {
      throw new OverridesError("SeedOverrides.demoRecipients.emails holds an invalid address");
    }
    if (!CRAFTECH_MAILBOX.test(normalized)) throw new OverridesError("SeedOverrides.demoRecipients.emails accepts only @craftech.io mailboxes");
    return normalized;
  });
  if (emails.length > MAX_DEMO_RECIPIENTS) throw new OverridesError(`SeedOverrides.demoRecipients.emails holds more than ${MAX_DEMO_RECIPIENTS} addresses`);
  const phones = parsed.data.personaPhones ?? {};
  for (const [persona, phone] of Object.entries(phones)) {
    if (!/^C\d{2}$/.test(persona)) throw new OverridesError("SeedOverrides.personaPhones is keyed by persona (C01…C41)");
    if (!/^\+\d{8,15}$/.test(phone)) throw new OverridesError("SeedOverrides.personaPhones holds a number that is not E.164");
  }
  return { demoEmails: emails, personaPhones: phones };
}
