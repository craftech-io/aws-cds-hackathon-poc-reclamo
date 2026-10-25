# Casos de QA · convenciones

Un caso por flujo de `docs/flows-catalog.md` (128), escrito antes de construir (WP-13, FL-001 a FL-111; WP-56, FL-102 reescrito, FL-112 a FL-128 y el vocabulario `GUEST` de ADR-0019 en todos) y actualizado por WP-50 con lo que cambie al construir. Cada caso dice qué entra, qué pasos se dan, qué resultado se verifica **sin leer código**, qué oráculo se usa cuando el resultado pasa por una decisión del agente y qué evidencia se guarda. Lo que significa "100 % probada" está en `docs/test-plan.md` §1; la matriz de pruebas por flujo, en §2.2.

El catálogo y la matriz mandan. Los campos Área, Actores, Canal, Disparador y Reglas y los ids de "Pruebas que lo cubren" de cada caso salen tal cual de `docs/flows-catalog.md`; si un caso difiere del catálogo, se corrige el caso o se le pide el cambio al `architect`, nunca se prueba contra el caso.

## Estructura de un caso

| Sección | Qué lleva |
|---|---|
| Tabla inicial | Área, actores, canal, disparador y reglas del catálogo; si depende del modelo; fuentes |
| Entrada | Mundo, reloj, personas (modelo del seed y clon), datos del manifest que importan, mensajes y acciones del `QaDriver` o de la consola |
| Pasos | Lo que hace el ejecutor (o el test) en orden, con las esperas |
| Resultado esperado | Afirmaciones `R1…Rn`, cada una con **Dónde** se ve |
| Negativos | Afirmaciones `N1…Nn` que se asiertan después de la quiescencia |
| Oráculo | Hechos exigidos y alternativas aceptadas si depende del modelo; si no, por qué es determinista |
| Pruebas que lo cubren | Ids por nivel (`U`, `LF`, `UI`, `SR`, `SMK`) con lo que asierta cada uno |
| Evidencia que se guarda | Qué queda en los artefactos de la corrida y con qué id |

## Dónde se verifica

Todo resultado se ve en un lugar que no exige leer código:

| Lugar | Qué muestra |
|---|---|
| `snapshot` del `QaDriver` | Conversación, reclamos (con `statusHistory`, evidencias, acciones y aprobaciones), timers, emails con constancia, cinta, registro, uso de turnos, obligaciones disparadas y `processError` (`docs/tool-catalog.md`, "Acciones del `QaDriver`"). Los caminos `snapshot.<campo>` de los casos son indicativos: la forma exacta la fija WP-40 y WP-50 alinea los casos |
| Otras acciones del `QaDriver` | `mail.outcome`, `policyAudit.run`, `metrics.get`, `memory.inspect`, `conv.settleProbe`, `gate.probe`, `fence.probe`, `register.tamperProbe`, `probe.malwarePlan`, `dlq.find`, `alarm.history` y `console.*` (el `appRouter` real con un principal armado) |
| Consola | Las vistas de `docs/design-brief.md` §9 (`/app/inbox`, `/app/complaints/:id`, `/app/customers/:id`, `/app/approvals`, `/app/tape`, `/app/register`, `/app/emails`, `/app/simulator`, `/app/clock`, `/app/metrics`, `/app/policy`) |
| Superficies públicas | La landing (`/`), los legales (`/legal/privacy.html`, `/legal/terms.html`) y las pantallas de `docs/landing-spec.md` §9 (`/signup`, `/signup/verify`, `/signup/provisioning`, `/login`, `/login/recover`, `/login/recover/reset`), con su copy es/en |
| Acciones de alta del `QaDriver` | `guest.signup`, `guest.confirm`, `guest.resend`, `guest.session`, `guest.expireNow`, `guest.invite`, `caps.prime` y `probe.edge` (`docs/tool-catalog.md`); sus altas viven en `QASIGNUP#`, `QAPENDING#` y `QALEAD#` y sus mundos son `qa-<runId>-su*` |
| Flujo local (`LF`) | El conector en memoria y lo que graban los transportes falsos (el JSON de Meta y el MIME exactos que se mandarían) |
| Cognito falso (`UI`, `LF`) | `guests/testing/fake-cognito-idp.ts`: usuarios, estados, vencimiento de códigos y las excepciones de Cognito; el test lee el último código enviado con `lastCode(email)`, nunca por la UI |
| Unitario (`U`) | La salida de vitest de los tests con la etiqueta `[FL-xxx]` |

## Reglas de aserción

- **Nunca sobre la redacción del modelo.** Se asierta estado persistido, `kind`, `refs`, `ruleIds`, entradas del registro y de la cinta y hechos fundados (número de reclamo, montos, fechas, trazas presentes en `Runtime/…TURN#`). Las búsquedas de palabras sobre los salientes (p. ej. que ninguno diga "falso") son negativos de contenido, no comparaciones de redacción.
- **Quiescencia.** Todo negativo y toda cantidad exacta se asierta después de que `conv.settleProbe` devuelve `settled` dos veces seguidas a 10 s (`docs/test-plan.md` §4.3). Un negativo sin esa espera es un error del escenario.
- **Esperas** con `eventually()` y los topes de `docs/test-plan.md` §4.3 (acuse 10 s, turno 180 s, evento de SES 120 s, Scheduler 240 s, mundo quieto 300 s, Memory hasta 600 s, creación y reinicio de un mundo `guest` 600 s, alta → mundo `READY` 600 s).
- **Tres corridas.** Un paso que depende del modelo y no llega a 3/3 se trata como "no probado": se endurece el código que lo rodea, nunca el oráculo.
- **Cliente autopiloto.** Las respuestas del cliente en `SR` las da `scripts/scenarios/lib/autopilot.ts` según el estado persistido (desafío, nonces, pedido de comprobante); el "segundo turno" que admite un paso es solo el `ANSWER_DUE` o `RECONCILE_DUE` que encola el código.
- **Origen del bloqueo.** En todo paso con contenido hostil o bloqueado, el reporte dice de dónde vino el bloqueo (pre-filtro G1, G1 del Harness, Cedar, una cerca `LAM-*`, la política de canal, G2, la verificación, una obligación o la negativa del modelo).

## Personas, mundos y horas

- `Cnn` es la persona modelo del seed (`docs/seed-spec.md` §8); `Cnn'` y `Cnn''` son clones en mundos QA (`cus-qa-<runId>-<escenario>-<key>`, teléfono de la reserva QA, email `success+qa-…@simulator.amazonses.com` o el de `emailOverride`). Montos, códigos y fechas exactos salen del manifest del seed.
- Cada escenario usa su propio mundo `qa-<runId>-scNN` (plantilla `models`, o `guest` para `SC-21` y `SC-22`) con el reloj `PAUSED`; las altas de `SC-24` producen mundos `qa-<runId>-su*` (plantilla `guest`) creados por el aprovisionamiento real. Nunca `demo`, un `gNN`, un `gs-*` ni `gtest`. `gprobe` solo se lee, por `fence.probe`. `qamin` admite la lista cerrada de acciones de `docs/tool-catalog.md`.
- Vocabulario de ADR-0019: rol `GUEST` ("Invitado" / "Guest"), plantilla `guest`, mundos `gNN`, `gtest`, `gprobe` (preaprovisionados) y `gs-*` (alta propia), usuarios `guest-NN`.
- Las horas son simuladas y en hora argentina (UTC−3), salvo que el caso diga "real". Los topes contra abuso y la identificación de 30 minutos usan el reloj real.

## Alta propia y leads

- **Direcciones**: solo sintéticas, `success+qa-<test|runId>-<n>@simulator.amazonses.com`, en todos los niveles. En `SR` las usa `guest.signup` (el servicio acepta el simulador solo con el principal `qa`). En `LF` y `UI` el alta entra por el camino público con un doble del puerto de dominio del email que acepta solo ese dominio y no consulta DNS; la política real del dominio (ASCII, reservados, simulador solo para `qa`, descartables, MX o A) la prueba `guests/email-domain.test.ts`.
- **Contraseñas y códigos**: la contraseña la genera cada test y nunca se imprime; el código lo lee el test del Cognito falso (`lastCode`) o lo reemplaza `AdminConfirmSignUp` en `SR`; ninguno de los dos va a la evidencia.
- **Leads**: el email de un lead es PII: nunca en logs, `AuditLog`, snapshots de tests, reportes ni capturas. Los leads de QA (`QALEAD#`) nunca se avisan ni se exportan.
- **Reloj real**: los topes de alta, recuperación, cupo y vencimiento se prueban con el reloj real inyectado; avanzar el reloj del mundo nunca abre un balde nuevo.

## Superficies públicas

- Playwright con el Chrome instalado (`E2E_BROWSER_CHANNEL=chrome`, nunca se descargan navegadores) en 390×844 y 1440×900 (la landing además en 360×800), `es` y `en`, y la landing con `prefers-reduced-motion: reduce`; las capturas se revisan a ojo (estándar `poc-landing` §6, `docs/landing-spec.md` §10).
- El copy esperado sale de `docs/landing-spec.md` §2 y §9, con los reemplazos de ADR-0021 (un solo CTA "Probar Reclamo en regla", "Hablemos" al formulario de contacto de Craftech con UTM, sin "Pedí acceso").
- Ningún caso usa una palabra de la lista pública de ADR-0019 en el texto esperado de una superficie, ni la repite: la lista vive en ADR-0019 y en el guard (FL-128).
- Lo que §10 de la spec marca como no automatizado (contraste AA, LCP, copy fuera de alcance) y la revisión con mirada de cliente potencial van en la descripción del PR del WP que cierra la superficie.

## Oráculo

"Depende del modelo: Sí" quiere decir que algún paso `SR` que prueba el flujo necesita una decisión del agente para llegar al estado que se asierta. El oráculo copia la fila de `docs/test-plan.md` §4.3 (hechos exigidos y alternativas aceptadas) y, si el paso todavía no tiene fila, lo dice y queda pedido al `architect`. Un flujo sin oráculo es determinista: la tabla dice por qué.

## Evidencia

- Vive en los artefactos de la corrida de CI (`scenario-report.json` y `.md`, reporte de Playwright, salida de vitest), **nunca** en el repo. `tests/evidence/` no se commitea.
- Se identifica por el caso y la afirmación (`FL-017/R3`, `FL-111/N2`) y por el paso (`SC-01/6`).
- Sin PII ni secretos: sin HAR, sin encabezados HTTP, sin cookies de WAF, sin tokens ni `sessionToken`, sin contraseñas, códigos de verificación ni emails de leads, sin cuerpos crudos de SNS ni MIME completos (del email se guarda el `mailId`, el SHA-256, los adjuntos y los eventos), sin campos leídos de un comprobante en claro, con teléfonos, emails, CVU y documentos enmascarados como en la consola.
- Capturas de Playwright solo con datos sintéticos y trazas apagadas salvo `E2E_TRACE=1`.

## Cuándo corre cada nivel

| Nivel | Cuándo |
|---|---|
| `U`, `LF` | `npm test`, en cada PR y en CI |
| `UI` | `npm run test:ui`, en CI |
| `SR` | Suite completa por `workflow_dispatch` de `.github/workflows/scenarios.yml`, precedida por el subconjunto `SR` de `EV-2` |
| `SMK` | `SC-00` en cada deploy |

## Índice

### A · Identificación y conversación

- [FL-001 · Primer mensaje: presentación como asistente automatizado](FL-001.md)
- [FL-002 · Número no vinculado](FL-002.md)
- [FL-003 · Desafío de identidad superado](FL-003.md) · oráculo
- [FL-004 · Dos fallos del desafío: verificación humana](FL-004.md) · oráculo
- [FL-005 · Cliente con dos préstamos](FL-005.md) · oráculo
- [FL-006 · Opt-out y "baja" ambigua](FL-006.md)
- [FL-007 · Cliente sin opt-in: respuestas en ventana, novedades por email](FL-007.md)

### B · Consulta, reclamo y registro

- [FL-008 · Consulta respondida en el acto (no se registra)](FL-008.md) · oráculo
- [FL-009 · Consulta que requiere gestión: registrada con número](FL-009.md) · oráculo
- [FL-010 · Reclamo: número en el acto](FL-010.md)
- [FL-011 · Aceptación del email y acuse por email](FL-011.md)
- [FL-012 · El agente registra lo que el clasificador dejó como consulta](FL-012.md) · oráculo
- [FL-013 · Mensaje repetido sobre un reclamo abierto](FL-013.md)
- [FL-014 · Registro append-only con cadena de hash anclada](FL-014.md)
- [FL-015 · El cliente desiste del reclamo](FL-015.md) · oráculo

### C · Pago no reflejado

- [FL-016 · Camino feliz: comprobante legible y lote publicado](FL-016.md) · oráculo
- [FL-017 · Lote pendiente: se concilia cuando la red rinde](FL-017.md) · oráculo
- [FL-018 · Lote publicado sin la línea: nunca se "encuentra"](FL-018.md) · oráculo
- [FL-019 · Comprobante borroso](FL-019.md) · oráculo
- [FL-020 · Comprobante falso](FL-020.md) · oráculo
- [FL-021 · El mismo comprobante en dos reclamos](FL-021.md) · oráculo
- [FL-022 · Pago ya imputado](FL-022.md) · oráculo
- [FL-023 · Pago parcial](FL-023.md) · oráculo
- [FL-024 · Pago sobre el tope del agente: aprobación](FL-024.md) · oráculo
- [FL-025 · Pago de la última cuota: libre deuda automático](FL-025.md) · oráculo
- [FL-026 · Pago por transferencia o desde la billetera](FL-026.md) · oráculo
- [FL-027 · Lectura con respaldo determinista y desacuerdo](FL-027.md) · oráculo
- [FL-028 · Inyección en la imagen del comprobante](FL-028.md) · oráculo
- [FL-029 · Imagen que no es un comprobante, formato o tamaño inválido](FL-029.md) · oráculo
- [FL-111 · Comprobante válido de otro pagador](FL-111.md) · oráculo

### D · Libre deuda

- [FL-030 · Préstamo cancelado: libre deuda por email](FL-030.md) · oráculo
- [FL-031 · Préstamo con saldo: explicación neutra](FL-031.md) · oráculo

### E · Cargos y débitos

- [FL-032 · Cargo correcto: explicación fundada](FL-032.md) · oráculo
- [FL-033 · Cargo mal cobrado dentro del tope: reversión y nota de crédito](FL-033.md) · oráculo
- [FL-034 · Cargo mal cobrado sobre el tope del agente: aprobación del operador](FL-034.md) · oráculo
- [FL-035 · Aprobación rechazada](FL-035.md) · oráculo
- [FL-036 · Monto sobre el tope del operador: solo supervisor](FL-036.md) · oráculo
- [FL-037 · Débito duplicado dentro del tope](FL-037.md) · oráculo
- [FL-038 · Débito duplicado sobre el tope](FL-038.md) · oráculo
- [FL-039 · Falso duplicado](FL-039.md) · oráculo
- [FL-040 · Tope de acciones automáticas por cliente](FL-040.md) · oráculo

### F · Transferencias y desembolsos

- [FL-041 · Transferencia completada: traza](FL-041.md) · oráculo
- [FL-042 · Transferencia pendiente: seguimiento y acreditación](FL-042.md) · oráculo
- [FL-043 · Transferencia rechazada y revertida](FL-043.md) · oráculo
- [FL-044 · Transferencia rechazada sin reversión: reversión por código](FL-044.md) · oráculo
- [FL-045 · Transferencia entrante que la red no conoce](FL-045.md) · oráculo
- [FL-046 · Desembolso acreditado](FL-046.md) · oráculo
- [FL-047 · Desembolso demorado dentro y fuera de plazo](FL-047.md) · oráculo
- [FL-048 · Desembolso fallido o retenido](FL-048.md) · oráculo

### G · Fraude, bloqueo, baja y datos

- [FL-049 · Operación desconocida: bloqueo de salidas y caso de fraude](FL-049.md) · oráculo
- [FL-050 · Pedido de desbloqueo por chat](FL-050.md) · oráculo
- [FL-051 · Cuenta bloqueada: categoría y verificación humana](FL-051.md) · oráculo
- [FL-052 · Cancelación anticipada: cotización por código](FL-052.md) · oráculo
- [FL-053 · Baja de cuenta](FL-053.md) · oráculo
- [FL-054 · Cambio de email o domicilio](FL-054.md) · oráculo
- [FL-055 · Cambio de teléfono: caso humano](FL-055.md) · oráculo

### H · Límites del agente

- [FL-056 · Fuera de alcance: crédito, refinanciación, charla general](FL-056.md) · oráculo
- [FL-057 · Asesoramiento legal o de inversión](FL-057.md) · oráculo
- [FL-058 · Inyección de instrucciones por mensaje](FL-058.md) · oráculo
- [FL-059 · El cliente manda claves, PIN o tarjeta](FL-059.md) · oráculo
- [FL-060 · "Hablar con una persona" en cualquier paso](FL-060.md)
- [FL-061 · Baja confianza o dos intentos fallidos](FL-061.md) · oráculo
- [FL-062 · Texto no fundado: `GROUNDING_FAIL`](FL-062.md)
- [FL-063 · Pregunta sobre derechos del reclamo](FL-063.md) · oráculo

### I · Política de canal

- [FL-064 · Recordatorio de mora por WhatsApp del operador: bloqueado](FL-064.md)
- [FL-065 · Reencaminamiento a aviso formal por email](FL-065.md)
- [FL-066 · Reencaminamiento a la cola humana](FL-066.md)
- [FL-067 · Texto libre del operador con contenido de cobranza](FL-067.md)
- [FL-068 · Borrador del agente con pedido de pago](FL-068.md)
- [FL-069 · Fuera de la ventana de 24 h](FL-069.md)
- [FL-070 · Horario de contacto y feriado](FL-070.md)
- [FL-071 · Máximo de contactos proactivos por día](FL-071.md)
- [FL-072 · Oferta de crédito bloqueada](FL-072.md)
- [FL-073 · Cerco de destinatarios y dominios reservados](FL-073.md)
- [FL-074 · WhatsApp proactivo sin reclamo abierto](FL-074.md)
- [FL-075 · Cinta completa y cero violaciones](FL-075.md)

### J · Reloj regulatorio

- [FL-076 · Plazo con feriados y tres hitos al registrar](FL-076.md)
- [FL-077 · Recordatorio al operador (día hábil 5)](FL-077.md)
- [FL-078 · Escalamiento al supervisor (día hábil 8)](FL-078.md)
- [FL-079 · Vencimiento sin respuesta](FL-079.md)
- [FL-080 · La respuesta escrita cancela los hitos](FL-080.md) · oráculo
- [FL-081 · Disparo tardío descartado](FL-081.md)
- [FL-082 · Reloj de demo: avanzar y modo comprimido](FL-082.md)
- [FL-083 · Cierre automático tras la respuesta](FL-083.md)

### K · Humano en el circuito

- [FL-084 · Tomar conversación](FL-084.md)
- [FL-085 · El operador escribe en el hilo](FL-085.md)
- [FL-086 · Devolver al agente](FL-086.md) · oráculo
- [FL-087 · Aprobación ejecutada por código](FL-087.md) · oráculo
- [FL-088 · El agente no puede aprobar](FL-088.md) · oráculo
- [FL-089 · Respuesta escrita del operador en un caso humano](FL-089.md)

### L · Email y constancia

- [FL-090 · Constancia de entrega](FL-090.md) · oráculo
- [FL-091 · Rebote del email](FL-091.md) · oráculo
- [FL-092 · Queja del destinatario](FL-092.md) · oráculo
- [FL-093 · Visor de emails: render exacto](FL-093.md)

### M · Consola, cumplimiento y métricas

- [FL-094 · Login propio, roles y tokens de 15 minutos](FL-094.md)
- [FL-095 · Cumplimiento solo lectura](FL-095.md)
- [FL-096 · Exportación del registro verificable](FL-096.md)
- [FL-097 · Bandeja con plazos](FL-097.md)
- [FL-098 · Métricas con N, fuente y rótulo](FL-098.md)
- [FL-099 · Aislamiento entre mundos](FL-099.md) · oráculo
- [FL-100 · Reiniciar un mundo](FL-100.md) · oráculo
- [FL-101 · Simulador de teléfono](FL-101.md) · oráculo
- [FL-102 · Landing comercial bilingüe y legales](FL-102.md)

### N · Canal vivo y robustez

- [FL-103 · WhatsApp vivo: entradas, salidas y estados](FL-103.md)
- [FL-104 · Modos de canal por mundo](FL-104.md)
- [FL-105 · Topes de costo y volumen](FL-105.md)
- [FL-106 · Mensaje duplicado (entrante y saliente)](FL-106.md)
- [FL-107 · Falla o silencio del turno: fallback y obligaciones](FL-107.md) · oráculo
- [FL-108 · Evento en la DLQ](FL-108.md)
- [FL-109 · Corte del agente](FL-109.md)
- [FL-110 · Guards de CI: sin recepción SES, punto único de salida, términos prohibidos](FL-110.md)

### O · Superficies públicas, alta propia e invitados

- [FL-112 · Alta de invitado: formulario, consentimientos y pedido de alta](FL-112.md)
- [FL-113 · Código de verificación: confirmación, lead y pedido de mundo](FL-113.md)
- [FL-114 · Reenvío del código](FL-114.md)
- [FL-115 · Código incorrecto o vencido](FL-115.md)
- [FL-116 · Email ya registrado](FL-116.md)
- [FL-117 · Cupo de mundos de invitado completo: cola](FL-117.md)
- [FL-118 · Alta frenada por tasa](FL-118.md)
- [FL-119 · Bot bloqueado](FL-119.md)
- [FL-120 · Mundo de invitado: preparando y listo](FL-120.md)
- [FL-121 · Ingreso de un invitado](FL-121.md)
- [FL-122 · Recuperación de contraseña](FL-122.md)
- [FL-123 · Salir](FL-123.md)
- [FL-124 · Vencimiento del mundo de invitado y recreación al volver](FL-124.md)
- [FL-125 · Límites de uso del mundo de invitado](FL-125.md)
- [FL-126 · Aviso de lead a Craftech](FL-126.md)
- [FL-127 · Exportación y borrado de leads](FL-127.md)
- [FL-128 · Superficies neutrales](FL-128.md)
