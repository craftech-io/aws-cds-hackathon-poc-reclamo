// Product terms of the fictitious lender (`Reference/TERMS#v001`, docs/seed-spec.md §3): 45 clauses
// written for this product, the clauses the agent grounds every answer on (`get_terms`). The rights
// of the complaint (D-*) are our reading of the central bank's rules, not legal advice.

export interface Clause {
  readonly id: string;
  readonly topic: string;
  readonly text: string;
}

const T = (id: string, topic: string, text: string): Clause => ({ id, topic, text });

export const TERMS_VERSION = "v001";

export const CLAUSES: readonly Clause[] = [
  T("T-1.1", "Préstamo", "El préstamo personal es en pesos y se otorga a clientes con la billetera de Jarilla activa."),
  T("T-1.2", "Préstamo", "El préstamo se devuelve en 3 a 18 cuotas mensuales; nunca en un único pago."),
  T("T-1.3", "Préstamo", "Las cuotas se calculan por el sistema francés sobre el capital otorgado."),
  T("T-1.4", "Préstamo", "La cuota es fija e incluye capital, interés compensatorio e IVA sobre el interés."),
  T("T-1.5", "Préstamo", "El seguro sobre el saldo del préstamo está a cargo de Jarilla y nunca se cobra al cliente."),
  T("T-1.6", "Préstamo", "El desembolso se acredita en la billetera neto de la comisión de otorgamiento del 3 % del capital más IVA, que se cobra una sola vez."),
  T("T-2.1", "Pagos", "Las cuotas se pagan en las redes de cobro, desde la billetera o por transferencia al CVU de la billetera."),
  T("T-2.2", "Pagos", "Cada pago se imputa a la cuota pendiente más antigua del préstamo que indica el cliente."),
  T("T-2.3", "Pagos", "Cada red de cobro tiene un horario de corte: un pago posterior al corte corresponde al día hábil siguiente."),
  T("T-2.4", "Pagos", "Un pago en una red de cobro se acredita cuando la red publica su rendición del día."),
  T("T-2.5", "Pagos", "La fecha de pago que vale es la del comprobante de la red, aunque la acreditación sea posterior."),
  T("T-3.1", "Atraso", "Una cuota no pagada al vencimiento queda atrasada desde el día siguiente."),
  T("T-3.2", "Atraso", "Sobre el saldo de una cuota no pagada a su vencimiento corre un interés punitorio diario del 50 % de la tasa compensatoria."),
  T("T-3.3", "Atraso", "El interés punitorio se informa en el detalle de la cuota y en el estado de cuenta."),
  T("T-3.4", "Atraso", "Si el pago se hizo dentro de los 2 días corridos posteriores al vencimiento no corre interés punitorio, aunque la red lo rinda después."),
  T("T-3.5", "Atraso", "Jarilla nunca reclama deudas por WhatsApp; los avisos formales de deuda se envían por email."),
  T("T-4.1", "Billetera", "La billetera muestra el saldo disponible y los movimientos de los últimos 90 días."),
  T("T-4.2", "Billetera", "Cada billetera tiene un CVU propio para recibir transferencias."),
  T("T-4.3", "Billetera", "Las transferencias entre cuentas no tienen costo."),
  T("T-4.4", "Billetera", "Ante una operación que el cliente no reconoce, Jarilla puede bloquear las salidas de la billetera como protección."),
  T("T-4.5", "Billetera", "El bloqueo de salidas lo levanta solo una persona del equipo después de revisar el caso."),
  T("T-4.6", "Billetera", "La reposición de la tarjeta prepaga cuesta $ 2.500 y se cobra solo si el cliente la pidió."),
  T("T-5.1", "Débitos automáticos", "El débito automático de la cuota se hace el día del vencimiento."),
  T("T-5.2", "Débitos automáticos", "Si el débito falla por falta de saldo, se reintenta una sola vez a las 48 horas."),
  T("T-5.3", "Débitos automáticos", "Un débito duplicado de la misma cuota se reintegra a la billetera."),
  T("T-5.4", "Débitos automáticos", "El cliente puede pedir la baja del débito automático en cualquier momento."),
  T("T-6.1", "Cancelación anticipada", "El cliente puede cancelar el préstamo en forma total o parcial en cualquier momento."),
  T("T-6.2", "Cancelación anticipada", "La cancelación anticipada tiene una comisión del 2 % del capital cancelado solo si pasó menos del 25 % del plazo del préstamo."),
  T("T-6.3", "Cancelación anticipada", "La cotización de la cancelación vale hasta el fin del día hábil en que se emite."),
  T("T-6.4", "Cancelación anticipada", "Cancelado el préstamo, Jarilla emite el libre deuda sin costo."),
  T("T-7.1", "Baja de la cuenta", "La baja de la cuenta se puede pedir por cualquier canal de atención."),
  T("T-7.2", "Baja de la cuenta", "Pedir la baja es tan simple como fue el alta y no exige trámites adicionales."),
  T("T-7.3", "Baja de la cuenta", "Con un préstamo vigente, la cuenta queda en baja en curso hasta que el préstamo se cancele."),
  T("T-7.4", "Baja de la cuenta", "Jarilla confirma la baja por escrito con su número de registro."),
  T("T-8.1", "Cambio de datos", "El cambio de domicilio o de email se confirma escribiendo a la dirección vigente."),
  T("T-8.2", "Cambio de datos", "El cambio de teléfono se hace solo con la verificación de una persona del equipo."),
  T("T-8.3", "Cambio de datos", "Jarilla nunca pide claves, códigos ni documentos por chat para cambiar datos."),
  T("D-1", "Derechos del reclamo", "Todo reclamo recibe un número en el momento en que se presenta."),
  T("D-2", "Derechos del reclamo", "Jarilla responde por escrito dentro de los 10 días hábiles de presentado el reclamo."),
  T("D-3", "Derechos del reclamo", "La respuesta escrita puede llegar por email si el cliente lo acepta al presentar el reclamo."),
  T("D-4", "Derechos del reclamo", "El cliente puede pedir en cualquier momento que lo atienda una persona."),
  T("D-5", "Derechos del reclamo", "Si la respuesta no lo satisface, el cliente puede presentar su reclamo ante el Banco Central de la República Argentina."),
  T("P-1", "Datos y canales", "Jarilla nunca pide claves, PIN, códigos de verificación ni datos de tarjetas por ningún canal."),
  T("P-2", "Datos y canales", "WhatsApp se usa solo para atención: nunca para cobrar deudas ni para ofrecer productos."),
  T("P-3", "Datos y canales", "Los datos personales se usan solo para atender la cuenta y los reclamos del cliente."),
];

export const FEE_SCHEDULE_VERSION = "v001";

export interface Fee {
  readonly code: string;
  readonly concept: string;
  readonly base: string;
  readonly when: string;
  readonly clauseIds: readonly string[];
}

export const FEES: readonly Fee[] = [
  { code: "FEE-ORIG", concept: "Comisión de otorgamiento", base: "3 % del capital (+ IVA)", when: "Una vez, al desembolsar", clauseIds: ["T-1.6"] },
  { code: "FEE-PUNIT", concept: "Interés punitorio", base: "50 % de la tasa compensatoria, diario, sobre el saldo de la cuota no pagada a su vencimiento", when: "Desde el día siguiente al vencimiento, salvo la tolerancia de 2 días", clauseIds: ["T-3.2", "T-3.4"] },
  { code: "FEE-CARD-REPL", concept: "Reposición de tarjeta prepaga", base: "$ 2.500 fijo", when: "Solo si el cliente la pidió", clauseIds: ["T-4.6"] },
  { code: "FEE-EARLY", concept: "Cancelación anticipada", base: "2 % del capital cancelado", when: "Solo si pasó menos del 25 % del plazo", clauseIds: ["T-6.2"] },
  { code: "FEE-INS", concept: "Seguro sobre saldo", base: "$ 0 (a cargo del prestamista)", when: "Nunca se cobra al cliente", clauseIds: ["T-1.5"] },
];
