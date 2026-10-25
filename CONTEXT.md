# Reclamo en regla (aws-cds-hackathon-poc-reclamo)

Agente de reclamos regulados para prestamistas de consumo y billeteras de Latinoamérica. Un cliente escribe por WhatsApp cualquier reclamo sobre su cuenta y sus operaciones; el agente le da el número de reclamo en el acto, lo investiga contra los sistemas (simulados) del prestamista, resuelve lo que la política permite, manda la respuesta escrita por email con constancia de entrega y deriva el resto a una persona con el plazo regulatorio corriendo. Un motor de política de canal evalúa cada mensaje saliente y bloquea la cobranza por WhatsApp.

Este glosario fija la palabra que se usa en documentos y textos públicos (español) y el identificador que se usa en código (inglés). Si una palabra no está acá, no se inventa: se agrega acá primero. Formato de cada entrada: **término** (`Identificador`): definición. _Avoid_: sinónimos que no se usan.

## Language

### Organización, personas y roles

**Prestamista** (`Lender`):
La empresa que presta y opera la billetera. En la POC es una sola y es **ficticia**: **Jarilla — préstamos y billetera** (nombre verificado por búsqueda web el 2026-09-26, `docs/seed-spec.md` §2). Se rotula "ficticio" en la landing.
_Avoid_: banco, entidad (en UI), fintech (en UI), cliente (el cliente es la persona)

**Cliente** (`Customer`):
Persona humana usuaria de servicios financieros del prestamista: tiene una **cuenta**, una **billetera** y cero o más **préstamos**. Habla español rioplatense. En la demo es una **persona** sintética.
_Avoid_: usuario (en UI), deudor, titular (solo en PDFs formales)

**Operador** (`Staff`, rol `OPERATOR`):
Persona del equipo de atención que usa la consola: bandeja, casos, toma de conversación, respuestas escritas y aprobaciones hasta su **tope de política**.
_Avoid_: agente (es el software), asesor, ejecutivo

**Supervisor** (`Staff`, rol `SUPERVISOR`):
Operador con aprobación por encima del tope del operador; recibe los escalamientos del hito `SUPERVISOR_ESCALATION`.
_Avoid_: jefe, líder

**Oficial de cumplimiento** (`Staff`, rol `COMPLIANCE`):
Rol de solo lectura: cinta de cumplimiento, registro de reclamos y su exportación, bloqueos de política, visor de emails, métricas. Ningún procedimiento de escritura lo acepta.
_Avoid_: auditor, compliance (en UI)

**Invitado** (`Staff`, rol `GUEST`):
Quien prueba el producto en su propio **mundo**, con los permisos de operador, supervisor y cumplimiento **dentro de ese mundo**, que no puede cambiar: el mundo sale de su fila de staff, no de un atributo editable, y su access token no puede cambiar la cuenta. En la UI, "Invitado" / "Guest". Tiene dos orígenes, que salen del id del mundo: **preaprovisionado** (cuentas `guest-NN` compartibles, sin email, mundos `gNN`; las crea el operador con `console:invite -- --guest <n>` y el mundo queda `READY` antes de entregar la credencial; son las que reciben los evaluadores por las instrucciones privadas de la submission) y **de alta propia** (cuenta personal creada en `/signup` con email verificado, mundo `gs-*` que se prepara después de la confirmación y vence; ver **alta**). El login de un invitado preaprovisionado nunca crea un mundo; el de uno de alta propia tampoco: solo lo pide de nuevo si venció.
_Avoid_: jurado, juez, evaluador (en UI y en código), demo user, tester

**Alta** (`Signup`):
Creación de una cuenta de invitado por el propio visitante: email y contraseña (nombre, empresa y cargo opcionales), dos consentimientos separados y sin tildar (términos y privacidad, obligatorio; contacto de Craftech, opcional), código de verificación por email y confirmación. Pasa **siempre por el BFF** (`signup.start`, `signup.confirm`, `signup.resend`, en `/api/public/*`) con un cliente confidencial de Cognito; nunca crea un rol interno. La confirmación queda atada al formulario que la inició (`signupId`). Una cuenta por email. Toda alta confirmada es también un **lead**. Está **abierta** al público con los topes de ADR-0020 (ADR-0021); solo la cierran el operador o el corte `KILL#SIGNUP`, y entonces `/signup` muestra un aviso fijo con "Hablemos".
_Avoid_: registro (en código), sign-up (en UI es-AR), onboarding

**Pedido de alta** (`SignupRequest`):
Fila `Leads/SIGNUP#<signupId>` que escribe el BFF antes de crear el usuario de Cognito, con los consentimientos, los datos del lead, UTM y referrer. Por email vale un solo pedido (`PENDING#`, el último formulario): el trigger pre-sign-up, la confirmación y el reenvío solo aceptan ese, y un alta sin confirmar del mismo email se reemplaza. Vence a las 48 h reales.

**Lead** (`Lead`):
Contacto comercial de Craftech que deja una alta confirmada: email, datos opcionales, consentimientos con fecha y versión del texto, POC de origen, idioma, UTM y referrer, fecha de alta y último ingreso. Vive en la tabla `Leads`, separada de los datos de la demo; sobrevive al vencimiento del mundo; es PII (fuera de logs, cinta, auditoría y exportaciones de la demo); se exporta con `leads:export` y se borra a pedido con `leads:delete`. Craftech es el responsable de esos datos.
_Avoid_: usuario, cliente (el cliente es la persona sintética del prestamista), prospecto (en código)

**Mundo de invitado** (`GuestWorld`):
Mundo de clase `GUEST` sembrado desde la plantilla `guest` (igual a `demo`, WhatsApp siempre simulado). Preaprovisionado: `g01`..`g99` y `gtest`, sin vencimiento. De alta propia: `gs-<10 base32>` (sufijo derivado de la cuenta), pedido por el trigger post-confirmation con un ticket `PROVISIONREQ#` que consume la fábrica de mundos; mientras espera o se crea, la consola muestra "Estamos preparando tu mundo". Estados de un `gs-*`: `REGISTERED` (en cola) → `CREATING` → `READY` → `EXPIRING` → `EXPIRED`, y de nuevo `REGISTERED` cuando el invitado vuelve.

**Vencimiento del mundo de invitado** (`GuestWorldTtl`):
Un mundo de alta propia se borra (sin tocar la cuenta, el lead, el registro, la cinta ni la bitácora) a las **6 h reales** desde que quedó `READY` si nunca se ingresó, a las **72 h reales sin actividad** o a los **7 días reales** desde que quedó `READY`, lo que pase primero, y queda `EXPIRED`. Al volver a ingresar, se recrea con una época nueva. Los mundos preaprovisionados no vencen.
_Avoid_: TTL (en UI), caducidad

**Cupo de mundos de invitado** (`GuestCapacity`):
Tope de mundos de alta propia activos a la vez (40, con 3 creaciones simultáneas). Con el cupo lleno, una alta igual se confirma y su mundo espera en cola hasta que otro venza.

**Límites de uso del invitado** (`GuestUsageLimits`):
Topes con el reloj real de un mundo de alta propia (turnos del agente, lecturas de imagen, emails, reinicios; ADR-0020) y del pool global `SIGNUP` (por minuto, hora y día, y de lecturas de imagen), que se miran antes de toda llamada que cuesta; sus turnos corren en su propia cola y worker. Al alcanzarlos, el invitado ve un aviso fijo y el agente deriva a una persona, como con cualquier tope.

**Agente** (`Agent`):
El asistente automatizado (Harness de AgentCore + tools). La presentación como asistente automatizado de Jarilla la pone el código en el primer saliente de cada conversación (**aviso de automatización**), y cada mensaje ofrece la derivación: botón interactivo "Hablar con alguien" (el tope de Meta para un botón de respuesta es 20 caracteres) y "Hablar con una persona" en plantillas y filas de lista.
_Avoid_: bot (en UI), IA (en UI), asistente virtual genérico

**Emisor** (`Sender`):
Quién origina un mensaje saliente: `AGENT`, `OPERATOR:<staffId>` o `SYSTEM` (textos deterministas). Todo emisor pasa por la misma **compuerta de salida**.

### Cuenta, préstamos y dinero

**Cuenta** (`Account`):
Relación del cliente con el prestamista: datos de contacto, estado (`ACTIVE`, `BLOCKED`, `CLOSING`, `CLOSED`), motivo de bloqueo por categoría y la billetera asociada.
_Avoid_: ficha, perfil

**Billetera** (`Wallet`):
Cuenta de pago del cliente dentro del prestamista, con saldo en pesos, movimientos y un **CVU sintético**. Puede tener **bloqueo de salidas**.
_Avoid_: cuenta virtual, monedero

**CVU sintético** (`syntheticCvu`):
Identificador de 22 dígitos con forma de CVU que empieza siempre con `9990` (ningún proveedor real lo usa) y se muestra enmascarado (`•••• 4821`). Rotulado "sintético".
_Avoid_: CBU, alias

**Préstamo** (`Loan`):
Préstamo personal en pesos a **3 a 18 cuotas** mensuales (nunca de un solo pago), con estado `ACTIVE`, `IN_ARREARS`, `CANCELLED` (pagado del todo) o `EARLY_CANCELLED`.
_Avoid_: crédito (en código), adelanto

**Cuota** (`Instalment`):
Vencimiento mensual de un préstamo: número, fecha de vencimiento, capital, interés, IVA sobre interés, importe, saldo pendiente y estado (`DUE`, `PAID`, `PARTIALLY_PAID`, `OVERDUE`).
_Avoid_: pago (el pago es el dinero que entra)

**Pago** (`Payment`):
Dinero que el cliente pagó para una cuota: por una **red de cobro**, por **transferencia** o desde la billetera. Tiene código de operación, fecha, monto y canal.
_Avoid_: cobro (cobro es lo que hace el prestamista)

**Imputación** (`Allocation`):
Aplicación de un pago a una o más cuotas por el **core**. Ocurre una sola vez por código de operación (**claim de clave natural**) y está sujeta a un **tope de política**.

**Claim de clave natural** (`ActionClaim`):
Item condicional del core (`OPC#`, `REV#`, `RFD#`, `TRV#`) que se escribe en la misma transacción que mueve el dinero: una imputación por código de operación, una reversión por cargo, un reintegro por débito, una reversión por transferencia, sin importar cuántos reclamos, aprobaciones o reintentos haya. Un segundo intento devuelve `CONFLICT` con la acción existente.
_Avoid_: acreditación (se usa para billetera), asiento

**Comprobante** (`Receipt`):
Imagen que manda el cliente como prueba de pago. Se lee (Bedrock multimodal o parser de respaldo) pero **nunca prueba nada por sí sola**: prueba la línea de la **rendición**. Variantes sintéticas: legible, borroso, falso.
_Avoid_: ticket, voucher, recibo (recibo es el PDF que emitimos)

**Código de operación** (`operationCode`):
Identificador del pago impreso en el comprobante y presente en la rendición, con dígito verificador (`NTE-20261006-004817-7`). Único por red.

**Red de cobro** (`CollectionNetwork`):
Red de pago presencial simulada donde el cliente paga su cuota. Hay dos: **Red de cobro Norte** (`NORTE`, rinde D+1 hábil a las 08:30, corte 18:00) y **Red de cobro Sur** (`SUR`, rinde D+2 hábiles a las 11:00, corte 16:00). Nombres neutros, ficticios.
_Avoid_: cualquier marca real de redes de cobro

**Archivo de rendición** (`SettlementFile`):
CSV que publica una red de cobro en S3 con las cobranzas de un día hábil (una línea por pago con código, fecha, monto, referencia de cliente). Es la fuente de verdad de la conciliación.
_Avoid_: extracto, liquidación

**Lote pendiente** (`PendingBatch`):
Rendición que todavía no se publicó para una fecha de cobro. Un pago de esa fecha no se puede conciliar aún: el reclamo queda `AWAITING_SETTLEMENT`; la **publicación** del lote reabre la conciliación en el mismo avance del reloj (el timer `SETTLEMENT_RECHECK` queda como red de seguridad).

**Conciliación** (`Reconciliation`):
Comparación determinista entre lo leído del comprobante y la rendición publicada: `MATCHED` (código, monto, fecha **y** línea del mismo cliente y de uno de sus préstamos), `PAYER_MISMATCH` (la línea o la imputación es de **otro** cliente: nada se imputa, nada se dice del otro pagador, caso humano), `ALREADY_APPLIED` (imputado al mismo cliente), `PENDING_BATCH`, `NOT_FOUND`, `AMOUNT_MISMATCH`.

**Transferencia** (`Transfer`):
Movimiento de dinero entrante o saliente de la billetera por la **Red de transferencias** (simulada), con estado `COMPLETED`, `PENDING`, `REJECTED_REVERSED` o `REJECTED_NOT_REVERSED`.

**Traza** (`traceId`):
Identificador que asigna la Red de transferencias a una transferencia completada; se le informa al cliente como prueba.

**Desembolso** (`Disbursement`):
Acreditación en la billetera del capital de un préstamo aprobado (neto de la comisión de otorgamiento). Estados `PENDING`, `CREDITED`, `FAILED_RETURNED`, `HELD_REVIEW`.

**Cargo** (`Charge`):
Todo débito del prestamista que no es capital: comisiones, interés punitorio, seguro. Cada cargo tiene un código del **cuadro de tarifas**.

**Comisión** (`Fee`):
Cargo con importe o porcentaje fijado en el **cuadro de tarifas** sintético (`FEE-ORIG`, `FEE-CARD-REPL`, `FEE-EARLY`, …).
_Avoid_: gasto, arancel

**Cuadro de tarifas** (`FeeSchedule`):
Documento sintético versionado con cada comisión y cargo, su base de cálculo y cuándo corresponde. Escrito para la POC; lo usa `check_charge` y el grounding.

**Condiciones del producto** (`ProductTerms`):
Documento sintético versionado de cláusulas numeradas (`T-4.2`) sobre préstamos, billetera, cancelación anticipada, baja y reclamos. Se cita por id de cláusula.

**Reversión** (`Reversal`):
Devolución por código de un cargo mal cobrado, con interés compensatorio calculado con una tasa de referencia sintética (rotulada supuesto). Genera una **nota de crédito**.

**Nota de crédito** (`CreditNote`):
PDF que documenta una reversión o un reintegro; va adjunto a la respuesta escrita.

**Reintegro** (`Refund`):
Devolución a la billetera de un importe cobrado de más (por ejemplo, un **débito duplicado**). Se asienta en el **registro de reintegros**.

**Débito duplicado** (`DuplicateDebit`):
Dos débitos automáticos de la misma cuota (mismo préstamo, misma cuota, mismo importe, dentro de 72 h) detectados por código.

**Libre deuda** (`PayoffCertificate`):
Certificado PDF de cancelación de un préstamo `CANCELLED` o `EARLY_CANCELLED`. Nunca se emite con saldo pendiente.
_Avoid_: certificado de deuda cero

**Cancelación anticipada** (`EarlyPayoff`):
Pago total antes del último vencimiento. La **cotización** (`PayoffQuote`) la calcula el core: capital pendiente + interés devengado a la fecha + comisión si corresponde, válida hasta el fin del día hábil.

**Baja** (`AccountClosure`):
Pedido del cliente de cerrar su cuenta. Es un derecho: se registra en el acto, tan simple como el alta, y se confirma por email. Nunca se usa "baja" para dejar de recibir mensajes (eso es **opt-out**).

**Bloqueo de salidas** (`OutgoingFreeze`):
Medida de protección que impide transferencias salientes y pagos desde la billetera. El agente la puede activar ante una posible operación desconocida; **solo una persona** la levanta.

**Core** (`Core`):
Sistema simulado del prestamista (`CoreMock`): clientes, cuentas, préstamos, cuotas, pagos, movimientos, cargos, desembolsos. Se consulta por un contrato HTTP con SigV4.

### Reclamos y registro

**Presentación** (`Presentation`):
Todo contacto del cliente que pide algo. Es una **consulta** o un **reclamo**.

**Consulta** (`kind CONSULTA`):
Pregunta que se responde con información (saldo, próximo vencimiento, cronograma). Si se responde en el acto **no se registra**; si requiere análisis o gestión, se registra con número (nuestra lectura del punto 3.1.3 de las normas de protección de usuarios del BCRA).

**Reclamo** (`kind RECLAMO`):
Queja por presunto incumplimiento, prestación defectuosa o falta de prestación (pago no reflejado, cargo no reconocido, transferencia no acreditada, …). **Siempre se registra**, aunque se resuelva en el acto.
_Avoid_: queja, ticket, incidente

**Tipo de reclamo** (`ComplaintType`):
`PAYMENT_NOT_REFLECTED`, `PAYOFF_CERTIFICATE`, `UNRECOGNIZED_CHARGE`, `DUPLICATE_DEBIT`, `TRANSFER_NOT_CREDITED`, `DISBURSEMENT_NOT_RECEIVED`, `UNKNOWN_OPERATION`, `ACCOUNT_BLOCKED`, `CLOSURE_OR_EARLY_PAYOFF`, `DATA_CHANGE` y, solo para una consulta registrada, `INFORMATION_REQUEST`. Lo fuera de alcance no es un tipo: se rechaza.

**Número de reclamo** (`complaintNumber`):
`R-AAAA-NNNNNN`, correlativo por mundo y año, asignado por código al registrar la presentación (consulta registrada o reclamo) en la misma transacción que su entrada `FILED` (sin huecos) y comunicado **en el acto**.
_Avoid_: ticket, id, caso (en UI)

**Registro de reclamos** (`ComplaintRegister`):
Base única y append-only de presentaciones registradas: número, fecha, canal, motivo, documento del presentante (del core, enmascarado en pantalla), estado y respuesta. Cada entrada es un evento con `seq`, `prevHash` y `hash` (cadena de hash) y un **ancla** fuera de las tablas. IAM bloquea actualizar y borrar; una sobrescritura no se impide, **se detecta** en toda entrada anclada. Se exporta con el resultado de la verificación: `ok`, `partial` (hay entradas sin ancla, que se muestran sin verificar) o `broken`.

**Ancla** (`RegisterAnchor`):
Copia de `{worldId, epoch, seq, hash}` de cada entrada del registro, del registro de reintegros y de la cinta en un log group append-only que ningún rol del app puede borrar ni recortar. La escribe solo `AnchorWriter`, releyendo la entrada ya guardada. Vale la **primera ingerida** de cada `seq` (orden por `ingestionTime`, nunca por el `timestamp` que elige quien escribe); dos anclas distintas del mismo `seq` son un **conflicto de ancla** (`ANCHOR_CONFLICT`), que cuenta como rotura. Es lo que delata una entrada sobrescrita aunque quien la sobrescribió recalcule los hashes y agregue un ancla atrasada.
_Avoid_: libro de quejas, log

**Registro de reintegros** (`RefundRegister`):
Registro append-only de importes reintegrados (reversiones y reintegros), con cliente, causa y producto.

**Respuesta escrita** (`FormalAnswer`):
Carta PDF con la resolución del reclamo, enviada por email (SES) al email que el cliente aceptó como canal de respuesta, con adjuntos que decide el código (libre deuda, nota de crédito, estado de cuenta). Enviarla **detiene el plazo**.
_Avoid_: respuesta (sola), resolución (es el contenido, no el envío)

**Aceptación del canal email** (`emailAnswerConsent`):
Confirmación del cliente, al iniciar el reclamo, de que la respuesta escrita le llegue por email a la dirección registrada.

**Acuse de recibo** (`Acknowledgement`):
Mensaje de WhatsApp (`COMPLAINT_ACK`) y email (`ACK_EMAIL`, con PDF) con el número, el tipo y el vencimiento, que sale al registrar.

**Constancia de entrega** (`DeliveryProof`):
Evidencia del envío de un email: `SENT` (aceptado por SES), `DELIVERED`, `BOUNCED`, `COMPLAINED`, `REJECTED`, tomada de los eventos del configuration set. Se muestra junto a la respuesta escrita.

**Plazo** (`deadline`):
Fin del **décimo día hábil** posterior al día de la presentación (el día de la presentación no cuenta), calculado con la tabla de **feriados**. Se muestra como fecha y días hábiles restantes.

**Día hábil** (`businessDay`):
Lunes a viernes que no es feriado nacional ni día no laborable según `Reference/HOLIDAY#AR`.

**Feriado** (`Holiday`):
Fecha de la tabla de feriados nacionales y días no laborables de Argentina (`docs/seed-spec.md` §11). Los días no laborables cuentan como no hábiles (supuesto declarado).

**Hito** (`SlaMilestone`):
Momento del plazo con un timer propio y un schedule propio: `OPERATOR_REMINDER` (día hábil 5, 10:00), `SUPERVISOR_ESCALATION` (día hábil 8, 10:00) y `DEADLINE` (día hábil 10, 23:59). Se cancelan al enviar la respuesta escrita; un disparo tardío se descarta.

**Estado del reclamo** (`ComplaintStatus`):
`REGISTERED`, `INVESTIGATING`, `AWAITING_CUSTOMER`, `AWAITING_SETTLEMENT`, `AWAITING_NETWORK` (espera un cambio de la red de transferencias o del desembolso), `AWAITING_APPROVAL`, `HUMAN_REVIEW`, `RESOLVED`, `ANSWERED`, `CLOSED`. Transiciones permitidas en `complaints/state-machine.ts`, con escritura condicional por `version`. Solo `AWAITING_CUSTOMER` espera al cliente.

**Resultado** (`ComplaintOutcome`):
`IN_FAVOUR`, `PARTIALLY_IN_FAVOUR`, `NOT_IN_FAVOUR`, `INFORMATIONAL`, `WITHDRAWN`.

**Estado del plazo** (`slaState`):
`ON_TIME`, `AT_RISK` (pasó el hito de supervisor), `OVERDUE` (venció sin respuesta escrita).

**Caso humano** (`HumanCase`):
Reclamo en `HUMAN_REVIEW`: lo sigue un operador con el plazo corriendo. Motivos (`HandoffReason`): `CUSTOMER_ASKED`, `LOW_CONFIDENCE`, `TWO_FAILED_ATTEMPTS`, `FRAUD`, `ABOVE_CAP`, `IDENTITY_VERIFICATION`, `RECEIPT_NOT_FOUND`, `RECEIPT_DOUBT`, `ACCOUNT_BLOCKED`, `RISKY_DATA_CHANGE`, `EMAIL_UNDELIVERABLE`, `GUARDRAIL_BLOCK`, `OTHER`.
_Avoid_: ticket, derivación (en código)

**Evidencia** (`Evidence`):
Lo que sostiene una decisión: lectura del comprobante, línea de la rendición, estado de la red, cláusula de las condiciones, cálculo del core. Se muestra en el caso.

**Tope de política** (`PolicyCap`):
Límite en pesos, decidido en código y configurable por mundo, por encima del cual una acción no la hace el agente: `agent` (automático), `operator` (aprobación de operador) y por encima `supervisor`. Existe por tipo de acción (`APPLY_PAYMENT`, `REVERSE_CHARGE`, `REFUND_DUPLICATE`, `TRANSFER_REVERSAL`).

**Aprobación del operador** (`Approval`):
Pedido del agente (`request_operator_approval`) para una acción sobre su tope; la decide una persona en la consola (aprobar o rechazar con motivo). La acción aprobada la ejecuta el código, nunca el modelo, releyendo la aprobación y recalculando el monto; vence a los 2 días hábiles simulados o con un cambio de época.

### Canales y política

**Canal** (`Channel`):
`WHATSAPP` o `EMAIL`. No hay SMS, RCS ni voz.

**Modo** (`ChannelMode`):
`live` o `simulated`, por canal y **por mundo** (`Worlds/…/SETTINGS.channelModes`). Email es `live` (solo salida); WhatsApp es `simulated` en todo mundo salvo los que `infra/channel-modes.ts` lista en `liveWorlds` con una aprobación explícita (`whatsappLiveApproval`, fecha y aprobador), y solo `demo` y `qa-live-*` pueden figurar: los mundos de invitado y de QA son siempre `simulated`.

**Simulador de teléfono** (`PhoneSimulator`):
Vista de la consola, con una piel de chat genérica rotulada "WhatsApp (simulado)" y sin logos de Meta, donde un invitado juega una **persona**: entra por el mismo sobre SNS (firmado) y el mismo normalizador que un evento real y muestra los salientes con la forma de WhatsApp (plantillas, botones, imágenes).

**Persona** (`Persona`):
Cliente sintético preparado para el simulador, con un escenario asignado (41, `docs/seed-spec.md` §8).

**Opt-in** (`optIn`):
Consentimiento del cliente para recibir mensajes de WhatsApp iniciados por el prestamista, con fecha, medio y versión del texto. Sin opt-in, solo se responde dentro de la ventana que abre el cliente.

**Opt-out** (`optOut`):
El cliente pide no recibir más mensajes de WhatsApp (botón o palabras `NO RECIBIR`, `STOP`). Nunca se confunde con la baja de la cuenta.

**Ventana de 24 h** (`customerServiceWindow`):
24 horas desde el último mensaje del cliente; fuera de ella, solo plantillas `UTILITY` aprobadas. Se mide con el reloj del mundo en modo `simulated` y con el reloj real en `live`.

**Plantilla** (`Template`):
Mensaje de WhatsApp `UTILITY` en `es_AR`, registrado en `Reference/TEMPLATE#WHATSAPP` y aprobado por Meta en modo `live`.

**Motor de política de canal** (`ChannelPolicyEngine`):
Módulo puro `packages/bff/src/channel-policy/` que evalúa, antes de todo saliente, las reglas `CH-*` en orden y devuelve `ALLOWED`, `BLOCKED`, `REROUTED` o `DEFERRED`. Es nuestra lectura de las reglas, no asesoramiento legal. En superficies, su resultado es la **decisión de política**.
_Avoid_: "evaluación de política" en superficies ("evaluación" es palabra de `lint:neutral-surfaces`)

**Regla** (`ChannelRule`):
Enunciado con id `CH-*` (p. ej. `CH-WA-NO-COLLECTION`), versión y parámetros configurables por mundo.

**Bloqueo** (`decision BLOCKED`):
El mensaje no sale. Se registra en la cinta con la regla y, si existe, se ofrece un **reencaminamiento**.

**Reencaminamiento** (`Reroute`):
Camino permitido que la compuerta ofrece para un mensaje bloqueado: `HUMAN_QUEUE` (tarea para una persona) o `FORMAL_EMAIL` (aviso formal por email, en horario, con identificación del acreedor y detalle de la deuda, renderizado por código). Decisión `REROUTED`.

**Diferido** (`decision DEFERRED`):
El mensaje sale más tarde (horario de contacto, tope diario) con un timer `DEFERRED_SEND`.

**Compuerta de salida** (`OutboundGate`, `sendThroughGate`):
Único punto de código por el que sale un mensaje: envío repetido → política → render → G2 → verificación → cerco → transporte → cinta.

**Envío repetido** (`replayOf`):
Un mismo WhatsApp (mismo texto, o la misma plantilla con los mismos parámetros) pedido dos veces en un turno: la compuerta devuelve el ya enviado y no sale nada más (`outbound/repeat.ts`, ADR-0021). No confundir con el claim `SEND#` de la compuerta, que cubre reintentos del mismo pedido.

**Cinta de cumplimiento** (`ComplianceTape`):
Registro append-only de cada decisión de la compuerta (y del resultado de cada envío, `DISPATCH`): decisión, reglas, emisor, canal, tipo, hash del contenido, reclamo y reencaminamiento, encadenado y anclado como el registro de reclamos. Los bloqueos se ven en rojo y se cuentan en las métricas.
_Avoid_: bitácora (la bitácora es `AuditLog`, el resto de las acciones)

**Cobranza** (`Collection`):
Todo mensaje que recuerda, exige o presiona el pago de una deuda o una cuota vencida, o negocia un plan de pago. **Prohibida por WhatsApp** para cualquier emisor (`CH-WA-NO-COLLECTION`, política comercial de WhatsApp).
_Avoid_: recupero, gestión de mora (en UI)

**Cerco de destinatarios** (`RecipientFence`):
Regla dentro del cliente de SES y de WhatsApp: email solo a direcciones del simulador de buzones de SES y, **solo desde el mundo `demo`**, a destinatarios de demo registrados (≤ 5, `@craftech.io`), un único destinatario sin `Cc` ni `Bcc`; WhatsApp vivo solo a teléfonos de demo registrados y solo desde un mundo vivo.

**Aviso de automatización** (`AutomatedDisclosure`):
Línea fija de `copy/` ("Soy el asistente automatizado de Jarilla (ficticio)…") que la compuerta antepone al primer saliente de cada conversación y de cada `sessionEpoch`, lo mande quien lo mande; el mensaje queda con `flags.disclosure = true`.

### Agente y ejecución

**Turno** (`Turn`):
Una invocación del Harness por un evento de una conversación, con un `sessionToken` firmado.

**Obligación del turno** (`TurnObligation`):
Regla determinista del worker que corre al cerrar un turno: si el reclamo quedó resuelto sin respuesta escrita, encola un único turno `ANSWER_DUE`; si el turno no mandó nada ni derivó, manda un aviso fijo de espera; si hay un comprobante leído sin conciliar, concilia por código. "Segundo turno" significa solo esto.

**Lectura precargada** (`PreloadedRead`):
Lectura que todo turno necesita (`identify_customer` siempre; `get_account` y `list_operations` con la sesión identificada) y que el worker corre en paralelo, con el token del turno y las mismas cercas que una tool, **antes** de invocar el Harness; va al sobre como `<tool-result>` escapado y deja su resultado del turno como cualquier tool (ADR-0021). Existe porque el Harness ejecuta en serie las tools que pide el modelo.
_Avoid_: prefetch (en docs), caché

**Respuesta siempre** (`ALWAYS_ANSWER`):
Regla del system prompt: todo mensaje del cliente recibe respuesta, derivación o el pedido de lo que falta; un saludo recibe el estado breve de su cuenta y su reclamo. Le gana a cualquier nota de la memoria. La red determinista detrás es la obligación `HOLDING_NOTICE`.

**Corte del agente** (`AgentKill`):
Interruptor en runtime (`KILL#AGENT` global o por mundo) que el worker y los lectores de Bedrock miran antes de cada llamada; lo activa un supervisor del mundo `demo` o el presupuesto al 100 %, sin deploy. Con el corte, el número y el acuse siguen saliendo por reglas y el reclamo pasa a una persona. `CED-KILL-SWITCH` de Cedar es la segunda capa.

**Tope global** (`GlobalCap`):
Tope de turnos y lecturas de imagen por hora y por día **reales** sobre todos los mundos públicos juntos (y uno aparte para QA), además del tope de cada mundo.

**Clasificador de entrada** (`IntakeClassifier`):
Paso determinista-más-modelo (reglas primero; un modelo chico de la familia Haiku si no alcanzan, ADR-0016) previo al turno que decide consulta, reclamo o fuera de alcance; si es un reclamo de un teléfono vinculado, el código lo registra y manda el acuse **antes** del turno (ADR-0015).

**Desafío** (`IdentityChallenge`):
Pregunta de verificación (fecha de vencimiento o importe de la última cuota; nunca el importe si hay un comprobante adjunto) que el código compara con el core. La **respuesta** es siempre lo que escribió el cliente en un mensaje posterior al desafío enviado, nunca un valor del modelo; cada mensaje se verifica una sola vez. Dos fallos del **cliente** en 24 h reales → `LOCKED` y caso humano `IDENTITY_VERIFICATION`; ni una sesión nueva ni un reclamo nuevo reinician el conteo. La identificación vale 30 minutos reales.

**Toma de conversación** (`TakeOver`):
El operador pone `control = OPERATOR`: el agente no se invoca para esa conversación y el operador escribe en el mismo hilo (por la compuerta). **Devolver al agente** (`HandBack`) lo reanuda con un turno `OPERATOR_RELEASED`.

**Mundo** (`World`):
Copia aislada del prestamista con su reloj, sus clientes, su registro, su cinta, su memoria, sus schedules y su modo de canal: `demo` (operador, video), `gNN` (un invitado preaprovisionado), `gs-*` (un invitado de alta propia), `gtest` (verificación manual opcional), `qamin` (reinicio de QA), `gprobe` (mundo de clase invitado que nadie usa, blanco de las sondas de cerca del ejecutor), `qa-<runId>-<escenario>` (ejecutor), `qa-live-<runId>` (WhatsApp vivo en QA, solo con aprobación para vivo) y `sim-<lote>` (métricas). Toda clave de partición empieza con `W#<worldId>#`. Estados: `REGISTERED` → `CREATING` → `READY`, y `READY` → `RESETTING` → `READY` durante un reinicio (más `EXPIRING` y `EXPIRED` en un mundo de alta propia); solo un mundo `READY` acepta procedimientos de la consola, y un login nuevo salvo el de un invitado de alta propia, que entra y espera.

**Reinicio de mundo** (`reset_world`):
Vuelve un mundo a su plantilla con una época nueva. Es **asíncrono**: la consola lo pide (el mundo pasa a `RESETTING` con tumba y ticket) y `WorldJanitor` hace el trabajo por fases reanudables, dejando `READY` al final. Nunca borra la fila del mundo, sus ajustes ni su staff, ni el registro, la cinta o la bitácora.

**Origen** (`origin`):
`SEED` (reclamo sembrado por la plantilla) o `LIVE` (creado en el mundo después de `create_world`). Un KPI rotulado "medido" solo cuenta reclamos `LIVE`.

**Época** (`worldEpoch`):
Contador que sube en cada reinicio del mundo y nunca vuelve atrás; entra en los ids de sesión, actor de Memory y partición del registro.

**Reloj de demo** (`WorldClock`):
Reloj simulado por mundo: `PAUSED` (por defecto; se mueve con "Avanzar al próximo evento", "Avanzar al próximo hito de este reclamo", "+1 h", "+1 día hábil"), o `RUNNING` con un **factor de compresión** (`rate`, segundos simulados por segundo real, de 1 a 2.880). La historia de 10 días hábiles se ve en minutos. Los topes contra abuso usan el reloj **real**, no este.

**Timer** (`Timer`):
Item `Timers/W#<worldId>#TIMER#<kind>#<id>` con `dueAtSim`, dueño, estado y versión: todo lo que pasa a una hora simulada (hitos, envíos diferidos, publicación de rendiciones, rechequeos, cambios de estado de la red). Se procesa siempre a su hora simulada (`eventAtSim = dueAtSim`), aunque el Scheduler llegue tarde.

**Disparo tardío** (`LateFire`):
Un schedule que llega cuando su timer ya no está `SCHEDULED`, tiene otra versión o pertenece a otra época: se descarta y se audita `LATE_FIRE_DISCARDED`. Su contracara es el **disparo adelantado** (`EARLY_FIRE_DISCARDED`): un disparo para un mundo en pausa o que, según el reloj y el timer guardados, no vence dentro de 90 s; también se descarta.

**QaDriver** (`QaDriver`):
Lambda sin URL, invocable solo por el rol `qa-runner` desde CI, que maneja los escenarios en `poc` dentro de mundos `qa-*`, con su propia cola y su propia clave de sobre simulado; abre sesiones de consola efímeras (`auth.session`, re-emitibles por `sessionKey`) sin contraseñas guardadas. No llega a un mundo de invitado ni con su rol (IAM) ni a través de otra Lambda (firma por clase de mundo, reloj guardado, rol invocante, ticket de purga).

**Superficie pública** (`PublicSurface`):
Todo lo que ve alguien que no es del equipo: landing, `/signup`, `/login` y recuperación, consola, páginas legales, simulador de teléfono, visor de emails, emails (también los de Cognito), PDFs, plantillas de WhatsApp y textos del seed que ve un usuario. Es **neutral**: nunca nombra el concurso ni a quienes lo evalúan (ADR-0019, `npm run lint:neutral-surfaces`). El concurso se nombra solo en los documentos internos y en la sección "Submission notes" del README.

**Supuesto** (`assumption`):
Todo número o regla que no verificamos contra una fuente primaria: se rotula "supuesto" en la UI y en los documentos.

## Relationships

- Un **mundo** tiene un **prestamista**, un **reloj**, un **registro de reclamos**, un **registro de reintegros** y una **cinta de cumplimiento**.
- Un **cliente** tiene una **cuenta**, una **billetera** y cero o más **préstamos**; un **préstamo** tiene de 3 a 18 **cuotas**.
- Un **pago** se **imputa** a una o más **cuotas**; se prueba con una línea de un **archivo de rendición**, nunca solo con el **comprobante**.
- Una **presentación** registrada tiene exactamente un **número de reclamo**, un **plazo**, tres **hitos** y cero o más **evidencias**, **acciones**, **aprobaciones** y **respuestas escritas** (una vigente).
- Todo mensaje saliente tiene exactamente una decisión en la **cinta** (y un resultado de envío); un **bloqueo** puede tener un **reencaminamiento**.
- Toda acción de dinero ocurre a lo sumo una vez por su **clave natural**.
- Una **toma de conversación** pertenece a la conversación del cliente, no a un reclamo.
- Un **invitado** de alta propia tiene una cuenta, un **lead** y a lo sumo un **mundo de invitado** vigente; la cuenta y el lead sobreviven al **vencimiento** del mundo. Un invitado preaprovisionado tiene una cuenta compartible y un mundo que no vence.

## Example dialogue

> **Cliente:** "Pagué la cuota 4 en la Red de cobro Norte el martes a la tarde y la app me sigue marcando atrasado."
> **Sistema (acuse):** "Soy el asistente automatizado de Jarilla (ficticio). Registré tu reclamo **R-2026-000123** (pago no reflejado). La respuesta escrita te llega por email antes del **jueves 22/10**." · [Sí, a ese email] [Hablar con alguien]
> **Agente:** "Para ver tu cuenta, decime la fecha de vencimiento de tu última cuota." · [Hablar con alguien]
> **Operador (consola):** "Le mando el recordatorio de mora a la clienta del otro caso por WhatsApp."
> **Compuerta:** "BLOQUEADO · `CH-WA-NO-COLLECTION` (política comercial de WhatsApp: cobranza). Camino permitido: aviso formal por email en horario, con identificación del acreedor y detalle de la deuda."

## Flagged ambiguities

- "Baja" se usaba para dejar de recibir mensajes y para cerrar la cuenta: resuelto como **opt-out** (mensajes) y **baja** (cuenta); una palabra "baja" sola recibe dos botones para elegir.
- "Reclamo" y "caso" se mezclaban: el **reclamo** es la presentación registrada; **caso humano** es un reclamo en manos de una persona.
- "Mora" aparece en mensajes del cliente y en respuestas de servicio ("tu cuota ya no figura atrasada"): lo prohibido es la **cobranza** (pedir o presionar el pago), no la palabra.
- "Hablar con una persona" (22 caracteres) no entra en un botón interactivo de WhatsApp (tope 20): el botón interactivo dice **"Hablar con alguien"**; las plantillas (tope 25) y las filas de lista (tope 24) conservan "Hablar con una persona". El derecho es el mismo.
- "Jurado" nombraba al rol de quienes evalúan la POC: resuelto como **invitado** (`GUEST`), que no nombra el concurso y sirve igual para un prospecto; "jurado" queda solo para hablar del concurso en documentos internos (ADR-0019).
- "Alta" es la creación de una cuenta de **invitado** en el producto; en el dominio del prestamista, la contratación del cliente no es un término de este glosario (la **baja** sí). Un invitado que pide borrar sus datos pide el **borrado del lead**, nunca una "baja".
