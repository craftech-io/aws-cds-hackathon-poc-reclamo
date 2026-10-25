// Every fixed Spanish text of the product (Rioplatense, voseo), one source each (ADR-0012). The
// English gloss of each key lives in en-gloss.ts under the same key. Placeholders are filled with
// helpers.ts `fill`; the names are part of the contract of each text.
//
//   WHATSAPP_TEXT  what the customer reads on WhatsApp (SYSTEM texts and fixed replies)
//   EMAIL_TEXT     subjects and fixed parts of every email (the agent's draft goes in between)
//   STAFF_TEXT     fixed texts for the staff and the guests (SLA notes, world states, simulator)
//   *_LABEL        labels of enums shown to customers, in PDFs and in the console
//   CONSOLE_ES     shared console keys with an English gloss: navigation, headings, key buttons,
//                  the recent-login modal (docs/design-brief.md §9)
//
// No text asks for or reminds of a payment, offers credit or asks for sensitive data
// (copy.test.ts checks every customer-facing text); none names a third-party brand.
import type { ComplaintOutcome, ComplaintStatus, ComplaintType, HandoffReason, MessageKind, SlaState } from "@reclamo/shared";
import type { AccountBlockCategory, ChallengeKind, DataChangeField, InstalmentStatusKey, LoanStatusKey } from "./types";

export const WHATSAPP_TEXT = {
  AUTOMATED_DISCLOSURE: "Soy el asistente automatizado de Jarilla (ficticio). En cualquier momento podés pedir que te atienda una persona.",
  LIVE_PROFILE: "Reclamo en regla (demo) · Jarilla es un prestamista ficticio",
  COMPLAINT_ACK: "Registré tu reclamo {{complaintNumber}} ({{complaintType}}). La respuesta escrita te llega a más tardar el {{deadlineText}}.",
  CONSULTA_ACK: "Registré tu consulta {{complaintNumber}} ({{complaintType}}). La respuesta escrita te llega a más tardar el {{deadlineText}}.",
  COMPLAINT_ACK_EXISTING: "Tu reclamo {{complaintNumber}} ({{complaintType}}) sigue abierto y lo estamos revisando. La respuesta escrita te llega a más tardar el {{deadlineText}}.",
  EMAIL_CONSENT_ACCEPTED: "Listo. Te mandamos el acuse con el número a {{emailMasked}}; la respuesta escrita te va a llegar ahí.",
  EMAIL_CONSENT_DECLINED: "Entendido. Una persona del equipo de atención te va a escribir por este medio para acordar cómo te enviamos la respuesta escrita.",
  EMAIL_UNAVAILABLE: "No tenemos un email activo para enviarte la respuesta escrita. Una persona del equipo de atención te va a escribir por este medio para acordar cómo te la enviamos.",
  CHALLENGE_LAST_DUE_DATE: "Para ver tu cuenta, decime la fecha de vencimiento de tu última cuota, con día y mes (dd/mm).",
  CHALLENGE_LAST_INSTALMENT_AMOUNT: "Para ver tu cuenta, decime el importe de tu última cuota.",
  CHALLENGE_LAST_MOVEMENT_AMOUNT: "Para ver tu cuenta, decime el importe del último movimiento de tu billetera.",
  CHALLENGE_RETRY: "Ese dato no coincide con lo que tenemos. Te pregunto una vez más.",
  UNKNOWN_SENDER: "Este número no está asociado a una cuenta de Jarilla (ficticio). Si sos cliente, escribinos desde el teléfono que tenés registrado; si no, podés hablar con una persona.",
  RECEIPT_REQUEST: "Mandame una foto del comprobante, así lo reviso.",
  RECEIPT_RETAKE: "No pude leer bien la foto. Mandame otra, con buena luz y con el comprobante completo.",
  MEDIA_TOO_LARGE: "La imagen es muy pesada. Mandame una foto más liviana del comprobante (hasta 3,75 MB).",
  MEDIA_UNSUPPORTED: "Solo puedo leer fotos (JPG o PNG). Mandame una foto del comprobante.",
  IMAGE_NOT_PROCESSED: "No pudimos procesar la imagen; mandala de nuevo o hablá con alguien.",
  IMAGE_REJECTED: "No pudimos usar esa imagen. Mandame otra foto del comprobante o hablá con alguien.",
  CHOOSE_LOAN_PROMPT: "Tenés más de un préstamo. ¿Sobre cuál es tu reclamo?",
  HOLDING_NOTICE: "Estamos revisando tu reclamo {{complaintNumber}}; te escribimos apenas tengamos novedades.",
  HOLDING_NOTICE_NO_COMPLAINT: "Estamos revisando tu mensaje; te escribimos apenas tengamos novedades.",
  HANDOFF_NOTICE: "Una persona de Jarilla sigue tu reclamo {{complaintNumber}}. El plazo de respuesta vence el {{deadlineText}}.",
  HANDOFF_NOTICE_NO_COMPLAINT: "Una persona de Jarilla va a seguir tu consulta por este medio.",
  HANDOFF_GUARDRAIL: "No puedo seguir con ese mensaje; te paso con una persona.",
  APPROVAL_PENDING: "Tu reclamo {{complaintNumber}} necesita la aprobación de una persona del equipo. Te avisamos apenas esté.",
  RESOLUTION_NOTICE: "Tu reclamo {{complaintNumber}} fue resuelto. Te mandamos la respuesta escrita por email a {{emailMasked}}.",
  EMAIL_UNDELIVERED: "No pudimos entregar la respuesta a tu email; una persona te contacta.",
  SAFETY_GUIDANCE: "Por tu seguridad: nunca te vamos a pedir claves, PIN, códigos de verificación ni datos de tarjetas, ni por este chat ni por email. Si alguien te los pide en nombre de Jarilla, no los compartas.",
  SAFETY_GUIDANCE_FREEZE: "Como protección, bloqueamos las transferencias y los pagos salientes de tu billetera. El bloqueo lo levanta una persona del equipo después de revisar tu caso.",
  SAFETY_GUIDANCE_CARD: "Tu mensaje tenía datos de una tarjeta y los ocultamos. No los mandes por acá: nunca te los vamos a pedir.",
  OUT_OF_SCOPE_REFUSAL: "Eso no lo puedo atender por acá: solo veo reclamos y consultas sobre tu cuenta de Jarilla y tus operaciones. Si querés, te atiende una persona.",
  OUT_OF_SCOPE_ADVICE: "No puedo darte asesoramiento legal ni de inversión. Si tu reclamo no se resuelve como esperás, tenés derecho a presentarlo ante el Banco Central (BCRA).",
  OPT_OUT_CONFIRMATION: "Listo, no te vamos a mandar más mensajes por WhatsApp. Tu cuenta sigue igual: esto no es una baja. Las respuestas escritas de tus reclamos te siguen llegando por email.",
  BAJA_AMBIGUOUS: "¿Querés dejar de recibir mensajes por WhatsApp o dar de baja tu cuenta de Jarilla?",
  RATE_LIMITED: "Recibimos muchos mensajes seguidos. Esperá un rato y volvé a escribir, o pedí hablar con una persona.",
} as const;
export type WhatsAppTextKey = keyof typeof WHATSAPP_TEXT;

/** Named for docs/design-brief.md §3: the gate prepends it to the first outbound of each conversation and epoch. */
export const AUTOMATED_DISCLOSURE = WHATSAPP_TEXT.AUTOMATED_DISCLOSURE;
/** The fixed wait message a worker obligation sends after a silent turn (docs/architecture.md §7). */
export const HOLDING_NOTICE = WHATSAPP_TEXT.HOLDING_NOTICE;

/** The prompt `identify_customer` returns as `challenge.promptText`, by challenge kind. */
export const CHALLENGE_PROMPT: Readonly<Record<ChallengeKind, WhatsAppTextKey>> = {
  LAST_DUE_DATE: "CHALLENGE_LAST_DUE_DATE",
  LAST_INSTALMENT_AMOUNT: "CHALLENGE_LAST_INSTALMENT_AMOUNT",
  LAST_MOVEMENT_AMOUNT: "CHALLENGE_LAST_MOVEMENT_AMOUNT",
};

export const EMAIL_TEXT = {
  FROM_NAME: "Jarilla (ficticio) vía Reclamo en regla",
  SUBJECT_ACK: "Reclamo {{complaintNumber}} · Acuse de recibo",
  SUBJECT_ANSWER: "Reclamo {{complaintNumber}} · Respuesta escrita",
  SUBJECT_UPDATE: "Reclamo {{complaintNumber}} · Novedad",
  SUBJECT_CLOSURE: "Reclamo {{complaintNumber}} · Baja de cuenta registrada",
  SUBJECT_DATA_CHANGE: "Pedido de cambio de datos · Jarilla (ficticio)",
  SUBJECT_COLLECTION_NOTICE: "Aviso formal de deuda · Jarilla (ficticio)",
  SUBJECT_SUPERVISOR_ALERT: "Reclamo {{complaintNumber}} · Escalamiento al supervisor",
  GREETING: "Hola {{firstName}}:",
  ACK_BODY_RECLAMO: "Registramos tu reclamo {{complaintNumber}} ({{complaintType}}) el {{filedAtText}}. La respuesta escrita te llega a este email a más tardar el {{deadlineText}}. Adjuntamos el acuse de recibo en PDF.",
  ACK_BODY_CONSULTA: "Registramos tu consulta {{complaintNumber}} ({{complaintType}}) el {{filedAtText}}. La respuesta escrita te llega a este email a más tardar el {{deadlineText}}. Adjuntamos el acuse de recibo en PDF.",
  ANSWER_INTRO: "Esta es la respuesta escrita a tu reclamo {{complaintNumber}} ({{complaintType}}), presentado el {{filedAtText}}.",
  ANSWER_ATTACHMENTS: "Adjuntamos la respuesta en PDF y la documentación que corresponde.",
  UPDATE_BODY: "Hay una novedad en tu reclamo {{complaintNumber}}: {{statusPhrase}}.",
  CLOSURE_BODY: "Registramos tu pedido de baja de la cuenta el {{requestedAtText}}, con el número {{complaintNumber}}. Adjuntamos la constancia en PDF.",
  CLOSURE_ACTIVE_LOAN: "Como tenés un préstamo vigente, la cuenta queda en baja en curso hasta que el préstamo quede cancelado. No hace falta que vuelvas a pedir la baja.",
  CLOSURE_WALLET_BALANCE: "Tu billetera todavía tiene saldo: la baja se completa cuando la billetera quede sin saldo. No hace falta que vuelvas a pedir la baja.",
  CLOSURE_PENDING_TRANSFER: "Tenés una transferencia en curso: la baja se completa cuando se acredite o se revierta. No hace falta que vuelvas a pedir la baja.",
  DATA_CHANGE_BODY: "Recibimos un pedido para cambiar {{field}} de tu cuenta. Te escribimos a la dirección que tenés registrada hoy. Si no lo pediste vos, avisanos por WhatsApp o pedí hablar con una persona.",
  COLLECTION_NOTICE_BODY: "Te enviamos este aviso formal con el detalle de las cuotas vencidas de tu préstamo {{loanLabel}}, según los registros de Jarilla (ficticio). El detalle y el total están en el PDF adjunto.",
  COLLECTION_NOTICE_RIGHTS: "Si no reconocés el detalle o querés presentar un reclamo, escribinos por WhatsApp o pedí hablar con una persona: tenés derecho a una respuesta escrita en 10 días hábiles.",
  SUPERVISOR_ALERT_BODY: "El reclamo {{complaintNumber}} llegó al día hábil 8 sin respuesta escrita. Vence el {{deadlineText}}.",
  NO_REPLY: "Este correo no recibe respuestas: para seguir, escribinos por WhatsApp o pedí hablar con una persona.",
  FOOTER_COMPLAINT: "Reclamo {{complaintNumber}}",
  FOOTER_BCRA: "Si esta respuesta no te satisface, podés presentar tu reclamo ante el Banco Central de la República Argentina (BCRA).",
  FOOTER_SYNTHETIC: "Jarilla es un prestamista ficticio · datos sintéticos · Reclamo en regla",
} as const;
export type EmailTextKey = keyof typeof EMAIL_TEXT;

export const STAFF_TEXT = {
  SLA_OPERATOR_REMINDER: "Recordatorio: el reclamo {{complaintNumber}} está en el día hábil 5 de 10. Vence el {{deadlineText}}.",
  SLA_SUPERVISOR_ESCALATION: "Escalamiento: el reclamo {{complaintNumber}} llegó al día hábil 8 sin respuesta escrita. Vence el {{deadlineText}}.",
  SLA_DEADLINE_OVERDUE: "Vencido: el reclamo {{complaintNumber}} venció el {{deadlineText}} sin respuesta escrita.",
  WORLD_NOT_READY: "Tu mundo todavía no está listo; probá de nuevo en un minuto o usá otra cuenta.",
  WORLD_RESETTING: "Estamos reiniciando tu mundo; tarda unos minutos.",
  OTHER_SESSION: "Otra sesión usó este mundo en las últimas 2 horas: usá otra cuenta de invitado.",
  SIMULATOR_LABEL: "WhatsApp (simulado)",
  SIMULATOR_UPLOAD_NOTICE: "Solo comprobantes sintéticos o de prueba; no subas documentos reales. Las imágenes subidas se borran a los 2 días.",
  NOT_LEGAL_ADVICE: "Nuestra lectura de las reglas, no asesoramiento legal",
  SYNTHETIC_TERMS: "condiciones sintéticas de un prestamista ficticio",
  ASSUMPTION: "supuesto",
} as const;
export type StaffTextKey = keyof typeof STAFF_TEXT;

/** Lower case: it goes inside sentences ("Registré tu reclamo R-… (pago no reflejado)"). */
export const COMPLAINT_TYPE_LABEL: Readonly<Record<ComplaintType, string>> = {
  PAYMENT_NOT_REFLECTED: "pago no reflejado",
  PAYOFF_CERTIFICATE: "libre deuda",
  UNRECOGNIZED_CHARGE: "cargo no reconocido",
  DUPLICATE_DEBIT: "débito duplicado",
  TRANSFER_NOT_CREDITED: "transferencia no acreditada",
  DISBURSEMENT_NOT_RECEIVED: "desembolso no recibido",
  UNKNOWN_OPERATION: "operación desconocida",
  ACCOUNT_BLOCKED: "cuenta bloqueada",
  CLOSURE_OR_EARLY_PAYOFF: "baja o cancelación anticipada",
  DATA_CHANGE: "corrección de datos",
  INFORMATION_REQUEST: "pedido de información",
};

export const COMPLAINT_OUTCOME_LABEL: Readonly<Record<ComplaintOutcome, string>> = {
  IN_FAVOUR: "A favor del cliente",
  PARTIALLY_IN_FAVOUR: "Parcialmente a favor del cliente",
  NOT_IN_FAVOUR: "No a favor del cliente",
  INFORMATIONAL: "Informativa",
  WITHDRAWN: "Desistido por el cliente",
};

export const COMPLAINT_STATUS_LABEL: Readonly<Record<ComplaintStatus, string>> = {
  REGISTERED: "Registrado",
  INVESTIGATING: "En investigación",
  AWAITING_CUSTOMER: "Espera al cliente",
  AWAITING_SETTLEMENT: "Espera la rendición de la red",
  AWAITING_NETWORK: "Espera a la red",
  AWAITING_APPROVAL: "Espera una aprobación",
  HUMAN_REVIEW: "Con una persona",
  RESOLVED: "Resuelto",
  ANSWERED: "Respondido por escrito",
  CLOSED: "Cerrado",
};

export const SLA_STATE_LABEL: Readonly<Record<SlaState, string>> = {
  ON_TIME: "En plazo",
  AT_RISK: "En riesgo",
  OVERDUE: "Vencido",
};

export const HANDOFF_REASON_LABEL: Readonly<Record<HandoffReason, string>> = {
  CUSTOMER_ASKED: "Lo pidió el cliente",
  LOW_CONFIDENCE: "Baja confianza del agente",
  TWO_FAILED_ATTEMPTS: "Dos intentos sin resolver",
  FRAUD: "Posible fraude",
  ABOVE_CAP: "Sobre el tope de política",
  IDENTITY_VERIFICATION: "Verificación de identidad",
  RECEIPT_NOT_FOUND: "Comprobante sin línea en la rendición",
  RECEIPT_DOUBT: "Comprobante dudoso",
  ACCOUNT_BLOCKED: "Cuenta bloqueada",
  RISKY_DATA_CHANGE: "Cambio de datos sensible",
  EMAIL_UNDELIVERABLE: "Email no entregado",
  GUARDRAIL_BLOCK: "Bloqueo del guardrail",
  OTHER: "Otro motivo",
};

/** The console composer and the timelines name each message kind with these. */
export const MESSAGE_KIND_LABEL: Readonly<Record<MessageKind, string>> = {
  COMPLAINT_ACK: "Acuse de recibo",
  ACK_EMAIL: "Acuse por email",
  IDENTITY_CHALLENGE: "Desafío de identidad",
  REPLY: "Respuesta",
  RECEIPT_REQUEST: "Pedido de comprobante",
  COMPLAINT_UPDATE: "Novedad del reclamo",
  RESOLUTION_NOTICE: "Aviso de resolución",
  FORMAL_ANSWER: "Respuesta escrita",
  HANDOFF_NOTICE: "Aviso de derivación",
  HOLDING_NOTICE: "Aviso de espera",
  OPERATOR_MESSAGE: "Mensaje del operador",
  SAFETY_GUIDANCE: "Guía de seguridad",
  OUT_OF_SCOPE_REFUSAL: "Fuera de alcance",
  OPT_OUT_CONFIRMATION: "Confirmación de opt-out",
  DATA_CHANGE_CONFIRMATION: "Confirmación de cambio de datos",
  CLOSURE_CONFIRMATION: "Confirmación de baja",
  SUPERVISOR_ALERT: "Alerta al supervisor",
  COLLECTION_REMINDER: "Recordatorio de mora",
  COLLECTION_NOTICE_EMAIL: "Aviso formal de deuda (email)",
};

/** What `get_account` explains for each block category (loaded into `Reference` by the seed). */
export const ACCOUNT_BLOCK_CATEGORY_TEXT: Readonly<Record<AccountBlockCategory, string>> = {
  SECURITY_REVIEW: "Tu cuenta está en revisión de seguridad. Mientras dura, una persona del equipo revisa los movimientos y te escribe por este medio.",
  IDENTITY_VALIDATION: "Tu cuenta está bloqueada hasta validar tu identidad. La validación la hace una persona del equipo; por este chat nunca te vamos a pedir documentos.",
  EXTERNAL_ORDER: "Tu cuenta tiene una restricción por una orden de un organismo externo. Una persona del equipo te explica los pasos.",
  INACTIVITY: "Tu cuenta se bloqueó por inactividad prolongada. Una persona del equipo la puede reactivar después de verificar tu identidad.",
};

/**
 * How the account reads (`get_account`, `get_loan`, `get_instalments`) describe a status to the customer, as
 * `statusText`: a neutral service phrase the agent copies, never a word of collection (a WhatsApp text that
 * calls an instalment overdue, unpaid or in arrears is blocked by `CH-WA-NO-COLLECTION`).
 */
export const LOAN_STATUS_TEXT: Readonly<Record<LoanStatusKey, string>> = {
  ACTIVE: "vigente",
  IN_ARREARS: "vigente, con cuotas pendientes",
  CANCELLED: "cancelado",
  EARLY_CANCELLED: "cancelado en forma anticipada",
};

export const INSTALMENT_STATUS_TEXT: Readonly<Record<InstalmentStatusKey, string>> = {
  DUE: "a vencer",
  PAID: "pagada",
  PARTIALLY_PAID: "pagada en parte",
  OVERDUE: "pendiente",
};

/** Goes inside `EMAIL_TEXT.DATA_CHANGE_BODY` ("cambiar tu domicilio"). */
export const DATA_CHANGE_FIELD_LABEL: Readonly<Record<DataChangeField, string>> = {
  EMAIL: "tu email",
  ADDRESS: "tu domicilio",
  PHONE: "tu teléfono",
};

export const CONSOLE_ES = {
  NAV_INBOX: "Bandeja",
  NAV_COMPLAINT: "Reclamo",
  NAV_CUSTOMER: "Cliente",
  NAV_APPROVALS: "Aprobaciones",
  NAV_TAPE: "Cinta de cumplimiento",
  NAV_REGISTER: "Registro de reclamos",
  NAV_EMAILS: "Emails",
  NAV_SIMULATOR: "Simulador de teléfono",
  NAV_CLOCK: "Reloj de demo",
  NAV_METRICS: "Métricas",
  NAV_POLICY: "Política de canal",
  NAV_TOUR: "Recorrido guiado",
  HEADING_TIMELINE: "Línea de tiempo",
  HEADING_EVIDENCE: "Evidencia",
  HEADING_ACTIONS: "Acciones y reintegros",
  HEADING_FORMAL_ANSWER: "Respuesta escrita",
  HEADING_COMPOSER: "Redactor",
  HEADING_SIMULATED_TIME: "Hora simulada",
  HEADING_THIS_WORLD: "Este mundo (medido)",
  HEADING_SEEDED_HISTORY: "Historia sembrada (no medida)",
  HEADING_REAL_BATCH: "Lote · agente real",
  HEADING_SIMULATED_LOAD: "Carga simulada (agente guionado)",
  BUTTON_TAKE_OVER: "Tomar conversación",
  BUTTON_HAND_BACK: "Devolver al agente",
  BUTTON_ANSWER_IN_WRITING: "Responder por escrito",
  BUTTON_APPROVE: "Aprobar",
  BUTTON_REJECT: "Rechazar",
  BUTTON_ESCALATE: "Derivar a una persona",
  BUTTON_SEND: "Enviar",
  BUTTON_ADVANCE_NEXT_EVENT: "Avanzar al próximo evento",
  BUTTON_ADVANCE_COMPLAINT_MILESTONE: "Avanzar al próximo hito de este reclamo",
  BUTTON_PLUS_ONE_HOUR: "+1 h",
  BUTTON_PLUS_ONE_BUSINESS_DAY: "+1 día hábil",
  BUTTON_LIVE_CLOCK: "Reloj en vivo",
  BUTTON_SLOW_LIVE_CLOCK: "Reloj en vivo lento",
  BUTTON_FIRE_TIMER_NOW: "Disparar ahora",
  BUTTON_RESET_WORLD: "Reiniciar este mundo",
  BUTTON_EXPORT: "Exportar",
  BUTTON_SEND_SCRIPT: "Mandar mensaje del guion",
  BUTTON_ATTACH_RECEIPT: "Adjuntar comprobante",
  BUTTON_UNLOCK_CHALLENGE: "Levantar el bloqueo del desafío",
  RECENT_LOGIN_TITLE: "Aprobar dinero exige un login reciente",
  RECENT_LOGIN_BODY: "Pasaron más de 15 minutos desde que ingresaste. Confirmá con tu contraseña para aprobar, responder por escrito o reiniciar el mundo: es una función, no un error.",
  RECENT_LOGIN_PASSWORD: "Contraseña",
  RECENT_LOGIN_CONFIRM: "Confirmar",
  RECENT_LOGIN_CANCEL: "Cancelar",
} as const;
export type ConsoleKey = keyof typeof CONSOLE_ES;
