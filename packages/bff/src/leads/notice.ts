// The lead notice to Craftech (docs/architecture-guests.md §9): one plain-text email per confirmed
// lead to the ONE @craftech.io mailbox of the `LeadNotifyEmail` secret. The fence is code here (a
// single address, `@craftech.io`, strict parser; `not-configured` sends nothing) and IAM around it
// (`ses:Recipients *@craftech.io`, `ses:FromAddress no-reply@…`). The subject is fixed (no lead data
// in it); the body carries only the contact data the visitor chose to give, whether they accepted
// being contacted, the language, the campaign and the date. Name, company, role and UTM were typed by
// a stranger: they are checked again here, and a value that fails is left out, never sent.
import { leadText } from "../guests/schemas";
import type { Lead } from "./records";

export const LEAD_NOTICE_SUBJECT = "Nuevo lead · Reclamo en regla";

/** Subject of the operator's test notice (`npm run leads:notice-test`): marked, so nobody takes it for a lead. */
export const LEAD_NOTICE_TEST_SUBJECT = `[PRUEBA] ${LEAD_NOTICE_SUBJECT}`;

/** The only recipient of `notice.probe` (QaDriver): the SES mailbox simulator, never a person. */
export const LEAD_NOTICE_PROBE_RECIPIENT = "success@simulator.amazonses.com";

/** Value of `LeadNotifyEmail` until the operator sets the @craftech.io mailbox. */
export const NOT_CONFIGURED = "not-configured";

const CRAFTECH_MAILBOX = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@craftech\.io$/;

/** The one recipient, or `undefined` when the secret is `not-configured` or anything but one @craftech.io address. */
export function leadNoticeRecipient(secret: string): string | undefined {
  const value = secret.trim().toLowerCase();
  if (value === NOT_CONFIGURED || !CRAFTECH_MAILBOX.test(value)) return undefined;
  return value;
}

const SAFE = leadText(100);

function safe(value: string | undefined): string {
  if (value === undefined) return "—";
  const parsed = SAFE.safeParse(value);
  return parsed.success ? parsed.data : "(omitido: formato no aceptado)";
}

export interface LeadNotice {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** The notice of one lead; its email is the only address in it, and only in the body. */
export function leadNotice(lead: Lead, to: string): LeadNotice {
  const lines = [
    "Nueva alta confirmada en la demo de Reclamo en regla.",
    "",
    `Email: ${lead.email}`,
    `Nombre: ${safe(lead.name)}`,
    `Empresa: ${safe(lead.company)}`,
    `Cargo: ${safe(lead.jobTitle)}`,
    `Acepta que Craftech lo contacte: ${lead.consents.contact.accepted ? "sí" : "no"}`,
    `Idioma: ${lead.locale}`,
    `utm_source: ${safe(lead.utm?.source)}`,
    `utm_campaign: ${safe(lead.utm?.campaign)}`,
    `Fecha de alta: ${lead.confirmedAtReal}`,
    "",
    "Exportación completa: npm run leads:export (operador, profile de la cuenta).",
  ];
  return { to, subject: LEAD_NOTICE_SUBJECT, text: lines.join("\n") };
}

/**
 * The operator's test of the notice's delivery (`npm run leads:notice-test`): the same transport and
 * mailbox as a lead's notice, a `[PRUEBA]` subject and a body that carries no lead and no address.
 */
export function leadNoticeTest(to: string, now: Date): LeadNotice {
  const lines = [
    "[PRUEBA] Aviso de prueba de Reclamo en regla.",
    "",
    "No hay ningún lead nuevo: este mensaje lo mandó el operador para comprobar que el aviso de leads llega a esta casilla",
    "por el mismo transporte que usan las altas confirmadas.",
    `Enviado: ${now.toISOString()}`,
  ];
  return { to, subject: LEAD_NOTICE_TEST_SUBJECT, text: lines.join("\n") };
}
