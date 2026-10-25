# CLAUDE.md — aws-cds-hackathon-poc-reclamo

Instrucciones estrictas para Claude Code en este repositorio. No es documentación para humanos.

Este repositorio es la submission de Craftech a la **AWS CDS Agentic AI Partner Hackathon** (cierre 2026-10-28 13:00 PT), pero lo que se publica es **un producto para un cliente futuro** (un prestamista de consumo o una billetera regulada de Latinoamérica), agnóstico al concurso (ADR-0019). Lo van a leer y probar prospectos y evaluadores que no estuvieron en ninguna conversación. Escribí para ellos.

## Qué es

**Reclamo en regla** · "a regulated-complaints agent for consumer lenders and wallets in Latin America". Un cliente de un prestamista con billetera **ficticio** (**Jarilla — préstamos y billetera**) escribe por **WhatsApp** (AWS End User Messaging Social; modo `simulated` con simulador de teléfono salvo los mundos aprobados para vivo; número y WABA **propios de este producto**, ADR-0021) cualquier reclamo sobre su cuenta y sus operaciones. El agente le da el **número de reclamo en el acto**, lo investiga contra el core simulado (ledger, redes de cobro, red de transferencias), resuelve lo que la política decidida en código permite, manda la **respuesta escrita** y los certificados por **email** (Amazon SES, solo salida, en vivo contra el simulador de buzones de SES) y deriva el resto a una persona con el **reloj regulatorio** (10 días hábiles) corriendo. Un **motor de política de canal** evalúa cada mensaje saliente de cualquier emisor y **bloquea la cobranza por WhatsApp**, aunque la intente un operador humano.

Vocabulario en `CONTEXT.md`; diseño en `docs/design-brief.md`; topología en `docs/architecture.md` y `docs/architecture-integrations.md`; decisiones en `docs/adr/`; flujos en `docs/flows-catalog.md`; tools en `docs/tool-catalog.md`; seed en `docs/seed-spec.md`; pruebas en `docs/test-plan.md`; alta propia de invitados, leads y anti abuso en `docs/architecture-guests.md`; landing y pantallas de alta y login en `docs/landing-spec.md` (del diseñador de UI/UX); plan por paquetes en `docs/build-plan.md` (huecos de código detectados al cierre en su §5); reuso en `docs/reuse-map.md`; diagrama de AWS en `docs/assets/architecture/architecture.html`, renderizado por `npm run diagram:render` a `docs/assets/architecture-public.png` (cuerpo del README y landing) y `docs/assets/architecture.png` (con las marcas CDS, solo para "Submission notes" y la galería de la submission).

---

## REGLAS NO NEGOCIABLES

### Del stack

- **Serverless only.** Nada con servidores administrados.
- **SST v4 para toda la infra** (`sst.aws.*`, `$app`, `$dev`); **nunca `new pulumi.xxx`**. `aws.*` / `awsnative.*` solo donde no hay componente SST (AgentCore, Guardrails, Scheduler, SES configuration set); si hay que linkearlos, `sst.Linkable.wrap`.
- **Todo por IaC.** Ningún recurso AWS a mano. Lecturas (`describe-*`, `list-*`, `get-*`) sí. Lo que ningún provider modela va a "configuración manual declarada" (`docs/architecture.md` §17) con su comando de verificación.
- **Un solo stage, `poc`, y `sst deploy` solo desde CI** (push a `main`). **Nunca `sst dev`** (crea recursos reales en una cuenta compartida). **Nunca `sst remove`** sin confirmación explícita del operador en el momento.
- **Cuenta compartida** (`craftech-demos` 776805327629): todo recurso lleva el nombre del app o el tag `sst:app`; nunca se lee, modifica ni borra un recurso de otra app; ningún comando apunta a un recurso sin cerca.
- **SES solo salida.** Este app **nunca** declara receipt rules, receipt rule sets, reglas activas ni registros MX: otra app de la cuenta es dueña del único rule set activo de `us-east-1`. `npm run lint:no-ses-receiving` falla si aparece cualquiera (ADR-0003).
- **Providers pinneados**: `aws` 7.32.0, `aws-native` 1.74.1. Se cambian solo con ADR.
- **`Resource` de SST, nunca `process.env`** en Lambdas (salvo `STAGE` y `NODE_ENV`); `/// <reference path=".../sst-env.d.ts" />` en cada archivo que use `Resource`; recursos con `readLinked(nombre, zod)` y secretos con `secretValue(nombre)`.
- **Secretos con `sst.Secret`**, declarados una sola vez en `infra/secrets.ts`. Nada en el repo, en `.env`, en `environment` ni en el chat. Nunca se imprime un valor.
- **Removal `remove`** en el único stage.
- **Máximo 400 líneas** por archivo TS/TSX. **Feature-based**. **Sin librerías de estado** (Context + useState). **Tailwind v4** con `@theme`, sin hex en JSX.
- **zod en todos los bordes** (tools, eventos SNS/EventBridge, core y redes simuladas, tRPC, conector, salida de Bedrock).
- **Toda llamada externa con timeout y reintento con backoff.** Logs JSON con correlation id, **sin PII** (`packages/bff/src/lib/log.ts`).
- **Topes contra abuso con el reloj real** (nunca con el reloj del mundo, que maneja el invitado); corte del agente en runtime (`KILL#AGENT`), sin deploy.
- **Reloj inyectado**: ninguna lógica de negocio llama `Date.now()`; usa el reloj del mundo (ADR-0011). Todo lo que pasa a una hora simulada es un `Timer` que el reloj sabe avanzar.
- **Sin dependencias a ciegas**: versión estable, mantenida, compatible con Node 22 y ESM, declarada en la ola 0.
- **Documentación solo en los lugares definidos**: `architect` escribe `CLAUDE.md`, `CONTEXT.md`, `README.md` y `docs/`; `qa` escribe `tests/cases/`. Nadie más crea README ni notas sueltas. No se documenta lo que hizo Claude.

### Del producto

- **El código decide; el modelo investiga y redacta.** Topes, plazos, elegibilidad, montos, transiciones de estado, clasificación final del registro y política de canal son código (`packages/bff/src/complaints/`, `channel-policy/`, `packages/core-mock/`). El agente llama tools y redacta; nunca fija un monto, un plazo ni un tope (ADR-0005).
- **El agente nunca aprueba su propia acción.** No existe una tool que apruebe; aprobar es de la consola (`OPERATOR` hasta su tope, `SUPERVISOR` por encima), login ≤ 15 min (ADR-0005).
- **Un solo punto de salida.** Todo mensaje (agente, operador, sistema) pasa por `sendThroughGate` de `packages/bff/src/outbound/gate.ts`: envío repetido en el turno (se repite el ya enviado, ADR-0021) → política de canal → render (con el aviso de automatización) → G2 → verificación determinista → cerco → cinta `ALLOWED` → claim de envío → transporte → cinta `DISPATCH`. Ningún comando de envío (SES, EUM Social) aparece fuera de `outbound/transports/` ni un `SendMessage` de SQS fuera de `worker/enqueue.ts` (`npm run lint:chokepoint`) (ADR-0006).
- **Cobranza nunca por WhatsApp.** `CH-WA-NO-COLLECTION` es una regla dura: bloquea y ofrece un camino permitido (cola humana o aviso formal por email), para cualquier emisor.
- **Número de reclamo en el acto**, correlativo, generado por código (`R-AAAA-NNNNNN`) en la misma transacción que su entrada, en un **registro append-only** con cadena de hash anclada fuera de las tablas: IAM **bloquea** actualizar, borrar y escribir en lote para todo rol del app; una sobrescritura con `PutItem` no se puede impedir por IAM y **se detecta** en toda entrada anclada (cadena + primera ancla ingerida, escrita solo por `AnchorWriter` + hashes en los PDFs entregados); una entrada sin ancla se muestra sin verificar (`partial`). Nunca se afirma más que eso (ADR-0014).
- **Dinero una sola vez**: toda imputación, reversión, reintegro o reversión de transferencia toma en el core un claim por su clave natural; una acción aprobada la ejecuta el worker releyendo la aprobación, nunca desde el payload de un evento.
- **Identidad fuera del modelo**: teléfono vinculado (hash) + un desafío verificado por código antes de revelar datos o actuar (fallos contados por cliente en 24 h reales). El mundo de un usuario de la consola sale de su fila de staff, nunca de un atributo que pueda editar; ninguna Lambda desplegada confía en quién la invoca (`caller` es solo una firma en proceso). Nunca se piden documentos, claves, PIN, tarjetas, códigos ni datos bancarios por chat. Ninguna tool acepta un id que escriba el modelo: todo sale del `sessionToken`; zod `.strict()` en cada tool.
- **Todo contenido entrante es hostil** (texto, imágenes de comprobantes, nombres de archivo): se enmascara antes de persistir, va al Harness escapado dentro de un delimitador aleatorio por turno, y una lectura de comprobante nunca basta para imputar un pago: hace falta la línea del archivo de rendición.
- **Un comprobante que no existe nunca se "encuentra".** Sin coincidencia en la rendición publicada, el reclamo va a una persona.
- **Supuestos rotulados**: volúmenes de tickets, minutos humanos por acción, tarifas no verificadas y nuestra lectura de las reglas (BCRA, Meta) se muestran como "supuesto" o "nuestra lectura, no asesoramiento legal".
- **WhatsApp `live` solo con aprobación explícita y solo en `demo` y `qa-live-*`**: WhatsApp es `simulated` en todo mundo salvo los que `infra/channel-modes.ts` lista en `liveWorlds` con una aprobación explícita (`whatsappLiveApproval`, fecha y aprobador); los mundos de invitado y de QA son siempre `simulated` (`npm run channels:check-modes` lo impide en CI). El número y la WABA son **nuevos y propios** de este producto (ADR-0021). Todo está construido de punta a punta (adaptador, modo `live`, plantillas como código, eventos, scripts).
- **Marca neutra**: prestamista, redes y personas **ficticios**; ninguna marca de terceros (redes de cobro, bancos, billeteras, herramientas de soporte); nunca un cliente de Craftech. Lista de términos prohibidos **fuera del repo** (secreto `FORBIDDEN_TERMS`), falla cerrado en CI (ADR-0010).
- **Superficies neutrales y landing comercial** (ADR-0019). El estándar de superficies públicas de Craftech (skill `poc-landing`, fuera de este repositorio) es vinculante: se lee entero antes de tocar una superficie pública. Ninguna superficie visible (landing, `/signup`, `/login`, recuperación, consola, legales, simulador, visor de emails, emails incluidos los de Cognito, PDFs, plantillas de WhatsApp, textos del seed que ve un usuario) menciona hackathon, hackatón, Devpost, concurso, premio(s), jurado(s), juez, jueces, judge(s), evaluación ni "AWS CDS" como certamen; el concurso vive solo en `docs/`, `CLAUDE.md`, `CONTEXT.md`, los agentes y la sección "Submission notes" al final del README. El rol de quienes prueban es **`GUEST`** ("Invitado" / "Guest"; mundos `gNN`, `gtest`, `gprobe`, `gs-*`; usuarios `guest-NN`), nunca judge ni jurado. `npm run lint:neutral-surfaces` falla en CI sobre fuentes visibles y `dist`, y el id técnico del app nunca aparece en una superficie. La landing es comercial (qué resuelve, recorrido animado del producto, para quién, cómo se integra, impacto como metas rotuladas, qué es simulado, video, "Probar Reclamo en regla" → `/signup` / "Ingresar" → `/login` / "Hablemos" → `https://craftech.io/contact/` con UTM, ADR-0021), es/en sin scroll horizontal de 360 a 1440 px, `prefers-reduced-motion`, AA y presupuestos de performance; su experiencia es `docs/landing-spec.md`. Nunca un mockup que prometa una función inexistente: renders de componentes y copy reales hasta que el pipeline de captura tome las capturas reales (WP-44), cada provisorio en el manifiesto de capturas.
- **Alta propia de invitados y leads** (ADR-0020, `docs/architecture-guests.md`). El alta de un `GUEST` pasa **siempre por el BFF** (cliente confidencial de Cognito, email verificado por código, consentimientos separados y sin tildar); los roles internos siguen solo por invitación. El trigger post-confirmation solo **pide** el mundo (ticket `PROVISIONREQ#`); lo crea la fábrica de mundos. Topes con el reloj real y números de ADR-0020. **El alta pública está abierta** (ADR-0021): `seed:load` escribe `SWITCH#SIGNUP` abierto si no existe, una fila ausente se lee cerrada, y la cierran solo el operador (`guests:signup-switch -- --off`) o `KILL#SIGNUP`; no hay CTA alternativo (1 cuenta por email; 40 mundos de alta propia activos; vencimiento a las 6 h sin ingreso, a las 72 h sin actividad o a los 7 días; pool `SIGNUP` aparte con su propia cola y worker; WAF en el borde y en Cognito). Un invitado de alta propia no tiene atributo ni grupo: su identidad se verifica con el invariante bidireccional de `docs/architecture-guests.md` §3 en el trigger y en el BFF; la recuperación por email es **solo** para él (el personal sigue por administrador); la confirmación queda atada al `signupId` del formulario. En el código, `packages/bff/src/guests/` es el alta y la vida del invitado y `packages/bff/src/leads/` la tabla `Leads`, el aviso de lead y **todos** los topes que hace cumplir el código (`leads/limits.ts`); `infra/guest-limits.ts` solo los del WAF y Cognito (`docs/architecture-guests.md`, "Dónde vive en el código"). Toda alta confirmada es un **lead** en la tabla `Leads`, separada de la demo: el email de un lead es PII y nunca va a logs, cinta, auditoría, métricas ni exportaciones de la demo; el email del invitado solo recibe correos de Cognito; el aviso de lead va a una sola casilla `@craftech.io` configurable (`LeadNotifyEmail`, que el operador carga con la casilla que fijó el CTO, ADR-0021), nunca escrita en el código. Responsable de los datos: Craftech, Ciudad Autónoma de Buenos Aires, Argentina; privacidad y derechos en `sales@craftech.io` y en `https://craftech.io/contact/`; nada inventado (ni CUIT ni domicilio) (ADR-0021).
- **Materiales de submission en inglés.** Licencia Apache 2.0, © 2026 Craftech (`LICENSE`). Las credenciales de los evaluadores (`guest-NN`) van solo en las instrucciones de prueba privadas de la submission, nunca en el repositorio.

---

## IDIOMAS

| Qué | Idioma |
|---|---|
| Código, identificadores, comentarios, commits, README, instrucciones de prueba de la submission | Inglés |
| `CLAUDE.md`, `CONTEXT.md`, `docs/`, ADRs, `tests/cases/`, agentes de `.claude/`, conversación con el operador | Español (Argentina) |
| Consola, textos al cliente, plantillas de WhatsApp, emails, PDFs | Español rioplatense, en `packages/bff/src/copy/es-AR.ts` (glosa en inglés en `copy/en-gloss.ts`) |
| Landing, `/signup`, `/login`, recuperación, legales y emails de Cognito del invitado | es/en con conmutador (los emails según el idioma del alta) |

---

## STACK

| Capa | Elección |
|---|---|
| Monorepo | npm workspaces: `packages/{shared,bff,web,core-contract,core-mock,network-mock}`, `infra/`, `scripts/`, `tests/` |
| Agente | Bedrock AgentCore Harness (`global.anthropic.claude-sonnet-5-5` por el perfil de inferencia de aplicación con tags `<app>-<stage>-sonnet-5-5`, también para Memory; endpoint `live`; ADR-0021), Gateway MCP `AWS_IAM` con 7 targets Lambda, Memory, Policy Cedar, Guardrails G1/G2; lecturas precargadas por el worker y regla `ALWAYS_ANSWER`; clasificador de entrada con un modelo chico de la familia Haiku (ADR-0016) |
| Lectura de comprobantes | Bedrock `Converse` multimodal con salida forzada por schema + parser determinista de respaldo (ADR-0007) |
| Orquestación | SQS FIFO `CustomerEvents.fifo` por cliente (y aparte `SignupCustomerEvents.fifo` para los mundos de alta propia y `QaCustomerEvents.fifo` para QA); `Timer` con EventBridge Scheduler (un schedule por hito, `ActionAfterCompletion DELETE`); reloj de demo por mundo; obligaciones deterministas después de cada turno |
| Canales | SES v2 **solo salida** (identidad `reclamo.demo.craftech.io`, configuration set con eventos); End User Messaging Social con modo por mundo (`channelModes.whatsapp`) |
| Datos | DynamoDB (una tabla por agregado), S3 |
| Consola | React 19 + Vite + Tailwind v4, tRPC v11, Cognito con login propio (SRP, tokens de 15 min) y alta propia de invitados por el BFF; AWS WAF en CloudFront y en el user pool |
| Cuenta | `craftech-demos` 776805327629, `us-east-1`; profile `craftech-demos` en local; OIDC en CI |
| Stages | Solo `poc` (CI). Dominio `reclamo.demo.craftech.io` (zona `Z043097217S4W7QWXU5O0`) |
| Observabilidad | Solo logs JSON (30 días; anclas 180): métricas por metric filters, alarmas, sin dashboards ni tracing propio (ADR-0021) |
| Tests | vitest (`U`, `LF`), Playwright (`UI`), ejecutor de escenarios en `poc` (`SR`) |

## CONVENCIONES

- Nombres lógicos SST en PascalCase e inglés; tags `Project=aws-cds-hackathon-poc-reclamo`, `Stage`, `ManagedBy=sst`, `Owner=craftech`.
- Ramas cortas contra `main`; `main` deploya `poc`. Commits en inglés, imperativo.
- `GatewayTarget` en cadena de `dependsOn` con `ignoreChanges`; políticas Cedar: permits antes que forbids.
- CLI con el profile primero: `aws --profile craftech-demos <servicio> describe-...`.
- Un flujo nuevo o cambiado actualiza `docs/flows-catalog.md` y la matriz de `docs/test-plan.md` en el mismo PR (`npm run flows:check`).

## REUTILIZACIÓN

- Antes de escribir UI se revisa `packages/web/src/components/` (`Table`, `DataTable`, `SelectField`, `FilterPills`, `Drawer`, `Button`, `EmptyState`, `ApiErrorNotice`, `RemoteBlock`, `PageHeader`, `Section`, `StatTile`, `Badge`, `Callout`, `ClockBanner`, `RuleChip`, `RuleChips`, `MoneyText`, `SlaChip`, `TapeRow`). Segunda aparición de un patrón = extracción a `components/`.
- Un cliente por servicio externo (Harness, Bedrock `Converse`, SES, EUM Social, Scheduler, core y redes simuladas) con timeouts, reintentos y mapeo de errores en un solo módulo.
- Toda tool pasa por `createToolHandler`; todo procedimiento tRPC por `worldProcedure` (y `roleProcedure(...)` / `recentLoginProcedure` donde corresponde).
- Un texto tiene una sola fuente en `copy/`; el seed y los tests importan de ahí.
- Sin código muerto. Antes del PR: `npm run lint` y `npm run lint:duplicates`.

## PRIORIDADES DE CALIDAD

1. Quien abre la POC (un prospecto o un evaluador) entiende qué resuelve y la prueba solo, con la landing, el alta y el README, sin nosotros
2. Ningún cliente recibe un mensaje fuera de política ni un dato ajeno
3. Todo flujo probado según `docs/test-plan.md`
4. Consistencia antes que novedad; reusar antes que crear
5. Archivos chicos, una responsabilidad
6. Todo cambio de infra reproducible desde cero

---

## AGENTES

| Agente | Responsabilidad |
|---|---|
| `pm` | Planifica, delega por WP y reporta estado |
| `architect` | Documentación: `CONTEXT.md`, ADRs, arquitectura, catálogos, seed-spec, plan, pendientes, README |
| `devops` | SST, bootstrap, CI/OIDC, IAM, AgentCore y canales como recursos, secretos, costo |
| `typescript-dev` | Tools, turnos, canales, gate, política, mocks del core y de las redes, BFF, consola |
| `seed-generator` | Seed sintético, comprobantes, verdad de base y evaluaciones |
| `qa` | Casos, ejecutor de escenarios, flujos locales, verificación "100 % probada" |
| `security` | IAM, secretos, PII (incluidos los leads), identidad, alta propia y anti abuso, contenido hostil, cerco, superficies neutrales, reglas de la hackathon y marca |

**Regla de flujo.** `architect` documenta antes de implementar; `security` revisa la rama antes de mergear lo que toque IAM, secretos, canales, datos o superficies públicas; `qa` verifica antes de dar algo por hecho. La sesión del operador orquesta: no implementa, no opera, no deploya.

## FORMATO DE SALIDA

Directo, resultado primero, tablas antes que párrafos, sin repetir el pedido ni narrar el proceso. Diagramas ASCII en el chat; Mermaid solo en `docs/`.
