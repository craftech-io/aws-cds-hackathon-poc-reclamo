// Texts of the approvals view and of the approve / reject controls the complaint view reuses
// (docs/design-brief.md §9 "Aprobaciones", §8.7). Rioplatense Spanish with the English gloss on the
// headings and the key buttons; the button words come from packages/bff/src/copy (single source).
import type { CapAction, CapTier } from "@reclamo/shared";
import { CONSOLE_ES } from "@reclamo/bff/copy/es-AR";
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";

export const approvalsCopy = {
  lead: "El agente pide una aprobación cuando un monto supera su tope; nunca aprueba su propia acción. Una persona decide acá y el código ejecuta la acción con el monto que informa el core, una sola vez.",
  tierHint: {
    OPERATOR: "Como operador aprobás hasta el tope del operador; lo que lo supera lo aprueba un supervisor.",
    SUPERVISOR: "Como supervisor aprobás también lo que supera el tope del operador.",
    GUEST: "En tu mundo de invitado aprobás como un supervisor.",
    COMPLIANCE: "Cumplimiento mira las aprobaciones; no las decide.",
  },
  recentLogin: "Aprobar pide haber ingresado con tu contraseña en los últimos 15 minutos: si pasaron más, la consola te la pide antes de aprobar.",
  caption: "Aprobaciones pendientes · Pending approvals",
  empty: "No hay aprobaciones pendientes en este mundo.",
  emptyLead: "Cuando el agente pida aprobar un monto por encima de su tope, el pedido aparece acá.",
  columns: {
    complaint: "Reclamo · Complaint",
    action: "Acción · Action",
    amount: "Monto · Amount",
    cap: "Tope superado · Cap exceeded",
    evidence: "Evidencia · Evidence",
    expires: "Vence · Expires",
    decision: "Decisión · Decision",
  },
  action: {
    APPLY_PAYMENT: "Imputar un pago",
    REVERSE_CHARGE: "Revertir un cargo",
    REFUND_DUPLICATE: "Reintegrar un débito duplicado",
    TRANSFER_REVERSAL: "Revertir una transferencia rechazada",
  } satisfies Readonly<Record<CapAction, string>>,
  capOf: {
    AGENT: (cap: string) => `Supera el tope del agente (${cap})`,
    OPERATOR: (cap: string) => `Supera el tope del operador (${cap})`,
    SUPERVISOR: (cap: string) => `Supera el tope del supervisor (${cap})`,
  } satisfies Readonly<Record<CapTier, (cap: string) => string>>,
  needsTier: {
    OPERATOR: "Decide un operador o un supervisor",
    SUPERVISOR: "Solo un supervisor · Supervisor only",
  } satisfies Readonly<Record<Exclude<CapTier, "AGENT">, string>>,
  requestedBy: "Pedida por el agente",
  justification: "Fundamento del agente",
  evidenceLink: "Ver la evidencia del caso",
  lapsed: "Vencida: el caso volvió a una persona",
  approve: `${CONSOLE_ES.BUTTON_APPROVE} · ${CONSOLE_EN.BUTTON_APPROVE}`,
  reject: `${CONSOLE_ES.BUTTON_REJECT} · ${CONSOLE_EN.BUTTON_REJECT}`,
  rejectReason: "Motivo del rechazo",
  rejectReasonHint: "Queda en la auditoría y el reclamo pasa a una persona.",
  confirmReject: "Confirmar el rechazo · Confirm rejection",
  cancel: "Cancelar · Cancel",
  approved: "Aprobada. El código ejecuta la acción con el monto del core; el agente avisa al cliente.",
  approvedAgain: "Ya la habías aprobado: pedimos de nuevo su ejecución, que nunca corre dos veces.",
  rejected: "Rechazada. El reclamo quedó con una persona: respondelo por escrito desde el caso.",
  readOnly: "Solo lectura",
  byReason: {
    CAP_TIER: "Este monto supera tu tope: lo aprueba un supervisor.",
    NOT_PENDING: "Esta aprobación ya se decidió.",
    EXPIRED: "Esta aprobación venció: el caso volvió a una persona.",
    OTHER_EPOCH: "Esta aprobación es de un estado anterior del mundo.",
  } as Readonly<Record<string, string>>,
} as const;
