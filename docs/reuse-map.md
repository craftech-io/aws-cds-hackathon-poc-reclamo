# Mapa de reuso del scaffolding interno

Dos referencias internas de Craftech, creadas durante el período de la hackathon, checkouts locales de solo lectura del operador (no se versionan ni se nombran en este repo; ADR-0001):

- **Referencia A**: app completo, desplegado y probado (commit `82d20b2`).
- **Referencia B**: diseño completo y scaffold parcial de otra POC (documentación, infra de base, BFF de auth, shell de consola, guards de CI).

Decisiones:

- **Copiar**: el archivo entra igual, salvo el scope de paquete (`@<anterior>/*` → `@reclamo/*`), el nombre del app y los comentarios que nombren el producto anterior.
- **Adaptar**: entra con los cambios de la columna; dueño en `docs/build-plan.md`.
- **Descartar**: no entra. Todo lo específico de los productos anteriores (dominio, textos, marca, datos, investigación, canales que este producto no usa, flujos, casos de QA, manuales) se descarta y ningún archivo nuevo lo nombra; las filas lo describen de forma genérica cuando el nombre del archivo delataría el producto anterior.

Regla de verificación: después de cada WP que copie o adapte, `npm run lint:forbidden` (lista externa del operador, que incluye nombres, dominios y scopes de las referencias y los clientes) da cero coincidencias en árbol, commits, PDFs, imágenes, seed y build. En CI falla cerrado.

## Raíz y configuración

| Ruta en la referencia | Ref. | Decisión | Qué cambia / destino | WP |
|---|---|---|---|---|
| `package.json` | B | Adaptar | `name` `aws-cds-hackathon-poc-reclamo`; workspaces `shared`, `bff`, `web`, `core-contract`, `core-mock`, `network-mock`; scripts `lint:chokepoint`, `lint:no-ses-receiving`, `core:contract`, `seed:*`, `scenarios`, `evals`, `flows:check`, `tour:check`, `tools:build-schemas`, `channels:*`, `console:invite`, `lint:forbidden`, `lint:wp-ownership`, `test:ui`, `smoke:interim`; dependencias con `@aws-sdk/client-bedrock-runtime` (Converse) y sin clientes de canales o productos descartados | WP-01 |
| `package-lock.json` | A/B | Descartar | Se regenera | WP-01 |
| `tsconfig.json`, `tsconfig.infra.json`, `.gitignore`, `.editorconfig`, `.nvmrc` | B | Copiar | Alias `@reclamo/*`; `include` con `tests/` | WP-01 |
| `vitest.config.ts` | B | Adaptar | Suma `tests/flows/**` y los paquetes nuevos | WP-01 |
| `sst.config.ts` | B | Adaptar | `PROJECT`, módulos de `infra/` de `docs/build-plan.md` §1; rechaza stages distintos de `poc` | WP-01 |
| `sst-env.d.ts` (×3) | A/B | Descartar | Se generan vacíos y se commitean | WP-01 |
| `README.md` | A/B | Descartar | Se escribe de cero en inglés (architect, ola 7) | — |
| `CLAUDE.md`, `CONTEXT.md` | A/B | Descartar | Nuevos (architect, hecho) | — |

## `.claude/` y visor de docs

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `.claude/agents/{architect,devops,pm,qa,security,seed-generator,typescript-dev}.md` | B | Adaptar | Nombre del app, dominio (reclamos, compuerta, SES solo salida, WhatsApp simulado), rutas de `docs/`, reglas de reuso; `qa` con el ejecutor y los evals; `seed-generator` con comprobantes y evals; `security` con la cuenta compartida y el guard de recepción SES | WP-01 |
| `.claude/agents/market-researcher.md` | A | Descartar | Sin fase de investigación | — |
| `.claude/skills/{domain-modeling,grilling,grill-with-docs}/**`, `.claude/skills/README.md`, `.claude/commands/docs.md`, `.claude/launch.json` | B | Copiar | — | WP-01 |
| `.claude/settings.json` | B | Adaptar | Lecturas permitidas: `sesv2 get-account`, `sesv2 get-email-identity`, `scheduler`, `sqs`, `events`, `socialmessaging`, `bedrock list-inference-profiles`, `service-quotas`, `ce list-cost-allocation-tags`, `route53 list-resource-record-sets` (solo la zona demo); sin `ses describe-active-receipt-rule-set` (no es nuestro) | WP-01 |
| `docs/viewer.html` | B | Adaptar | Lista de archivos de `docs/` de este repo | WP-01 |
| `docs/**` restantes (catálogos, briefs, investigación, manuales, ADRs) | A/B | Descartar | Documentación nueva | — |

## `infra/`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `tags.ts`, `late-links.ts` | B | Copiar | `Project` | WP-02 |
| `ci.ts`, `ci-spec.ts`, `ci-spec.test.ts` | B | Adaptar | `CI_REPO`; mismas cercas de CloudFront y CSP (suma `frame-src 'self' blob:` y los hosts exactos de los tres buckets de nombre fijo en `connect-src`) | WP-02 |
| `secrets.ts`, `secrets.test.ts` | B | Adaptar | Un secreto por propósito (`SessionKey`, `SimEnvelopeKey`, `QaSimEnvelopeKey`, `PhoneHashKey`, `RegisterChainKey`) + `WabaId`, `WhatsAppPhoneNumberId`, `SeedOverrides` | WP-02 |
| `channel-modes.ts` | B | Adaptar | Modo por mundo: `{ email: "live", whatsapp: { liveWorlds: [] } }` | WP-02 |
| `iam-capabilities.ts`, `iam-capabilities.test.ts` | B | Adaptar | Capacidades de `docs/architecture.md` §14; regla de append-only sobre `Register` y `ComplianceTape` | WP-02 |
| `dns.ts` | B | Adaptar | Dominio `reclamo`; solo certificado y alias; **ningún MX** | WP-04 |
| `web.ts`, `web-spec.ts`, `web-spec.test.ts` | B | Adaptar | Sin ruta de superficie pública de carga; solo `/api/*` | WP-04 |
| `storage.ts`, `storage-tables.ts`, `storage-buckets.ts`, `storage-keys.ts` (+ test) | B | Adaptar | Tablas y buckets de `docs/architecture.md` §5-§6; mismos helpers (nombre ≤ 16, lifecycle, TLS); `WorldIndex` | WP-07 |
| `malware.ts` | B | Adaptar | Solo sobre `Media`, con su rol de servicio de nombre fijo y sin modo "sin plan" (`docs/architecture.md` §6, §14); la política del rol copia statement por statement la plantilla de AWS (regla administrada con y sin condición, objeto de validación) y `malware.test.ts` la compara así | WP-07 |
| Módulo de Knowledge Base (vector bucket) | A | Descartar | Sin Knowledge Base (ADR-0008) | — |
| `auth.ts`, `auth-email.ts` (+ test) | A/B | Adaptar | Grupos `OPERATOR`/`SUPERVISOR`/`COMPLIANCE`/`GUEST`, `custom:worldId`, marca. **Pool basado en nombre de usuario**: se quita `usernames: ["email"]` (la variante de la referencia A lo declara; con el email como nombre de usuario, `AdminCreateUser` rechaza `qa-<runId>-<escenario>-<rol>` y `guest-NN` sin email, y `cognito:username` sería el `sub`); sin alias de email ni teléfono; `UsernameConfiguration.CaseSensitive = false`; `email` como atributo opcional, no alias, solo para las invitaciones del personal. Nuevo `infra/auth.test.ts` sobre los argumentos del pool (`docs/architecture.md` §11) | WP-08 |
| `messaging-email.ts`, `messaging-email-spec.ts` (+ test) | B | Adaptar | **Solo salida**: identidad, DKIM, DMARC, configuration set → EventBridge; se **eliminan** rule set, reglas, bucket de correo entrante, MX, MAIL FROM y el simulador de buzones de B | WP-18 |
| `messaging-whatsapp.ts` | B | Adaptar | Topic `aws-cds-hackathon-poc-reclamo-wa-inbound`, `InboundWhatsApp` | WP-20 |
| `mocks.ts` | B | Adaptar | `CoreMock` y `NetworkMock` con Function URL `AWS_IAM` y el par de permisos por invocante | WP-20 |
| Módulo de la cola por agregado y su worker | B | Adaptar → `workers.ts` | `CustomerEvents.fifo`, `EventWorker`, `MediaIntake`, `EmailEvents`, `ScheduleDispatch` | WP-20 |
| Módulo de feeds de eventos externos | B | Descartar | Sin bus de feeds | — |
| Módulos de canales descartados (RCS, voz) | A | Descartar | Este producto no tiene esos canales | — |
| `guardrail.ts`, `guardrail-policies.ts` (+ test) | A/B | Adaptar | Temas de entrada y salida de `docs/design-brief.md` §8.5 | WP-22 |
| `policy.ts` | A | Copiar | Mismo orden permits → forbids con `dependsOn` | WP-31 |
| `policy-rules.ts` (+ test) | A/B | Adaptar | Statements `CED-*` de este repo, 7 targets | WP-31 |
| `agent-tool-schemas.ts` | A | Copiar | — | WP-31 |
| `agent-tools.ts`, `agentcore.ts`, `agentcore-spec.ts` (+ test), `agentcore-iam.ts` | A | Adaptar | 7 targets, Memory con 3 estrategias propias, log group `live` antes del endpoint | WP-31 |
| `scheduler.ts` | B | Adaptar | Grupo `…-poc-schedules`, rol de invocación solo sobre `ScheduleDispatch` | WP-31 |
| `bff.ts`, `observability.ts`, `observability-spec.ts` (+ test) | A/B | Adaptar | Métricas `ReclamoAgent/*`, alarmas, presupuesto por tag | WP-37 |
| Módulo de workflows de Step Functions | A | Descartar | ADR-0004 (el `transform` de `TimeoutSeconds` queda documentado por si se agrega uno) | — |
| Módulo de seed de A | A | Descartar | `SeedOverrides` en `secrets.ts` | — |
| `bootstrap/ci-role.yaml`, `bootstrap/ci-role.test.ts`, `bootstrap/README.md` | A/B | Adaptar | Nombres del app; rol `qa-runner`; **deny** de recepción SES, MAIL FROM y `MX`; cerca de registros DNS por nombre y tipo; sin statements del rule set ni del bucket de correo entrante; se conserva `GuardDutyMalwareScanRule` en la boundary, **partido en dos statements** como la plantilla de AWS (`events:{PutRule,DeleteRule,PutTargets,RemoveTargets}` con `events:ManagedBy`; `events:{DescribeRule,ListTargetsByRule}` sin condición, porque no admiten esa clave) y ampliado a las acciones S3 del rol del plan, incluido `s3:PutObject` solo sobre `Media/malware-protection-resource-validation-object` y los permisos `guardduty:*MalwareProtectionPlan*` del rol de deploy, más `iam:PassRole` del rol del plan; deny de anclas salvo `AnchorWriter`/`QaDriver`; presupuesto de tamaño | WP-03 |
| Tests de cercas del bootstrap (`ci-role-fences.test.ts`) y texto del template | B | Adaptar | Fusionados en `ci-role.test.ts` | WP-03 |

## `.github/workflows/`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `ci.yml` | B | Adaptar | Suma `lint:chokepoint`, `lint:no-ses-receiving`, `core:contract`; sin contrato del lector | WP-03 |
| `deploy.yml` | B | Adaptar | Se **elimina** el prechequeo del rule set activo (no es nuestro y no lo necesitamos); guards antes del deploy; smoke con `qa-runner` | WP-03 |
| `scenarios.yml` | B | Adaptar | Suites `smoke`, `full`, `eval`, `batch` | WP-03 |

## `packages/shared` y paquetes de mocks

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `packages/shared/src/{dates,errors,hash}.ts` (+ tests) | B | Copiar | — | WP-05 |
| `packages/shared/src/{enums,index}.ts` | B | Adaptar | Enums de `docs/tool-catalog.md` | WP-05 |
| `packages/shared/src/{ids,money,caller}.ts` | A | Adaptar | Prefijos de ids de este repo; dinero en pesos con formato es-AR sin `Intl` | WP-05 |
| Paquetes de contrato y mock de un servicio externo (`*-contract`, `*-mock`) | B | Adaptar la forma | Mismo patrón (OpenAPI + zod + `contract-check`) para `core-contract`, `core-mock`, `network-mock`; lógica nueva | WP-09, WP-15, WP-16 |
| Mock de plataforma de gestión de B | B | Descartar | Otro dominio | — |

## `packages/bff/src`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `lib/{log,clock,crypto,secrets,resource,retry,clients,deadline}.ts` (+ tests) | B | Copiar | Subclaves HKDF de `docs/architecture.md` §3; `clock` con `rate` | WP-05 |
| `lib/mask.ts` | A | Adaptar | Suma `[CLAVE]`; única fuente de patrones | WP-05 |
| `services/business-days.ts` (+ test) | A | Adaptar | Solo Argentina; `deadline` y `nthBusinessDay` con feriados de `Reference` | WP-05 |
| `services/{session,ratecard,rounding}.ts` (+ tests) | A | Adaptar | `sessionToken` con `customerId`/`complaintIds`; `money.ts` | WP-05 |
| `services/pdf.ts` y el escritor de PDF de A | A | Adaptar → `pdf/` | Documentos de `docs/architecture-integrations.md` §8 | WP-23 |
| Resto de `services/` (cálculos del dominio anterior) | A | Descartar | — | — |
| `auth/**` (+ tests), `auth-triggers/**` | B/A | Adaptar | Principal con `worldId`, `staffId`, roles de este repo; pre-sign-up que rechaza todo | WP-12 |
| `routers/{trpc,handler,deps,errors,index}.ts` (+ tests) | B | Adaptar | `worldProcedure`, `roleProcedure`, `recentLoginProcedure`; routers de `docs/tool-catalog.md` | WP-12 |
| `routers/{csv,testing}.ts` | A | Copiar | Exportaciones CSV y helpers de test | WP-36 |
| Routers del dominio anterior, `routers/adapters/**` | A | Descartar | — | — |
| `connector/**` (puerto, memoria, dynamo, expresiones) | A | Adaptar | Entidades de este repo; escrituras append-only | WP-10 |
| `domain/**` | A | Descartar | Nuevo | WP-10 |
| `copy/{index,helpers,types}.ts` | A | Copiar | — | WP-11 |
| `copy/**` resto (textos del dominio, consentimientos por país) | A | Descartar | Nuevos en es-AR | WP-11 |
| `channels/normalizer.ts` (+ test) | A | Adaptar | Delimitador aleatorio, escape, `[CLAVE]` | WP-21 |
| `channels/whatsapp/**` (adaptador, payloads, plantillas, ventana, fixtures) | A | Adaptar | Dos transportes (vivo y simulado de B), imágenes en lugar de PDFs, plantillas de §3.3, sobre simulado firmado | WP-21 |
| `channels/email/{outbound,mime,config,events,validate,content}.ts` y fixtures de eventos | A | Adaptar | MIME crudo con guardado del `.eml`, cerco del simulador de SES, eventos → constancia | WP-19 |
| `channels/email/{inbound,receipt,thread}.ts` y fixtures `.eml` entrantes | A | Descartar | Sin email entrante (ADR-0003) | — |
| `channels/{adapter,registry}.ts` (+ tests) | A | Adaptar → `outbound/transports.ts` | Solo `outbound/` construye transportes | WP-26 |
| `channels/rcs/**` | A | Descartar | Canal no usado | — |
| `outbound/{pipeline,verify,recipient,checks,facts,grounding,persist}.ts` (+ tests) | A | Adaptar → `outbound/gate.ts` y compañía | 7 pasos, cinta, reencaminamiento, léxico | WP-26 |
| `outbound/render/{whatsapp,ses}.ts` (+ test) | A | Adaptar | Plantillas y MIME de este repo | WP-26 |
| `outbound/render/rcs.ts` | A | Descartar | — | — |
| `policy/{engine,result,reasons,windows,context,counters}.ts` (+ tests) | A | Adaptar → `channel-policy/` | Reglas `CH-*`; evaluación en un instante pasado | WP-17 |
| `policy/rules/**` (reglas por país del dominio anterior) | A | Descartar | Nuevas | WP-17 |
| `agent/harness-client.ts` (+ test) | A | Copiar | — | WP-33 |
| `inbound/{turn,harness,harness-stream,envelope,gate,limits,record,process}.ts` (+ tests) | A | Adaptar → `worker/`, `turns/` | Eventos de §7, pre-filtro G1, `TURN_CAP`, fallback | WP-33 |
| `inbound/{identity,keywords,media,postbacks,direct-reply}.ts` | A | Adaptar → `intake/` y `channels/whatsapp/` | Teléfono vinculado, opt-out, imágenes, nonces | WP-21, WP-32 |
| `inbound/{rcs,email,transcribe-client,approval-workflow}.ts` | A | Descartar | — | — |
| `agent-tools/common/**` (`define`, `handler`, `registry`, `principal`, `scope`, `fields`, `json-schema`, `build-schemas`, `redact`, `audit`, `turn`, `session-attachments`) | A | Adaptar | Cercas `LAM-*` de este repo; `session-attachments` → evidencias | WP-24 |
| Carpetas de tools del dominio anterior (siete dominios) y `agent-tools/qa/**` | A | Descartar (tools) · Adaptar (`qa/{clock,guard,dispatcher}`) | Tools nuevas; el reloj y la guarda del QA se adaptan en `qa-driver/` | WP-28, WP-29, WP-40 |
| `agent-proxy/**` | A | Descartar | La consola no invoca el Harness | — |
| `workflows/**` | A | Descartar | Sin Step Functions (ADR-0004) | — |
| `public-web/**` | A | Descartar | Sin superficie pública con token | — |

## `packages/web`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `index.html`, `vite.config.ts`, `src/{main.tsx,app.tsx,routes.ts,console-routes.tsx,index.css,vite-env.d.ts}` | B | Adaptar | Rutas de `docs/design-brief.md` §9; tema propio | WP-06 |
| `src/lib/**` (auth SRP, tokens, http, tRPC, router, `use-remote`, errores) (+ tests) | B | Copiar | — | WP-06 |
| `src/lib/{format,local-datetime,stream}.ts` | A | Copiar | — | WP-06 |
| `src/lib/` hooks del dominio anterior | A | Descartar | — | — |
| `src/components/**` (`Table`, `DataTable`, `SelectField`, `FilterPills`, `Drawer`, `Button`, `EmptyState`, `ApiErrorNotice`, `RemoteBlock`, `PageHeader`, `Section`, `StatTile`, `Badge`, `Callout`, `Chart`, `table-parts`, `form-classes`, `layout/AppShell`, `brand/*`) | A/B | Copiar la estructura, **no el aspecto** | Marca "Reclamo en regla" con identidad visual propia (paleta, tipografía, composición): un evaluador que vea otras entradas de Craftech no tiene que leer esta como un cambio de colores | WP-06 |
| `src/components/{ClockBanner,RuleChip,RuleChips,MoneyText}.tsx` | A | Adaptar | Barra de hora simulada con compresión; reglas `CH-*` | WP-06 |
| `ScopeBar` | A | Descartar | Sin selector de entidad y período | — |
| `src/context/SessionContext.tsx` | B | Adaptar | `worldId`, rol | WP-06 |
| `src/views/login/**` | B | Adaptar | Variante `GUEST` | WP-06 |
| `src/views/landing/{LandingView,Lightbox,MediaFigure,gallery,lang,media}.tsx` (+ test) | A/B | Adaptar | Contenido nuevo es/en con hero propio (problema, solución, tres pruebas, recorrido de 5 minutos); piel de chat genérica "WhatsApp (simulado)", sin logos de Meta | WP-44 |
| `src/views/landing/` escenas y muestras del dominio anterior | A | Descartar | — | — |
| `src/views/**` restantes | A | Descartar | Vistas nuevas | WP-41 a WP-43 |
| `public/brand/**` | B | Copiar | Logos de Craftech | WP-06 |
| `public/legal/{privacy,terms}.html` | B | Adaptar | Textos de esta demo | WP-44 |
| `e2e/support/**` (sesión efímera, ruta de Cognito, guardas, capturas) | A | Adaptar | Roles de este repo | WP-06 |
| `e2e/*.spec.ts` del dominio anterior | A | Descartar | Specs nuevas | WP-41 a WP-44 |

## `scripts/` y `tests/`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `scripts/lint/{max-lines,duplicates,typecheck-infra,no-intl}.ts` (+ tests) | B | Copiar | — | WP-01 |
| `scripts/lint/forbidden-terms.ts` (+ test) | B | Copiar | Ya copiado por el architect para verificar los docs (solo cambia la referencia al ADR); WP-03 lo cablea en `package.json` y CI y agrega imágenes (metadatos PNG) | WP-03 |
| `scripts/lint/wp-ownership.ts` (+ test) | B | Copiar | — | WP-03 |
| `scripts/lint/{chokepoint,no-ses-receiving}.ts` | — | Nuevo | Guards de ADR-0006 y ADR-0003 | WP-03 |
| `scripts/flows/check.ts` (+ test) | B | Adaptar | Mapa de prefijos de `docs/test-plan.md` §2 | WP-03 |
| `scripts/channels/{check-modes,cli-args}.ts` (+ tests) | B | Copiar | — | WP-03 |
| `scripts/channels/` scripts de canales descartados | A | Descartar | — | — |
| `scripts/smoke/interim.ts` (+ test) | B | Adaptar | Suma `dig MX` vacío | WP-03 |
| `scripts/smoke/**` de A | A | Descartar | Reemplazado por `SC-00` | — |
| `scripts/seed/generate/{rng,hashing,writer,time,names,money,context,build}.ts`, `scripts/seed/lib/{tables,text,replay,conformance}.ts`, `scripts/seed/load/{args,aws,plan,ports,run,source,overrides,rehash}.ts`, `scripts/seed/validate/run.ts` | A | Adaptar | Entidades de este repo; renderizador PNG nuevo; carga por mundo | WP-14, WP-34 |
| `scripts/seed/data/**`, `scripts/seed/documents/**`, `scripts/seed/media/**` de A | A | Descartar | Datos del dominio anterior | — |
| `scripts/landing/{capture-console,console-server,console-world,render-visuals}.ts`, `captures.json` | A | Adaptar | Escenas de este repo | WP-44 |
| `scripts/landing/` muestras de canales descartados | A | Descartar | — | — |
| Ejecutor de escenarios, `QaDriver`, simulador de teléfono y reloj por mundo | B (diseño) | Adaptar el diseño | Implementación nueva siguiendo `docs/test-plan.md` §4 | WP-40, WP-47, WP-48 |

## Presupuesto de tamaño heredado

El template del bootstrap (≤ 51.200 bytes), cada managed policy (≤ 6.144 caracteres) y cada statement Cedar (≤ 10.000 caracteres calificado con el ARN del Gateway) se controlan en `ci-role.test.ts` y `policy-rules.test.ts`. Al adaptar, las explicaciones van a `infra/bootstrap/README.md`, nunca se recorta una cerca para entrar.
