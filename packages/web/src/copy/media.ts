// The scan state of a customer's image as a person reads it, for the phone simulator and the case
// timeline: the GuardDuty result, the seed's own receipts (already verified by their hash) and the
// reasons an image is discarded. An unknown state never shows its raw code.
const SCAN_LABEL: Readonly<Record<string, string>> = {
  NO_THREATS_FOUND: "sin amenazas",
  SEED_SKIPPED: "comprobante de muestra, ya verificado",
  THREATS_FOUND: "con amenazas: descartada",
  TOO_LARGE: "demasiado pesada: descartada",
  TOO_MANY_PIXELS: "demasiado grande: descartada",
  UNSUPPORTED: "formato no admitido: descartada",
  BAD_MAGIC: "formato no admitido: descartada",
  EMPTY: "vacía: descartada",
  UNREADABLE_HEADER: "ilegible: descartada",
  GONE: "ya no está disponible",
  ACCESS_DENIED: "no se pudo escanear: descartada",
  FAILED: "no se pudo escanear: descartada",
  TIMEOUT: "no se pudo escanear: descartada",
};

export const mediaCopy = {
  image: "Imagen",
  receipt: "Imagen · comprobante",
  pending: "escaneo en curso",
  unknown: "escaneo sin resultado conocido",
};

/** `Escaneo: sin amenazas`, `Escaneo: comprobante de muestra, ya verificado`… (never the raw state). */
export function scanText(state: string | null | undefined): string {
  if (state === null || state === undefined || state === "") return `Escaneo: ${mediaCopy.pending}`;
  return `Escaneo: ${SCAN_LABEL[state] ?? mediaCopy.unknown}`;
}
