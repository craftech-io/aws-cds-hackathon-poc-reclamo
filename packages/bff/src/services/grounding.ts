// Deterministic grounding of an outbound text (docs/architecture-integrations.md §4, step 4): every
// amount the text shows, and every other number of four or more digits (complaint numbers, dates,
// instalments, operation codes), has to appear in the turn's results. Figures are compared as a
// reader sees them (figure-text.ts): other scripts' digits, hidden characters and split thousands
// do not hide an amount. The outbound verification blocks the message with `GROUNDING_FAIL` when
// anything is left over.
import { spelledAmounts } from "./figure-text";
import { numberTokens } from "./money";

const BARE_MIN_DIGITS = 4;

export interface GroundingGaps {
  /** Amounts of the text that no result shows (or that no peso result can show), as normalized. */
  readonly amounts: readonly string[];
  /** Other numbers of four or more digits that no result shows, as normalized. */
  readonly numbers: readonly string[];
  /** Amounts written in words (`mil quinientos pesos`): never compared, an amount-bearing message fails closed. */
  readonly spelled: readonly string[];
}

/** What `text` states that `grounded` (the turn's results as text) does not. */
export function ungroundedFigures(text: string, grounded: readonly string[]): GroundingGaps {
  const known = grounded.flatMap(numberTokens);
  const cents = new Set(known.flatMap((token) => (token.cents === undefined ? [] : [token.cents])));
  const digits = new Set(known.map((token) => token.digits));
  const amounts: string[] = [];
  const numbers: string[] = [];
  for (const token of numberTokens(text)) {
    if (token.unverifiable) amounts.push(token.raw);
    else if (token.cents !== undefined) {
      if (!cents.has(token.cents)) amounts.push(token.raw);
    } else if (token.digits.length >= BARE_MIN_DIGITS && !digits.has(token.digits)) {
      numbers.push(token.raw);
    }
  }
  return { amounts, numbers, spelled: spelledAmounts(text) };
}
