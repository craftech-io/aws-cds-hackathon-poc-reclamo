// Texts of the register view (docs/design-brief.md §9 "Registro"; docs/architecture.md §8.3; FL-096)
// and of the chain status and export panel the tape view reuses. Rioplatense Spanish with the English
// gloss on headings and key buttons. The three verification states are said exactly as the export
// header and the architecture say them: "Verificada", "Parcial: N entradas sin ancla", "Rota en seq N".
import type { ChainKind, RegisterEventType } from "@reclamo/bff/domain/ledger";

type RefundCause = "REVERSE_CHARGE" | "REFUND_DUPLICATE" | "TRANSFER_REVERSAL";

function entries(count: number): string {
  return count === 1 ? "1 entrada" : `${count} entradas`;
}

export const registerCopy = {
  chains: {
    label: "Registro · Register",
    REG: "Reclamos · Complaints",
    RRI: "Reintegros · Refunds",
  } satisfies Record<Exclude<ChainKind, "TAPE"> | "label", string>,
  status: {
    heading: "Estado de la cadena · Chain status",
    ok: "Verificada",
    okGloss: "Verified",
    partial: (count: number) => `Parcial: ${entries(count)} sin ancla`,
    partialGloss: (count: number) => `Partial: ${count} ${count === 1 ? "entry" : "entries"} without an anchor`,
    broken: (seq: number) => `Rota en seq ${seq}`,
    brokenGloss: (seq: number) => `Broken at seq ${seq}`,
    brokenNoSeq: "Rota",
    entries: "Entradas de la época",
    headHash: "Hash de cabeza",
    unanchored: "Sin ancla (seq)",
    conflicts: "Anclas en conflicto (seq)",
    foreign: "Anclas ajenas ignoradas",
    epoch: "Época",
    what: "IAM bloquea actualizar y borrar; una sobrescritura no se impide, se detecta en toda entrada anclada. Una entrada sin ancla se informa sin verificar, nunca como verificada.",
    unverifiedNote: "Las entradas sin ancla todavía no se pueden dar por verificadas.",
  },
  export: {
    button: "Exportar con verificación · Export",
    running: "Verificando y exportando…",
    heading: "Exportación · Export",
    lead: "La cadena se verifica contra sus anclas antes de exportar; el encabezado del archivo lleva el resultado, el hash de cabeza, la clave publicada y las anclas, así un tercero la verifica sin acceso al sistema.",
    csv: "Descargar CSV",
    json: "Descargar JSON",
    sha256: "Descargar sumas SHA-256",
    linkNote: "Los enlaces vencen a los 5 minutos.",
    sha: "SHA-256",
  },
  list: {
    caption: "Entradas del registro, en orden de seq",
    empty: "Todavía no hay entradas en esta época.",
    earlier: "Anteriores · Earlier",
    later: "Siguientes · Later",
    range: (from: number, to: number, total: number) => `seq ${from} a ${to} de ${total}`,
    searchLabel: "Buscar por número de reclamo · Complaint number",
    searchPlaceholder: "R-2026-000123",
    searchButton: "Buscar",
    searchClear: "Ver todo",
    searchInvalid: "El número tiene la forma R-AAAA-NNNNNN.",
    searchNone: "Ese número no tiene entradas en esta época.",
  },
  columns: {
    seq: "Seq",
    at: "Hora simulada",
    number: "Número",
    event: "Evento",
    detail: "Detalle",
    channel: "Canal",
    origin: "Origen",
    hash: "Hash",
    cause: "Causa",
    product: "Producto",
    amount: "Monto",
    interest: "Interés",
    creditNote: "Nota de crédito",
  },
  events: {
    FILED: "Presentación",
    STATUS: "Cambio de estado",
    PROVISIONAL_ANSWER: "Respuesta provisoria",
    FINAL_ANSWER: "Respuesta final",
    DELIVERY_PROOF: "Constancia de entrega",
    WITHDRAWN: "Desistimiento",
    RECLASSIFIED: "Reclasificación",
  } satisfies Record<RegisterEventType, string>,
  kinds: { CONSULTA: "Consulta", RECLAMO: "Reclamo" } as Readonly<Record<string, string>>,
  origins: { SEED: "Historia sembrada", LIVE: "En vivo" } as Readonly<Record<string, string>>,
  causes: {
    REVERSE_CHARGE: "Reversión de cargo",
    REFUND_DUPLICATE: "Reintegro de débito duplicado",
    TRANSFER_REVERSAL: "Reversión de transferencia",
  } satisfies Record<RefundCause, string>,
  presenter: "Presentó",
  answerHash: "Hash del cuerpo",
} as const;
