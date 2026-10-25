// `Reference/HOLIDAY#AR` (docs/seed-spec.md §11): the national holidays that move the regulatory
// clock, checked against the official calendar published by the national government
// (argentina.gob.ar/interior/feriados, data file `holidays-2026-es.json`) on 2026-10-06. Fixed
// holidays, movable holidays and the tourist bridge days count as non-business days (the bridge days
// as an assumption, labelled); optional non-working days and local holidays do not.

export type HolidayKind = "FIXED" | "MOVABLE" | "BRIDGE";

export interface Holiday {
  readonly date: string;
  readonly name: string;
  readonly kind: HolidayKind;
  /** Where the date was checked and when. */
  readonly verifiedAt: string;
  readonly source: string;
  /** Set when counting the date as non-business is our assumption. */
  readonly assumption?: string;
}

const OFFICIAL_2026 = "Calendario oficial de feriados nacionales 2026 (argentina.gob.ar/interior/feriados)";
const OFFICIAL_2027 = "Calendario oficial de feriados nacionales 2027 (argentina.gob.ar/interior/feriados)";
const VERIFIED = "2026-10-06";
const BRIDGE = "Día no laborable con fines turísticos: lo contamos como no hábil (supuesto)";

const ROWS: ReadonlyArray<readonly [string, string, HolidayKind]> = [
  ["2026-01-01", "Año Nuevo", "FIXED"],
  ["2026-02-16", "Carnaval", "FIXED"],
  ["2026-02-17", "Carnaval", "FIXED"],
  ["2026-03-23", "Día no laborable con fines turísticos", "BRIDGE"],
  ["2026-03-24", "Día Nacional de la Memoria por la Verdad y la Justicia", "FIXED"],
  ["2026-04-02", "Día del Veterano y de los Caídos en la Guerra de Malvinas", "FIXED"],
  ["2026-04-03", "Viernes Santo", "FIXED"],
  ["2026-05-01", "Día del Trabajador", "FIXED"],
  ["2026-05-25", "Día de la Revolución de Mayo", "FIXED"],
  ["2026-06-15", "Paso a la Inmortalidad del Gral. Martín Miguel de Güemes (trasladado del 17/6)", "MOVABLE"],
  ["2026-06-20", "Paso a la Inmortalidad del Gral. Manuel Belgrano", "FIXED"],
  ["2026-07-09", "Día de la Independencia", "FIXED"],
  ["2026-07-10", "Día no laborable con fines turísticos", "BRIDGE"],
  ["2026-08-17", "Paso a la Inmortalidad del Gral. José de San Martín", "MOVABLE"],
  ["2026-10-12", "Día del Respeto a la Diversidad Cultural", "MOVABLE"],
  ["2026-11-09", "Feriado nacional por la visita papal", "FIXED"],
  ["2026-11-23", "Día de la Soberanía Nacional (trasladado del 20/11)", "MOVABLE"],
  ["2026-12-07", "Día no laborable con fines turísticos", "BRIDGE"],
  ["2026-12-08", "Inmaculada Concepción de María", "FIXED"],
  ["2026-12-25", "Navidad", "FIXED"],
  ["2027-01-01", "Año Nuevo", "FIXED"],
];

export const HOLIDAYS: readonly Holiday[] = ROWS.map(([date, name, kind]) => ({
  date,
  name,
  kind,
  verifiedAt: VERIFIED,
  source: date.startsWith("2027") ? OFFICIAL_2027 : OFFICIAL_2026,
  ...(kind === "BRIDGE" ? { assumption: BRIDGE } : {}),
}));

/** The dates that are not business days, for services/business-days.ts and the generator. */
export const HOLIDAY_DATES: readonly string[] = HOLIDAYS.map((holiday) => holiday.date);
