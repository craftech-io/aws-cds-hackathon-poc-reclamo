// Which numbers the SMS code accepts and how it counts them (docs/architecture-guests.md §17.3, §17.7),
// one list each, on the E.164 form (`+` and digits):
//
//   home          the region the demo is for (Latin America and Spain): its SMS count only the usual caps
//   not personal  ranges that are not a person's mobile (machine-to-machine, personal numbering,
//                 international networks, satellite): refused when a number is entered or corrected
//   filler        a number ending in seven or more equal digits (`+5491100000000`): refused as invalid
//
// Any other country is accepted, but its SMS share a small quota of the whole demo (`smsAbroadPerDay`).

/** Country (and NANP area) codes of the home region. */
export const HOME_PREFIXES: readonly string[] = [
  "+54", // Argentina
  "+55", // Brazil
  "+56", // Chile
  "+57", // Colombia
  "+52", // Mexico
  "+51", // Peru
  "+598", // Uruguay
  "+595", // Paraguay
  "+591", // Bolivia
  "+593", // Ecuador
  "+58", // Venezuela
  "+506", // Costa Rica
  "+507", // Panama
  "+502", // Guatemala
  "+503", // El Salvador
  "+504", // Honduras
  "+505", // Nicaragua
  "+1809", // Dominican Republic
  "+1829", // Dominican Republic
  "+1849", // Dominican Republic
  "+34", // Spain
];

/** Ranges that are not a person's mobile. */
export const NOT_PERSONAL_PREFIXES: readonly string[] = [
  "+3197", // Netherlands, machine-to-machine
  "+4470", // United Kingdom, personal numbering
  "+882", // international networks
  "+883", // international networks
  "+870", // satellite
  "+881", // satellite
  "+888",
  "+979",
];

const FILLER = /(\d)\1{6}$/;

const startsWithAny = (phone: string, prefixes: readonly string[]): boolean => prefixes.some((prefix) => phone.startsWith(prefix));

/** A number of the home region: its SMS do not take the quota of the numbers abroad. */
export const isHomeNumber = (phone: string): boolean => startsWithAny(phone, HOME_PREFIXES);

/** A range that is not a person's mobile. */
export const isNotPersonalNumber = (phone: string): boolean => startsWithAny(phone, NOT_PERSONAL_PREFIXES);

/** Seven or more equal digits at the end. */
export const isFillerNumber = (phone: string): boolean => FILLER.test(phone);
