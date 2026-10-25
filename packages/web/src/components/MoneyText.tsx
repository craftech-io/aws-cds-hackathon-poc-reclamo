// An amount in pesos as the tools return it (`{ amount, text }`, @reclamo/shared Money): the text is
// shown as it came, never re-formatted in the browser; negatives (a debit) in the danger tone.
import type { Money } from "@reclamo/shared";

export function MoneyText({ value }: { readonly value: Money }) {
  return <span className={`whitespace-nowrap tabular-nums ${value.amount < 0 ? "text-danger" : "text-ink"}`}>{value.text}</span>;
}
