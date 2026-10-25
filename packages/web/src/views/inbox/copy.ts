// Texts of the inbox (docs/design-brief.md §9 "Bandeja", FL-097) and the labels the case reuses for
// who a complaint waits for, its control and its milestones. Rioplatense Spanish with the English
// gloss on the headings; the complaint types and statuses come from packages/bff/src/copy.
import type { SlaMilestone } from "@reclamo/shared";

export type BlockedByKey = "CUSTOMER" | "NETWORK" | "PERSON" | "AGENT" | "NONE";

export const inboxCopy = {
  lead: "Cada reclamo con su número, el plazo de 10 días hábiles que corre desde la presentación, el estado del plazo, quién tiene la conversación y quién lo bloquea ahora.",
  caption: "Reclamos y consultas por plazo · Complaints by deadline",
  mainStory: "Historia principal · Main story",
  empty: "No hay reclamos que coincidan con los filtros.",
  emptyLead: "Probá con otros filtros o incluí los cerrados.",
  emptyWorld: "Este mundo todavía no tiene reclamos.",
  emptyWorldLead: "Escribí desde el simulador de teléfono como una de las personas sintéticas: el número de reclamo llega en el acto.",
  columns: {
    number: "Número · Number",
    type: "Tipo · Type",
    status: "Estado · Status",
    deadline: "Plazo · Deadline",
    next: "Próximo hito · Next milestone",
    blockedBy: "Quién bloquea · Waiting on",
    control: "Control",
  },
  filters: {
    blockedBy: "Quién bloquea",
    sla: "Plazo",
    type: "Tipo",
    control: "Control",
    all: "Todos",
    allTypes: "Todos los tipos",
    includeClosed: "Incluir cerrados y respondidos",
    total: (shown: number, total: number) => `${shown} de ${total}`,
  },
  kind: { CONSULTA: "Consulta", RECLAMO: "Reclamo" },
  blockedBy: {
    CUSTOMER: "El cliente",
    NETWORK: "La red",
    PERSON: "Una persona",
    AGENT: "El agente",
    NONE: "Nadie",
  } satisfies Readonly<Record<BlockedByKey, string>>,
  control: { AGENT: "Agente", OPERATOR: "Persona" },
  milestone: {
    OPERATOR_REMINDER: "Recordatorio al operador (día hábil 5)",
    SUPERVISOR_ESCALATION: "Escalamiento al supervisor (día hábil 8)",
    DEADLINE: "Vencimiento (día hábil 10)",
  } satisfies Readonly<Record<SlaMilestone, string>>,
  noMilestone: "Sin hitos pendientes",
  reminderFired: "Recordatorio del día 5 enviado",
  highPriority: "Prioridad alta",
  openTasks: (count: number) => (count === 1 ? "1 tarea abierta" : `${count} tareas abiertas`),
  businessDaysLeft: (days: number) => (days === 1 ? "1 día hábil" : `${days} días hábiles`),
} as const;
