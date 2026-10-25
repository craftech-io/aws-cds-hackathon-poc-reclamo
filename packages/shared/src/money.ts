// Money in Argentine pesos. Stored as integer centavos; every tool output and text carries the
// amount in pesos with its es-AR text (`{ amount: 118640.00, text: "$ 118.640,00" }`,
// docs/tool-catalog.md "Montos y fechas") so the model copies it instead of formatting numbers.
// No `Intl`: the output must be byte-identical on every runtime (the seed is deterministic).
import { z } from "zod";

export const Money = z.object({
  amount: z.number().multipleOf(0.01),
  text: z.string().min(1),
});
export type Money = z.infer<typeof Money>;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "$ 118.640,00"; negatives keep the sign in front: "-$ 1.234,56". */
export function formatPesos(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`amount must be an integer number of centavos, got ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const digits = Math.abs(cents).toString().padStart(3, "0");
  return `${sign}$ ${groupThousands(digits.slice(0, -2))},${digits.slice(-2)}`;
}

/** The public shape of an amount of integer centavos. */
export function pesosFromCents(cents: number): Money {
  return { amount: Math.round(cents) / 100, text: formatPesos(cents) };
}
