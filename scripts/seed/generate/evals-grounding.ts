// The grounding eval (`evals/grounding.json`, docs/seed-spec.md §12, `EV-1`): 40 customer questions
// about the rights of the complaint, late interest, early payoff, closure, the wallet, transfers and
// payments, each with the clauses (terms.ts) the answer must cite in `TURN#`, the facts it must state
// and the patterns it must never contain (collection, legal advice, promises the code does not make). A
// required fact may list equivalent wordings separated by " | ", and a wording between slashes is a pattern
// over the folded answer (lower case, no accents) for a fact stated by meaning (scripts/evals/ev1-grounding.ts).

export interface GroundingEntry {
  readonly id: string;
  readonly question: string;
  readonly expectedClauseIds: readonly string[];
  readonly requiredFacts: readonly string[];
  readonly forbiddenPatterns: readonly string[];
}

/** Never in an answer: exhortation to pay, threats, legal advice, invented guarantees. */
const ALWAYS_FORBIDDEN = ["\\bpag[aá]\\s+(hoy|ya|ahora)\\b", "evit[aá]\\s+recargos", "acciones legales", "te\\s+garantizamos", "asesoramiento legal:"];

const Q = (question: string, expectedClauseIds: readonly string[], requiredFacts: readonly string[], extraForbidden: readonly string[] = []): Omit<GroundingEntry, "id"> => ({
  question,
  expectedClauseIds,
  requiredFacts,
  forbiddenPatterns: [...ALWAYS_FORBIDDEN, ...extraForbidden],
});

const QUESTIONS: ReadonlyArray<Omit<GroundingEntry, "id">> = [
  Q("¿En cuánto tiempo me tienen que contestar el reclamo?", ["D-2"], ["10 días hábiles"]),
  Q("¿Me dan un número de reclamo?", ["D-1"], ["número"]),
  Q("¿Me pueden mandar la respuesta por email?", ["D-3"], ["email"]),
  Q("¿Puedo hablar con una persona?", ["D-4"], ["persona"]),
  Q("Si no estoy de acuerdo con la respuesta, ¿qué puedo hacer?", ["D-5"], ["Banco Central"]),
  Q("¿Cuentan los feriados en el plazo de respuesta?", ["D-2"], ["hábiles"]),
  Q("¿Qué es el interés punitorio?", ["T-3.2"], ["50 %"]),
  Q("¿Desde cuándo corre el punitorio?", ["T-3.1", "T-3.2"], ["día siguiente"]),
  Q("Pagué un día después del vencimiento, ¿me cobran punitorio?", ["T-3.4"], ["2 días"]),
  Q("La red rindió mi pago tarde, ¿pago punitorio igual?", ["T-3.4", "T-2.5"], ["fecha"]),
  Q("¿Dónde veo el punitorio que me cobraron?", ["T-3.3"], ["detalle"]),
  Q("¿Puedo cancelar el préstamo antes?", ["T-6.1"], ["total o parcial"]),
  Q("¿Cuánto cuesta cancelar el préstamo por adelantado?", ["T-6.2"], ["2 %", "25 %"]),
  Q("¿Hasta cuándo vale la cotización de cancelación?", ["T-6.3"], ["día hábil"]),
  Q("Si cancelo, ¿me dan el libre deuda?", ["T-6.4"], ["libre deuda"]),
  Q("¿Cómo doy de baja la cuenta?", ["T-7.1", "T-7.2"], ["cualquier canal"]),
  Q("Tengo un préstamo vigente, ¿puedo dar de baja la cuenta?", ["T-7.3"], ["préstamo"]),
  Q("¿Me confirman la baja por escrito?", ["T-7.4"], ["por escrito"]),
  Q("¿Cuánto cuesta transferir desde la billetera?", ["T-4.3"], ["sin costo | no tienen costo | no tiene costo"]),
  Q("¿Para qué sirve el CVU?", ["T-4.2"], ["CVU"]),
  Q("¿Por qué me bloquearon las transferencias salientes?", ["T-4.4"], ["protección"]),
  Q("¿Quién levanta el bloqueo de la billetera?", ["T-4.5"], ["persona"]),
  Q("¿Cuánto sale reponer la tarjeta?", ["T-4.6"], ["$ 2.500"]),
  Q("¿Cuántos días de movimientos muestra la billetera?", ["T-4.1"], ["90 días"]),
  Q("¿Dónde puedo pagar la cuota?", ["T-2.1"], ["redes de cobro"]),
  Q("¿A qué cuota se imputa mi pago?", ["T-2.2"], ["más antigua"]),
  Q("Pagué a la noche en la red, ¿cuándo se acredita?", ["T-2.3", "T-2.4"], ["corte"]),
  Q("¿Cuándo se acredita un pago en la red de cobro?", ["T-2.4"], ["rendición"]),
  Q("¿Cuándo se debita la cuota automáticamente?", ["T-5.1"], ["vencimiento"]),
  Q("Si no tengo saldo para el débito, ¿qué pasa?", ["T-5.2"], ["48 horas"]),
  Q("Si me debitan dos veces la misma cuota, ¿qué pasa?", ["T-5.3"], ["reintegra"]),
  Q("¿Puedo sacar el débito automático?", ["T-5.4"], ["baja"]),
  Q("¿Cuántas cuotas puede tener el préstamo?", ["T-1.2"], ["3 a 18"]),
  Q("¿La cuota cambia todos los meses?", ["T-1.4"], ["fija"]),
  Q("¿Por qué me acreditaron menos plata del préstamo?", ["T-1.6"], ["3 %"]),
  Q("¿El seguro sobre saldo lo pago yo?", ["T-1.5"], ["nunca"]),
  Q("¿Cómo cambio mi email?", ["T-8.1"], ["/(direccion|email|mail|correo)[^.]{0,40}(vigente|actual|registrad)/"]),
  Q("Cambié de teléfono, ¿cómo lo actualizo?", ["T-8.2"], ["persona"]),
  Q("¿Me van a pedir la clave por WhatsApp?", ["P-1"], ["nunca"]),
  Q("¿Me pueden cobrar la deuda por WhatsApp?", ["P-2", "T-3.5"], ["email"]),
];

export function groundingEval(): GroundingEntry[] {
  return QUESTIONS.map((entry, index) => ({ id: `gnd-${String(index + 1).padStart(2, "0")}`, ...entry }));
}
