// The intake classifier eval (`evals/classifier.json`, docs/seed-spec.md §12, `EV-3`): 120 customer
// messages written for this product (complaints of every type, on-the-spot enquiries, enquiries that
// need handling, out-of-scope requests and ambiguous messages), each with the decision expected.
import type { ComplaintType } from "@reclamo/shared";

export type ClassifierExpected = { readonly kind: "RECLAMO"; readonly type: ComplaintType } | { readonly kind: "CONSULTA"; readonly type?: "INFORMATION_REQUEST" } | { readonly kind: "OUT_OF_SCOPE" } | { readonly kind: "UNCLEAR" };

const RECLAMOS: Readonly<Partial<Record<ComplaintType, readonly string[]>>> = {
  PAYMENT_NOT_REFLECTED: [
    "Pagué la cuota en la red de cobro y en la app sigue como impaga",
    "Hice el pago el lunes y no aparece acreditado",
    "Ya pagué la cuota 5, ¿por qué figura atrasada?",
    "Pagué en efectivo en la Red de cobro Sur y no se refleja el pago",
    "Les mandé el comprobante y la cuota sigue vencida",
    "Aboné la cuota hace tres días y me siguen cobrando punitorios",
    "Pagué desde la billetera y el préstamo no se actualizó",
    "Transferí la cuota al CVU y no la imputaron",
    "Mi pago de ayer no figura en el préstamo",
    "Pagué dos cuotas juntas y solo me tomaron una",
    "Hice un pago parcial y no se descontó nada",
    "Pagué la última cuota y el préstamo sigue activo",
    "El viernes pagué en la Red de cobro Norte y todavía no impacta",
    "Tengo el ticket de pago pero la cuota figura impaga",
  ],
  PAYOFF_CERTIFICATE: [
    "Necesito el libre deuda del préstamo que cancelé",
    "¿Me pueden enviar el certificado de libre deuda?",
    "Terminé de pagar y quiero la constancia de cancelación",
    "Pedí el libre deuda hace una semana y no me llegó",
    "Necesito un comprobante de que no debo nada del préstamo",
    "Quiero el libre deuda para presentar en otro lado",
    "¿Dónde consigo la constancia de que el préstamo está saldado?",
    "Mandame el libre deuda por favor, ya pagué todo",
  ],
  UNRECOGNIZED_CHARGE: [
    "Me cobraron una comisión que no reconozco",
    "Apareció un cargo de seguro que nunca contraté",
    "Me debitaron $ 2.500 por una tarjeta que no pedí",
    "Hay un cargo en la billetera que no sé qué es",
    "Me cobraron intereses de más en la cuota",
    "Me cobraron dos veces la comisión de otorgamiento",
    "No entiendo por qué me cobraron punitorios si pagué a tiempo",
    "Me descontaron un cargo de mantenimiento que no corresponde",
    "Tengo un cargo de reposición que yo no solicité",
  ],
  DUPLICATE_DEBIT: [
    "Me debitaron dos veces la misma cuota",
    "La cuota de este mes se debitó duplicada",
    "Veo dos débitos iguales de la cuota 6",
    "Me sacaron la plata de la cuota dos veces de la billetera",
    "El débito automático se hizo doble",
    "Me cobraron la cuota el lunes y otra vez el martes",
    "Tengo un débito repetido del préstamo",
    "Se debitó la cuota y después se volvió a debitar",
  ],
  TRANSFER_NOT_CREDITED: [
    "Hice una transferencia y no le llegó a la otra persona",
    "Me transfirieron plata y no la veo en la billetera",
    "La transferencia que mandé figura pendiente desde ayer",
    "Me rechazaron una transferencia y no volvió el dinero",
    "Mandé dinero a un CVU y dicen que no lo recibieron",
    "La transferencia salió pero no se acreditó en destino",
    "Me debían transferir y no aparece nada",
    "Envié $ 30.000 y no los recibieron",
    "Tengo una transferencia rechazada que no se devolvió",
  ],
  DISBURSEMENT_NOT_RECEIVED: [
    "Me aprobaron el préstamo y no me depositaron la plata",
    "El préstamo figura aprobado pero no tengo el dinero en la billetera",
    "¿Cuándo me acreditan el préstamo que pedí ayer?",
    "Me dijeron que el desembolso estaba hecho y no lo veo",
    "Me acreditaron menos plata de la que pedí",
    "El dinero del préstamo nunca llegó",
    "Pedí el préstamo y sigue sin acreditarse",
    "Me devolvieron el desembolso y no sé por qué",
  ],
  UNKNOWN_OPERATION: [
    "Hay una transferencia que yo no hice",
    "Me sacaron plata de la billetera sin mi permiso",
    "Veo un movimiento que no reconozco",
    "Alguien usó mi cuenta para transferir",
    "Hay una compra que no hice",
    "Me robaron la plata de la billetera",
    "Apareció una operación desconocida a la madrugada",
    "No reconozco un débito de $ 80.000",
  ],
  ACCOUNT_BLOCKED: [
    "Me bloquearon la cuenta y no puedo entrar",
    "Mi billetera está bloqueada, ¿por qué?",
    "No puedo transferir, dice cuenta restringida",
    "Me suspendieron la cuenta sin aviso",
    "Mi usuario está bloqueado desde ayer",
    "No me deja operar, figura la cuenta inhabilitada",
    "Quiero que me desbloqueen la cuenta",
  ],
  CLOSURE_OR_EARLY_PAYOFF: [
    "Quiero cancelar el préstamo por adelantado",
    "¿Cuánto tengo que pagar para saldar todo hoy?",
    "Quiero dar de baja la cuenta",
    "Necesito cerrar mi cuenta de Jarilla",
    "¿Puedo pagar el préstamo entero ahora?",
    "Quiero darme de baja",
    "Quiero adelantar cuotas y cancelar el préstamo",
    "Pedí la baja de la cuenta y sigue activa",
  ],
  DATA_CHANGE: [
    "Me mudé y quiero cambiar el domicilio",
    "Quiero actualizar mi email",
    "Cambié de número de teléfono",
    "Mi dirección está mal cargada",
    "Necesito corregir mi email porque no me llegan los correos",
    "Quiero cambiar el teléfono asociado a la cuenta",
    "El domicilio que figura es el viejo",
  ],
};

const CONSULTAS: readonly string[] = [
  "¿Cuánto me falta pagar del préstamo?",
  "¿Cuándo vence la próxima cuota?",
  "¿Cuál es el saldo de mi billetera?",
  "¿Cuántas cuotas me quedan?",
  "¿De cuánto es mi próxima cuota?",
  "¿Qué tasa tiene mi préstamo?",
  "¿Cuál es mi CVU?",
  "¿En qué horario rinde la Red de cobro Norte?",
  "¿Cuánto tarda en acreditarse un pago en la red?",
  "¿En cuánto tiempo me tienen que contestar un reclamo?",
];

const INFORMATION_REQUESTS: readonly string[] = [
  "Necesito el detalle de todos los pagos del año",
  "Quiero un resumen de los movimientos de los últimos seis meses",
  "¿Me pueden mandar el historial completo de cuotas pagadas?",
  "Necesito un estado de cuenta del préstamo para presentar",
];

const OUT_OF_SCOPE: readonly string[] = [
  "¿Me dan otro préstamo?",
  "¿Puedo refinanciar mi préstamo?",
  "Quiero un préstamo más grande",
  "¿Qué me conviene, plazo fijo o dólares?",
  "¿Les puedo hacer juicio?",
  "Escribime un poema",
  "¿Quién gana el partido del domingo?",
  "¿Me recomendás un abogado?",
  "Quiero que me suban el límite",
  "¿Tienen tarjeta de crédito?",
  "¿Dónde invierto la plata?",
  "Contame un chiste",
];

const UNCLEAR: readonly string[] = ["Hola", "Buenas", "Una consulta", "Necesito ayuda", "?", "Gracias", "Ok", "Hola, ¿hay alguien?"];

export interface ClassifierEntry {
  readonly id: string;
  readonly text: string;
  readonly expected: ClassifierExpected;
}

export function classifierEval(): ClassifierEntry[] {
  const out: ClassifierEntry[] = [];
  const push = (prefix: string, texts: readonly string[], expected: ClassifierExpected): void => {
    texts.forEach((text, index) => out.push({ id: `cls-${prefix}-${String(index + 1).padStart(2, "0")}`, text, expected }));
  };
  for (const [type, texts] of Object.entries(RECLAMOS)) push(type.toLowerCase().replaceAll("_", "-"), texts ?? [], { kind: "RECLAMO", type: type as ComplaintType });
  push("consulta", CONSULTAS, { kind: "CONSULTA" });
  push("information-request", INFORMATION_REQUESTS, { kind: "CONSULTA", type: "INFORMATION_REQUEST" });
  push("out-of-scope", OUT_OF_SCOPE, { kind: "OUT_OF_SCOPE" });
  push("unclear", UNCLEAR, { kind: "UNCLEAR" });
  return out;
}
