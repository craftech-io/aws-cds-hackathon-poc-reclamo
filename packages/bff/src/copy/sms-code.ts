// The text of the SMS code (docs/architecture-guests.md §17), in the language of the account: short,
// the product's name, the code and its life, nothing else (no link, no demo data).
import type { SignupLocale } from "./signup-consent";

export const SMS_PRODUCT_NAME = "Reclamo en regla";

/** The life of a code, `SECOND_FACTOR_LIMITS.codeValidSeconds` (second-factor/service.test.ts compares them). */
export const SMS_CODE_MINUTES = 10;

export function smsCodeText(locale: SignupLocale, code: string): string {
  return locale === "en"
    ? `Your ${SMS_PRODUCT_NAME} code is ${code}. It expires in ${SMS_CODE_MINUTES} minutes.`
    : `Tu código de ${SMS_PRODUCT_NAME} es ${code}. Vence en ${SMS_CODE_MINUTES} minutos.`;
}
