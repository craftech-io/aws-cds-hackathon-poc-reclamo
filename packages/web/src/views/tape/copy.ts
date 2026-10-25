// Texts of the compliance tape (docs/design-brief.md §7 and §9 "Cinta de cumplimiento"; FL-064,
// FL-075). The rule names, the red banner and the reroute labels come from the BFF's copy, their
// single source (packages/bff/src/copy/block-reasons.ts); this file keeps the view's own words.
import type { Channel, TapeEntryKind } from "@reclamo/shared";

type SenderClass = "AGENT" | "SYSTEM" | "OPERATOR";

export const tapeCopy = {
  filters: {
    decision: "Decisión · Decision",
    sender: "Emisor · Sender",
    channel: "Canal · Channel",
    rule: "Regla · Rule",
    all: "Todas · All",
    allSenders: "Todos · All",
    allChannels: "Todos · All",
    allRules: "Todas las reglas · All rules",
    complaint: (id: string) => `Solo el reclamo ${id}`,
    clearComplaint: "Ver toda la cinta",
  },
  decisions: {
    ALLOWED: "Permitidas",
    BLOCKED: "Bloqueadas",
    REROUTED: "Reencaminadas",
    DEFERRED: "Diferidas",
    DISPATCH: "Envíos",
  } satisfies Record<TapeEntryKind, string>,
  senders: {
    AGENT: "Agente · Agent",
    SYSTEM: "Sistema · System",
    OPERATOR: "Persona del equipo · Staff",
  } satisfies Record<SenderClass, string>,
  channels: { WHATSAPP: "WhatsApp", EMAIL: "Email" } satisfies Record<Channel, string>,
  columns: {
    at: "Hora simulada",
    decision: "Decisión",
    sender: "Emisor",
    channel: "Canal",
    kind: "Tipo de mensaje",
    rules: "Reglas",
  },
  stats: {
    total: "Decisiones de la época",
    blocked: "Bloqueadas",
    rerouted: "Reencaminadas",
    violations: "Violaciones de política",
    violationsHint: "Debe ser 0 · Must be 0",
    violationsNote: "Un saliente sin su decisión permitida, una imputación con la línea de otro cliente o una cadena rota cuentan acá.",
  },
  chainTitle: "Cadena de la cinta · Tape chain",
  exportTitle: "Exportación de la cinta · Tape export",
  listTitle: "Decisiones · Decisions",
  caption: "Decisiones de la compuerta de salida, la más reciente primero",
  empty: "Ninguna decisión coincide con los filtros.",
  more: "Ver más · More",
  shown: (shown: number, matching: number) => `${shown} de ${matching} decisiones`,
  detail: {
    open: "Ver el detalle",
    reviewed: "Reglas revisadas",
    reroute: "Camino elegido",
    child: "Decisión siguiente",
    rerouteOf: "Reencamina el bloqueo",
    nextAllowed: "Próxima hora permitida",
    result: "Resultado del envío",
    complaint: "Reclamo",
    message: "Mensaje",
    payload: "Hash del texto enviado",
    entry: "Entrada",
    version: "Versión de las reglas",
    customer: "Cliente (hash)",
  },
  results: { SENT: "Enviado", FAILED: "Falló", UNKNOWN_DELIVERY: "Entrega incierta: la revisa una persona" } as Readonly<Record<string, string>>,
  ruleResults: { PASS: "pasó", SKIP: "no aplica", BLOCK: "bloquea", DEFER: "difiere" } as Readonly<Record<string, string>>,
} as const;
