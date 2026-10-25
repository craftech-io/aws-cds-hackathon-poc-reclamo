// Versioned text of the email-channel consent (BCRA 3.1.6: the written answer may go by email if
// the customer accepted it when filing; CONTEXT.md, "Aceptación del canal email"). The acknowledgement
// asks it and `record_email_consent` stores `{at, addressHash, channelTextVersion}` with the version
// the customer saw. A published version never changes: a new wording is a new version, and
// copy.test.ts recomputes each `sha256` so an edit in place fails. The gloss is in en-gloss.ts.

export interface ConsentVersion {
  readonly version: string;
  /** Question shown under the acknowledgement; `{{emailMasked}}` is the masked registered address. */
  readonly question: string;
  /** SHA-256 (hex) of `question` as UTF-8. */
  readonly sha256: string;
}

export const EMAIL_CONSENT_VERSIONS = {
  "email-answer-v1": {
    version: "email-answer-v1",
    question: "¿Aceptás que la respuesta escrita de este reclamo y sus documentos te lleguen por email a {{emailMasked}}? Si preferís otro medio, te contacta una persona.",
    sha256: "7fa0b680ca9d1980fd8ad1719e32c92b0e853aefe74800398b60f308e52432e8",
  },
} as const satisfies Readonly<Record<string, ConsentVersion>>;

export type ConsentVersionId = keyof typeof EMAIL_CONSENT_VERSIONS;

/** The version every new acknowledgement shows. */
export const CURRENT_EMAIL_CONSENT: ConsentVersion = EMAIL_CONSENT_VERSIONS["email-answer-v1"];
