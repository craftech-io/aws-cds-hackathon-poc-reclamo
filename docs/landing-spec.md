# Landing spec · aws-cds-hackathon-poc-reclamo

Especificación completa y construible de la landing comercial (`/`) y de las pantallas de alta/login
(decisiones C, D y E del CTO, 2026-09-26; estándar el estándar de superficies públicas de Craftech (skill `poc-landing`, fuera de este repositorio)). No es código: la escribe el
diseñador; la construye `typescript-dev`, la audita `security` (superficies neutras) y la verifica
`qa` (Playwright 390×844 y 1440×900). Fuentes: `CONTEXT.md`, `docs/design-brief.md` (§4 catálogo de
reclamos, §10 superficies públicas, §14 guion de demo), catálogo de reclamos (design-brief §4),
`packages/web/src/views/landing/**` actual, y la **Referencia** de solo lectura del operador descrita
en `docs/reuse-map.md` (ADR-0001; no se nombra ni se versiona en este repo): su vista de landing
(estructura de secciones, galería, lightbox) y su script de landing (cómo se producen los
renders/capturas a partir de la consola real).

Esta especificación **reemplaza** la landing y el login actuales (hoy solo Hero + "Qué es real y qué
es simulado", y un login solo para cuentas creadas por el operador). No toca código ni
infraestructura: fija qué hay que construir para que `typescript-dev` lo implemente por WP (WP-57
landing con renders, WP-55 pantallas de alta, recuperación y preparación del mundo, WP-44 capturas
reales y pulido final; `docs/build-plan.md`). Los contratos técnicos del alta (Cognito, BFF, WAF,
leads, topes) son de `docs/architecture-guests.md` y ADR-0020; donde difieren de esta spec, rige
su §16.

**Reemplazos del 2026-10-06 (ADR-0021, decisiones del CTO).** Rigen sobre lo que esta spec dice más
abajo; cada punto reemplazado lleva la marca "Reemplazado por ADR-0021":

- **Un solo CTA de producto**: "Probar Reclamo en regla" / "Try Reclamo en regla" → `/signup` en el
  header, el drawer, el hero, el CTA final y `/login`. No existe la variante "Pedí acceso" (§9.1,
  §9.5, §9.9): el alta está abierta; si el operador la cierra o salta `KILL#SIGNUP`, `/signup`
  muestra el aviso fijo de §9.2 con "Hablemos" y la landing no cambia.
- **"Hablemos"** → `https://craftech.io/contact/` con UTM fijos por ubicación
  (`utm_source=reclamo-en-regla&utm_medium=demo&utm_campaign=poc-landing&utm_content=<ubicación>`),
  nunca `mailto:` (§2.10).
- **Sección de video** (`#video`) antes de "Cómo se integra" (`#integracion`): `<video controls
  preload="none" playsInline poster>` servido desde `public/landing/video/`, sin autoplay; oculta,
  sin placeholder, hasta que exista el video. El CTA terciario del hero baja a esa sección.
- **Diagrama de arquitectura** en `#integracion`: la versión pública (sin marcas del concurso) que
  renderiza `npm run diagram:render`.
- **Conmutador es/en sin desborde a 360 px**: ningún ancho de 360 a 1440 px tiene scroll horizontal,
  en los dos idiomas, con el menú cerrado y abierto (§5, §10 #14).
- **Legales**: responsable Craftech, Ciudad Autónoma de Buenos Aires, Argentina; privacidad y derechos
  en `sales@craftech.io` y por el formulario de contacto (`docs/architecture-guests.md` §10).

## 0. Lo que esta spec fija y lo que no

| Fija | No fija (lo decide otro rol/WP) |
|---|---|
| Narrativa, copy final es/en, CTAs, arquitectura de la información | Esquema de datos de `Leads`, contratos tRPC, IAM (arquitecto/devops) |
| El recorrido del producto (pasos, visual de cada paso, transición) | El pipeline de captura real (WP-44, ya existe el patrón en el script de landing de la Referencia, `docs/reuse-map.md`) |
| Sistema de motion (triggers, duraciones, easings, fallback) | Nombres de componentes TS finales (los propone `typescript-dev`, respetando REUTILIZACIÓN) |
| Layout por breakpoint, header, nav mobile | El flujo exacto de Cognito (`docs/architecture-guests.md` §2-§4, ADR-0020; acá se fija la UX que ese flujo tiene que soportar) |
| Tokens de `@theme` a extender | La identidad del invitado de alta propia: mismo pool por nombre de usuario, sin alias, con el **email normalizado como nombre de usuario** (ADR-0020 §1) |
| Manifiesto de capturas para WP-44 | Los 300+ reclamos del seed; acá solo los ids de escena que la landing necesita |
| Checklist de aceptación de QA | Los casos `SC-*`/`FL-*` del catálogo completo (`docs/test-plan.md`); acá solo lo nuevo de landing/auth |

**Rebautizo GUEST (decisión B, ADR-0019).** El vocabulario final rige en esta spec y en todos los
docs: rol `GUEST`, etiqueta UI "Invitado"/"Guest", mundos `g01..g99`/`gtest`/`gprobe` (y `gs-*` de
alta propia), usuarios `guest-NN`. El código de las olas 0 y 1 todavía dice `JUDGE`; su renombre
son WP-51 (código) y WP-52 (infra, scripts y guard `lint:neutral-surfaces`), ola 1b de
`docs/build-plan.md`, antes de cualquier otro WP.

**Agnosticismo al concurso (decisión A).** Ninguna palabra de esta spec, y ninguna que resulte de
implementarla, puede aparecer en una superficie visible: hackathon, Devpost, concurso, premio(s),
jurado/juez/jueces/judge(s), evaluación, "AWS CDS" como certamen. Verificado con
`npm run lint:forbidden` (lista externa al repo, secreto `FORBIDDEN_TERMS`) y con
`npm run lint:neutral-surfaces` antes de mergear cualquier WP que la implemente.

---

## 1. Arquitectura de la información

Una sola página larga (`/`), con ancla por sección para el nav y el "saltar al contenido". Orden,
de arriba a abajo:

| # | Sección | Ancla | Propósito | Para quién |
|---|---|---|---|---|
| 1 | Header | — | Marca, nav de anclas (desktop), es/en, "Ingresar" | Todos |
| 2 | Hero | `#inicio` | Propuesta de valor en 6 s; CTA primario y secundario | El que llega sin contexto |
| 3 | El problema | `#problema` | 3 dolores concretos del prestamista/billetera | Decisor de producto/compliance |
| 4 | Recorrido del producto | `#recorrido` | Cómo funciona, paso a paso, con visual real | Todos (el corazón) |
| 5 | Qué resuelve, por actor | `#que-hace` | Funciones agrupadas: cliente final / operador / supervisor y cumplimiento | Decisor técnico y de operaciones |
| 6 | Diferencial y confianza | `#reglas` | Las reglas que el sistema garantiza en código | Compliance, legal |
| 7 | Impacto | `#impacto` | Métricas como metas rotuladas | Decisor de negocio |
| 8 | Cómo se integra | `#integracion` | Conectores, canales AWS, seguridad, serverless | Técnico |
| 9 | Qué es simulado en esta demo | `#simulado` | Honestidad: qué es real, qué es mock | Todos (confianza) |
| 10 | Galería | `#galeria` | Capturas/renders con zoom, agrupadas por el mismo recorrido | El que quiere mirar antes de probar |
| 11 | CTA final | `#empezar` | Cierre comercial: probar, ingresar, hablar con Craftech | El convencido |
| 12 | Footer | — | Marca, legales, Powered by Craftech | Todos |

Todas las anclas son objetivos de scroll-reveal (§5) y de navegación por teclado (`scroll-margin-top`
≈ altura del header sticky).

---

## 2. Copy final por sección (es / en)

Tono: directo, comercial, sin jerga de concurso, sin superlativos sin sustento ("cada reclamo",
"en el acto", "en 10 días hábiles" — números que el producto cumple, no adjetivos). Registro:
español rioplatense para `es`; inglés neutro para `en`. Nombres ficticios ya establecidos:
prestamista **Jarilla — préstamos y billetera**; cliente de la historia principal **Valeria
Quiroga**.

### 2.1 Header

| | es | en |
|---|---|---|
| Nav | Cómo funciona · Qué resuelve · Reglas · Impacto | How it works · What it solves · Rules · Impact |
| Link "Hablemos" (desktop, junto al nav; en mobile va al pie del `Drawer`, §5) | Hablemos | Let's talk |
| CTA secundario | Ingresar | Sign in |
| CTA primario (Reemplazado por ADR-0021) | Probar Reclamo en regla | Try Reclamo en regla |

### 2.2 Hero (`#inicio`)

| | es | en |
|---|---|---|
| Eyebrow | Agente de reclamos regulados para prestamistas y billeteras de América Latina | A regulated-complaints agent for consumer lenders and wallets in Latin America |
| Título | Cada reclamo, con número en el acto, investigado y respondido por escrito a tiempo. | Every complaint, numbered on the spot, investigated and answered in writing on time. |
| Lead (≤ 30 palabras, prueba de los 10 segundos) | Tu cliente te escribe que su pago no se refleja. El número sale en el acto; la respuesta llega por escrito, con constancia de entrega. | Your customer messages that their payment isn't showing. The number comes out on the spot; the answer arrives in writing, with delivery proof. |
| Chip de prueba (debajo de los CTA, no en el lead) | Una compuerta de política bloquea la cobranza por WhatsApp — la intente el agente o un operador | A policy gate blocks debt collection on WhatsApp — even when a human operator tries it |
| CTA primario (Reemplazado por ADR-0021) | Probar Reclamo en regla → | Try Reclamo en regla → |
| CTA secundario | Ingresar | Sign in |
| CTA terciario (solo si existe el video; baja a la sección `#video`, ADR-0021) | Ver el recorrido (2½ min) | Watch the walkthrough (2½ min) |
| Nota bajo el CTA | Entorno de prueba con datos 100 % sintéticos: un prestamista ficticio, clientes ficticios, sin operaciones reales. | A test environment with 100% synthetic data: a fictitious lender, fictitious customers, no real operations. |

**Visual del hero**: no repite el auto-tipeo del paso 1 (§3.1) — el auto-tipeo cuenta la historia una
sola vez, en el recorrido. El hero muestra el **resultado en bucle** (loop corto, ~4 s, se repite
mientras la sección está en viewport): la burbuja ya escrita, la tarjeta con el número
`R-2026-000123` y, por última, un `TapeRow` en `BLOCKED` con el chip **BLOQUEADO** en la cinta —
la misma promesa del chip de prueba, mostrada. Marco de teléfono a la derecha del título en desktop;
debajo del CTA en mobile. El marco lleva, fijo y siempre visible, el rótulo **"WhatsApp (simulado)"**
/ **"WhatsApp (simulated)"** (§6): sin logo de Meta ni su verde de marca — el marco no puede sugerir
un canal en vivo.

### 2.3 El problema (`#problema`)

| | es | en |
|---|---|---|
| Eyebrow | El problema | The problem |
| Título | Un reclamo mal atendido cuesta plata y expone a la empresa | A mishandled complaint costs money and exposes the company |
| Lead | Los reguladores de servicios financieros exigen número, registro y respuesta escrita en plazo para todo reclamo, aunque se resuelva en el acto. WhatsApp, el canal donde vive tu cliente, prohíbe además la cobranza de deudas. | Financial regulators require a number, a record and a written answer within a deadline for every complaint, even when it is solved on the spot. WhatsApp, the channel where your customer already is, also bans debt collection outright. |
| Rótulo bajo el lead (chico, `text-slate`, siempre visible) | Nuestra lectura de la normativa, no asesoramiento legal. | Our reading of the regulation, not legal advice. |

| Dolor | es | en |
|---|---|---|
| 1 | **El reloj regulatorio corre desde el primer mensaje.** Un reclamo sin número, sin registro o sin respuesta escrita en plazo puede derivar en sanción, no es un detalle operativo. | **The regulatory clock starts on the first message.** A complaint without a number, a record, or a written answer on time can lead to a sanction — it's not an operational detail. |
| 2 | **Cada reclamo repite el mismo trabajo manual.** Buscar el pago, leer el comprobante, cruzarlo contra la rendición, redactar la respuesta: minutos que se multiplican por miles de reclamos al mes. | **Every complaint repeats the same manual work.** Finding the payment, reading the receipt, matching it against the settlement file, drafting the answer — minutes that multiply across thousands of complaints a month. |
| 3 | **WhatsApp es el canal que tu cliente usa, y el que más riesgo comercial tiene.** Un solo mensaje de cobranza mal encaminado, de un bot o de una persona, pone en riesgo la cuenta de WhatsApp Business entera. | **WhatsApp is the channel your customer already uses, and the riskiest one commercially.** One misrouted collection message, from a bot or from a person, puts the whole WhatsApp Business account at risk. |

### 2.4 Recorrido del producto (`#recorrido`)

| | es | en |
|---|---|---|
| Eyebrow | Cómo funciona | How it works |
| Título | De "pagué y no se refleja" a resuelto, en un solo hilo | From "I paid and it doesn't show" to resolved, in one thread |
| Lead | Seguí un reclamo real de punta a punta. Cada paso muestra la misma pantalla que ve tu equipo. | Follow one real complaint from end to end. Every step shows the same screen your team sees. |

Contenido paso a paso en §4 (incluye título, copy y visual de cada paso).

### 2.5 Qué resuelve, por actor (`#que-hace`)

| | es | en |
|---|---|---|
| Eyebrow | Qué resuelve | What it solves |
| Título | Un flujo, tres roles | One flow, three roles |

**Para el cliente final** / **For the end customer**

| es | en |
|---|---|
| Número de reclamo antes de terminar de escribir | A complaint number before they finish typing |
| Respuesta escrita por email, con el PDF y la constancia de entrega | A written answer by email, with the PDF and delivery proof |
| Nunca un mensaje de cobranza por WhatsApp | Never a collection message on WhatsApp |
| Un botón "Hablar con alguien" en cada mensaje | A "Talk to someone" button on every message |

**Para el operador** / **For the operator**

| es | en |
|---|---|
| Bandeja con el plazo regulatorio corriendo, no una fecha que hay que calcular | An inbox with the regulatory deadline already running, not a date to compute |
| Toda la evidencia en un solo caso: comprobante, línea de rendición, cláusula citada | Every piece of evidence in one case: receipt, settlement line, cited clause |
| Aprobación en la consola, con login reciente, para lo que supera el tope del agente | Approval in the console, with a recent login, for what is above the agent's cap |
| La misma compuerta que frena al agente también frena al operador | The same gate that stops the agent also stops the operator |

**Para supervisión y cumplimiento** / **For oversight and compliance**

| es | en |
|---|---|
| Cinta de cada decisión, con la regla que se aplicó | A tape of every decision, with the rule that applied |
| Registro de reclamos que deja ver cualquier sobrescritura, exportable y verificable | A tamper-evident complaint register, exportable and verifiable |
| Métricas con su fuente y su rótulo: medido, simulado o supuesto | Metrics with their source and label: measured, simulated or assumed |
| Un interruptor para frenar al agente sin esperar un deploy | A kill switch to stop the agent without waiting for a deploy |

### 2.6 Diferencial y confianza (`#reglas`)

| | es | en |
|---|---|---|
| Eyebrow | Lo que no se negocia | What doesn't bend |
| Título | Las reglas viven en el código, no en el prompt | The rules live in the code, not in the prompt |
| Lead | El modelo investiga y redacta. Los topes, los plazos y la política de canal los decide una función, siempre, para cualquier emisor. No es una promesa: es la arquitectura. | The model investigates and drafts. Caps, deadlines and channel policy are decided by a function, always, for every sender. It's not a promise — it's the architecture. |

| Regla | es | en |
|---|---|---|
| 1 | **El agente nunca aprueba su propia acción.** Toda acción sobre el tope espera a una persona. | **The agent never approves its own action.** Anything above its cap waits for a human. |
| 2 | **Cobranza, nunca por WhatsApp.** Una función bloquea cualquier mensaje de cobranza, lo mande el agente o un operador, y ofrece el camino permitido. | **Collection, never on WhatsApp.** A function blocks any collection message, whether it comes from the agent or an operator, and offers the allowed path. |
| 3 | **El número de reclamo sale en el acto**, en la misma transacción que el registro, correlativo, sin huecos. | **The complaint number is issued on the spot**, in the same transaction as the record, sequential, with no gaps. |
| 4 | **El registro no se puede alterar sin que se note.** Cadena de hash con ancla fuera de las tablas; una sobrescritura se detecta, no se promete imposible. | **The record can't be altered without it showing.** A hash chain anchored outside the tables; an overwrite is detected, never claimed impossible. |
| 5 | **Ningún dato de un cliente llega a otro.** La identidad se resuelve antes de que el modelo vea un dato. | **No customer's data reaches another.** Identity is resolved before the model ever sees a data point. |
| 6 | **El dinero se mueve una sola vez.** Toda imputación, reversión o reintegro tiene una clave natural que no se repite. | **Money moves exactly once.** Every allocation, reversal or refund carries a natural key that never repeats. |

### 2.7 Impacto (`#impacto`)

| | es | en |
|---|---|---|
| Eyebrow | Impacto | Impact |
| Título | Metas, no promesas | Targets, not promises |
| Lead | Cada número lleva su rótulo: **meta** (lo que el diseño persigue), **medido** (lo que salió de una corrida real) o **supuesto** (un parámetro editable). Nunca se mezclan. | Every number carries its label: **target** (what the design aims for), **measured** (what came out of a real run) or **assumed** (an editable parameter). They are never mixed. |

| Meta | es | en |
|---|---|---|
| Tiempo al número | < 5 s desde el mensaje del cliente | < 5 s from the customer's message |
| Resuelto sin intervención humana | ≥ 60 % de los reclamos | ≥ 60% of complaints |
| Respondido por escrito en plazo, con constancia | 100 % | 100% |
| Violaciones de política detectadas | 0 | 0 |

Cada tarjeta lleva la palabra "meta" visible (no un número suelto) y un enlace a "Cómo medimos esto",
que ancla a un bloque real de metodología (la pestaña "Lote · agente real" de `docs/design-brief.md`
§11: N = 30, 3 por tipo, corrida en `poc` con Harness y Bedrock reales) — **no** a `#simulado`, que
habla de qué es real y qué es mock, no de cómo se mide.

Espacio reservado **"medido · lote de 30"**, oculto hasta que WP-46/WP-49 lo produzcan: cuando exista,
muestra el N, la fecha de la corrida y el mismo rótulo "medido" que usa la consola (nunca mezclado con
"meta" en la misma tarjeta). Los valores de 0 (violaciones) y 100 % (respondido en plazo) **no** llevan
contador animado hasta el número: un contador que termina justo en 0 o en 100 % lee como un truco: esos
dos valores se muestran fijos desde que la tarjeta es visible. El contador de §4 se aplica solo a los
valores intermedios (tiempo al número, % resuelto sin persona).

### 2.8 Cómo se integra (`#integracion`)

| | es | en |
|---|---|---|
| Eyebrow | Cómo se integra | How it plugs in |
| Título | Se conecta a lo que ya tenés, no lo reemplaza | It connects to what you already have, it doesn't replace it |
| Lead | Un contrato de conector por sistema (core, redes de cobro, redes de transferencia) que se implementa en tu proyecto; en esta demo corre contra sistemas simulados. WhatsApp y email como canales; toda la infraestructura puede correr en tu propia cuenta de AWS. | A per-system connector contract (core, collection networks, transfer networks) that gets implemented in your project; in this demo it runs against simulated systems. WhatsApp and email as channels; the whole infrastructure can run in your own AWS account. |

| Bloque | es | en |
|---|---|---|
| Canales | WhatsApp (AWS End User Messaging Social) y email (Amazon SES), con la política de canal antes de cada envío | WhatsApp (AWS End User Messaging Social) and email (Amazon SES), with channel policy before every send |
| Agente | Amazon Bedrock AgentCore: herramientas, memoria y una política que audita cada llamada | Amazon Bedrock AgentCore: tools, memory and a policy that audits every call |
| Datos y cumplimiento | Registro y cinta append-only, ancladas fuera de las tablas, exportables con su verificación | Append-only register and tape, anchored outside the tables, exportable with their own verification |
| Infraestructura | 100 % serverless; en esta demo corre en la cuenta de Craftech, pensado para correr en tu propia cuenta de AWS, sin servidores que administrar | 100% serverless; in this demo it runs in Craftech's account, designed to run in your own AWS account, no servers to manage |

### 2.9 Qué es simulado en esta demo (`#simulado`)

Mantiene la tabla actual de `copy.ts` (`real` / `implementado en modo simulado` / `sistemas
simulados` / `datos`), reescrita sin "Demo para..." ni mención al concurso:

| | es | en |
|---|---|---|
| Título | Qué es real y qué es simulado en este entorno de prueba | What's real and what's simulated in this test environment |
| Real | Todo servicio de AWS corre de verdad: Amazon SES (envío, con sus eventos de entrega), AgentCore, Bedrock, EventBridge Scheduler, SQS, DynamoDB, S3, Cognito y CloudFront. | Every AWS service runs for real: Amazon SES (sending, with its delivery events), AgentCore, Bedrock, EventBridge Scheduler, SQS, DynamoDB, S3, Cognito and CloudFront. |
| Implementado, en modo simulado | El canal de WhatsApp está implementado sobre AWS End User Messaging Social (plantillas, botones, media, eventos de entrega). En este entorno de prueba lo usás con un simulador de teléfono que entra por el mismo circuito de entrada. | The WhatsApp channel is implemented on AWS End User Messaging Social (templates, buttons, media, delivery events). In this test environment you use it through a phone simulator that feeds the same inbound pipeline. |
| Sistemas simulados | El core de un prestamista ficticio (**Jarilla**), dos redes de cobro y una red de transferencias — para que puedas probar el producto sin tocar tus sistemas. | The core of a fictitious lender (**Jarilla**), two collection networks and a transfer network — so you can try the product without touching your systems. |
| Datos | 100 % sintéticos, generados con semilla fija. Ningún cliente, persona ni operación real. Las capturas de la consola de esta página se tomaron en un entorno local, con las respuestas del agente guionadas; en tu entorno de prueba responde el agente real. | 100% synthetic, generated with a fixed seed. No real customer, person or operation. The console captures on this page were taken in a local environment, with the agent's replies scripted; in your test environment the real agent answers. |

### 2.10 CTA final (`#empezar`)

| | es | en |
|---|---|---|
| Título | ¿Listo para ver tu propio caso? | Ready to see your own case? |
| Lead | Creá tu cuenta y probá el producto en un entorno de prueba aislado, sembrado para vos — queda listo en unos minutos. | Create your account and try the product in an isolated test environment, seeded just for you — it's ready in a few minutes. |
| CTA primario (Reemplazado por ADR-0021) | Probar Reclamo en regla → | Try Reclamo en regla → |
| CTA secundario | Ingresar | Sign in |
| CTA terciario | Hablemos | Let's talk |

**Reemplazado por ADR-0021**: "Hablemos" abre `https://craftech.io/contact/` con los UTM fijos de la ubicación, sin `mailto:` ni datos del visitante. Texto anterior, sin efecto: "Hablemos" (header desktop, drawer mobile, y aquí) abre `mailto:` a la casilla comercial de Craftech
(misma que en el resto del sitio de Craftech; el arquitecto la fija junto con la del alta de leads en
§9.4) con asunto fijo "Reclamo en regla" / "Reclamo en regla" y **sin ningún dato personal en la URL**
(ni email, ni nombre: el `mailto:` no lleva query params con datos del visitante); o, si Craftech ya
tiene un formulario de contacto propio, enlaza ahí. No es un formulario nuevo de esta POC.

**Banda de credibilidad** (nueva, entre el impacto/integración y este CTA, o dentro de este bloque):
una línea corta con el logo de Craftech y tres datos, no una tarjeta grande — hoy "Powered by
Craftech" solo vive en el footer y un decisor no llega a leerlo.

| | es | en |
|---|---|---|
| Línea | Construido por **Craftech**, consultora cloud & DevOps de LatAm, AWS Advanced Tier Partner, 100 % serverless. | Built by **Craftech**, a LatAm cloud & DevOps consultancy, AWS Advanced Tier Partner, 100% serverless. |

### 2.11 Footer

| | es | en |
|---|---|---|
| Línea de marca | Reclamo en regla · Powered by Craftech | Reclamo en regla · Powered by Craftech |
| Nota | Jarilla es un prestamista ficticio. Todos los datos de este entorno son sintéticos. | Jarilla is a fictitious lender. All data in this environment is synthetic. |
| Links | Privacidad · Términos · Hablemos | Privacy · Terms · Let's talk |

---

## 3. El recorrido del producto — detalle de implementación

Componente único `ProductTour` (o el nombre que fije `typescript-dev`) con dos modos de
presentación por el mismo contenido:

- **Desktop (≥ 1024 px): sticky/scroll-driven.** Dos columnas: a la izquierda, los 7 pasos apilados
  como bloques de texto (título + copy + número de paso), cada uno alto ≈ 80vh; a la derecha, un
  panel `sticky top-24` con el visual del paso activo. Un `IntersectionObserver` con
  `rootMargin: "-45% 0px -45% 0px"` marca "activo" el bloque de texto cuyo centro cruza el centro del
  viewport; al cambiar el activo, el panel visual cruza con una transición (§5.2). Es scroll-driven
  de verdad: no hay flecha "siguiente", el scroll del visitante *es* el control.
- **Mobile (< 1024 px): pasos apilados, sin sticky.** El visual de cada paso va *dentro* de su
  bloque de texto (no aparte), a ancho completo, antes del copy. Cada bloque hace scroll-reveal al
  entrar en viewport (§5.1); no hay panel fijo (un sticky de altura completa en un viewport angosto
  rompe el scroll). Chips de paso ("1 de 7", "2 de 7"...) arriba de cada bloque para orientarse.
- Con `prefers-reduced-motion: reduce`: en desktop, el panel sticky sigue existiendo (sticky no es
  animación) pero cambia sin transición de cruce (corte directo); en mobile, sin cambios ya que no
  hay animación de por sí.

### 3.1 Los 7 pasos

| # | Paso | Canal/vista | Copy (es) | Copy (en) | Visual ahora (WP-actual) | Captura real que lo reemplaza (WP-44) |
|---|---|---|---|---|---|---|
| 1 | El cliente escribe | WhatsApp (simulado) | Valeria le escribe a Jarilla por WhatsApp: "Pagué la cuota 4 en la Red de cobro Norte el martes a la tarde y me sigue figurando atrasada." (la cita es el mensaje del guion de `C01`, `copy/persona-scripts.ts`: el mismo que muestra la captura) | Valeria writes to Jarilla on WhatsApp: "I paid instalment 4 at the Red de cobro Norte on Tuesday afternoon and it still shows as late." (la glosa del mismo guion) | Render (§7): `PhoneFrame`/`ChatBubble` reales (extraídos a `components/`, §7) con auto-tipeo y el copy real de `copy/es-AR.ts`, rótulo fijo "WhatsApp (simulado)" en el marco, datos sintéticos | Captura del teléfono del simulador recortada al marco y al mensaje de Valeria (sin el panel del guion ni el redactor, sin las burbujas posteriores) |
| 2 | Número en el acto | WhatsApp (simulado, acuse) | El sistema responde con el número, el tipo de reclamo y el plazo, antes de que el agente intervenga. Meta: menos de 5 s (hasta la aceptación del transporte; WhatsApp simulado). | The system replies with the number, the complaint type and the deadline — before the agent even steps in. Target: under 5 s (until the transport accepts it; WhatsApp simulated). | Render: mismo `PhoneFrame`/`ChatBubble`, mensaje del sistema con el `AUTOMATED_DISCLOSURE` real + número `R-2026-000123` (dato del seed) y botones "Sí, a ese email" · "Hablar con alguien" | Captura del teléfono recortada al marco y a la burbuja del acuse |
| 3 | Lectura y conciliación | Comprobante + consola | Valeria manda la foto del comprobante. El modelo la lee, un lector determinista confirma cada campo y la lectura se cruza con el archivo que publica la red de cobro hasta dar con la línea exacta: mismo cliente, mismo préstamo. | Valeria sends a photo of the receipt. The model reads it, a deterministic reader confirms every field, and the reading is matched against the file the collection network publishes down to the exact line: same customer, same loan. | Render: imagen de comprobante sintético del seed + la tarjeta de evidencia (extraída a `components/`, §7, misma que usará `/app/complaints/:id`) con `MoneyText`/`Badge` reales, campos leídos vs. línea de rendición | Captura del caso (`/app/complaints/:id`, panel de evidencia) |
| 4 | Respuesta escrita | Email | La respuesta llega por email, con el estado de cuenta en PDF (con el hash del registro impreso) y la constancia de entrega. El reclamo queda resuelto y el plazo, cancelado. | The answer arrives by email, with the account statement as a PDF (with the register's hash printed on it) and delivery proof. The complaint is resolved and the deadline is cancelled. | Render: `EmailFrame` (extraído a `components/`, §7) con el asunto y cuerpo reales de `copy/es-AR.ts`, badge `DELIVERED`, más una miniatura del PDF adjunto con el hash visible — la prueba de cumplimiento más concreta del recorrido | Captura del visor de emails (`/app/emails`) |
| 5 | La compuerta frena hasta al operador | Consola (redactor) | Un operador intenta un "Recordatorio de mora" por WhatsApp para otro cliente. La misma compuerta que vigila al agente lo bloquea, en rojo, y ofrece el único camino permitido: un aviso formal por email. | An operator tries a "payment reminder" on WhatsApp for another customer. The same gate that watches the agent blocks it, in red, and offers the one allowed path: a formal notice by email. | Render: `TapeRow` real en estado `BLOCKED` con la regla `CH-WA-NO-COLLECTION`, seguido de `TapeRow` `REROUTED → ALLOWED` (datos sintéticos, mismos componentes que `/app/tape`; presentación compacta en mobile, §5) | Captura de `/app/tape` filtrada a esa decisión |
| 6 | Registro y cinta | Consola (registro) | Cada entrada del registro se encadena y se ancla fuera de las tablas; una sobrescritura de una entrada anclada se detecta. El registro se exporta con su verificación. | Every entry in the register is chained and anchored outside the tables; an overwrite to an anchored entry is detected. The register exports with its own verification. | Render: fila de `RuleChip`/`SlaChip` + estado de cadena "verificada" (componentes reales, datos sintéticos; presentación compacta en mobile, §5) | Captura de `/app/register` tras un export |
| 7 | Métricas | Consola (métricas) | Tiempo al número, porcentaje resuelto sin persona, porcentaje respondido en plazo con constancia y violaciones de política, cada uno con su fuente y su rótulo. Acá, las metas del diseño; en la consola, lo medido en tu entorno, con el costo por reclamo. | Time to number, percentage solved without a human, percentage answered on time with proof and policy violations, each with its source and its label. Here, the design's targets; in the console, what your environment measured, with the cost per complaint. | Render: `StatTile` reales con los valores de "meta" de §2.7 (mismos componentes que `/app/metrics`; presentación compacta en mobile, §5) | **Sigue render** hasta que exista un lote medido (`manifest.measured`): una captura de `/app/metrics` de un mundo sin lote muestra "n/a — agente guionado" en las cifras principales, y el cierre del recorrido nunca lleva cifras n/a. Con el lote, captura de la pestaña con valores, recortada a las tarjetas con dato |

**Los 7 visuales del recorrido son renders, no capturas, y no son "pendientes".** Cada uno se
construye con los componentes React reales de la consola (`PhoneFrame`/`ChatBubble`, la tarjeta de
evidencia, `EmailFrame`, `TapeRow`, `RuleChip`/`SlaChip`, `StatTile`) sobre datos sintéticos del seed
— nunca un mockup nuevo que la consola pueda no llegar a mostrar. `typescript-dev` extrae esos
cinco a `components/` en el WP que construye el recorrido, para que WP-41/WP-43 los reusen tal cual
en la consola: la segunda aparición es la de la consola, así el render no puede divergir de lo que
existirá. El manifiesto (§7) los rotula "Vista con componentes reales · datos sintéticos" — nunca la
insignia "captura pendiente" (§7 explica por qué esa insignia queda solo para lo que de verdad falta).

**Transición entre pasos** (desktop): al activarse un paso nuevo, el panel visual sale con
`opacity 1→0` + `translateY(0→-12px)` en 180 ms y entra el siguiente con `opacity 0→1` +
`translateY(12px→0)` en 220 ms, solapadas 80 ms (cross-fade, nunca las dos a `opacity 1` a la vez
más de ese solape). El bloque de texto activo se marca con un borde/acento de color `seal` en su
número de paso; los inactivos quedan en `slate`.

### 3.2 Presentación compacta de los pasos 5-7 en mobile (< 768 px) y glosa en `lang=en`

`TapeRow` es un `<tr>` de 6 columnas: a 360-390 px desborda, y la regla de §5 es cero scroll
horizontal en cualquier ancho.

- **< 768 px**, pasos 5 (`TapeRow`), 6 (`RuleChip`/`SlaChip`) y 7 (`StatTile`): `StatTile` ya es una
  tarjeta y no necesita cambios; `TapeRow`/`RuleChip`/`SlaChip` sí. Dos variantes válidas, a elegir por
  `typescript-dev` reusando el mismo componente en la consola mobile (no una tabla nueva solo para la
  landing):
  1. `TapeRow` dentro de `Table` mostrando solo 3 columnas (decisión, canal, reglas) bajo ese
     breakpoint, con las columnas restantes accesibles solo si la consola mobile también las oculta; o
  2. Una variante de tarjeta de `TapeRow` (mismos datos, layout vertical) extraída a `components/`,
     para que la consola mobile la use tal cual cuando la tenga.
- **`lang=en`**: `DECISION_LABEL` y las etiquetas de `TapeRow`/`SlaChip`/`RuleChip` viven solo en
  es-AR (`copy/es-AR.ts`). En inglés no desaparecen ni se traducen del todo: muestran la glosa fija de
  `copy/en-gloss.ts` junto al término en español, patrón ya usado en el banner rojo de la cinta
  (`docs/design-brief.md` §13): "BLOQUEADO · BLOCKED", "Reencaminado · Rerouted". Aplica a los tres
  componentes en los tres breakpoints, no solo en mobile.

---

## 4. Sistema de motion

**Principio**: cada animación cuenta algo (revela una relación, marca un cambio de estado, guía la
mirada); nada se anima "porque sí". Todo en `transform`/`opacity` (composable, 60 fps), disparado
por `IntersectionObserver` o CSS puro (`@starting-style`/scroll-driven donde el navegador lo permita
como *mejora*, nunca como requisito).

| Patrón | Trigger | Duración | Easing | Dónde |
|---|---|---|---|---|
| Reveal al entrar en viewport | `IntersectionObserver` (`threshold: 0.2`) | 500 ms | `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out marcado) | Título y lead de cada sección, tarjetas de "El problema", "Diferencial", "Impacto" |
| Stagger de tarjetas | Mismo observer que su sección, +80 ms por índice (máx. 4 ítems visibles a la vez, tope 320 ms de stagger total) | 400 ms por ítem | Igual que arriba | Grillas de 3-5 tarjetas (`problema`, `reglas`, `impacto`) |
| Cruce del panel del recorrido | Cambio de paso activo (§3) | 180/220 ms, solape 80 ms | `ease-out` (salida), `ease-in-out` (entrada) | Panel sticky de `#recorrido` en desktop |
| Auto-tipeo de WhatsApp | Al entrar en viewport la burbuja del paso 1 (una sola vez por carga) | ~35 ms por carácter, tope 1.400 ms total (si el texto es más largo, se acelera para no pasar el tope) | Lineal (es texto, no hace falta ease) | Burbuja del hero y paso 1 del recorrido |
| Contador de métricas | Al entrar en viewport `#impacto` | 800 ms | `ease-out` | `StatTile` de metas |
| Hover/tap de tarjeta | `:hover`/`:focus-visible` | 150 ms | `ease-out` | Tarjetas de "Qué resuelve", galería |
| Header que se achica | Scroll > 24 px (clase, no JS por frame; usar `scroll-driven` CSS si el navegador lo soporta, con fallback a un listener con `requestAnimationFrame`-throttle) | 200 ms | `ease-out` | Header sticky |

**Desktop vs. mobile**: el cruce del panel sticky (§3) es exclusivo de desktop; en mobile el reveal
por sección reemplaza toda la lógica de "paso activo". El auto-tipeo corre en los dos, porque es
barato y es lo que más cuenta la historia. El stagger de tarjetas se reduce a 2 ítems visibles a la
vez en mobile (menos simultaneidad, pantalla más angosta).

**`prefers-reduced-motion: reduce`** (obligatorio, media query, nunca solo una prop de JS): ningún
`transform`/`opacity` de entrada — todo contenido nace visible en su posición final; el auto-tipeo
del WhatsApp se reemplaza por el mensaje completo, mostrado de una vez; el cruce del panel sticky se
vuelve un corte directo (`display` toggle, sin transición); el contador de métricas muestra el
número final sin cuenta. Ningún contenido depende de terminar una animación para poder leerse.

**Implementación, sin dependencias pesadas**: CSS (`@theme` → nuevas `--animate-*` y `@keyframes`,
igual que `scene-progress`/`scene-in` ya existentes en `index.css`) + `IntersectionObserver` nativo +
un hook `useActiveStep` (mismo patrón ya usado en `DemoScenes.tsx` de la referencia, adaptado a
observer en vez de temporizador) para el paso activo del recorrido. Sin librería de animación: nada
de lo pedido (reveals, cruces, auto-tipeo, contadores) necesita spring physics ni gestos complejos;
si en la construcción aparece una necesidad real de timeline coordinada, la única candidata a
evaluar (y justificar por ADR, `CLAUDE.md` "Sin dependencias a ciegas") es una librería CSS-only de
`IntersectionObserver` reveals, nunca una de animación general.

---

## 5. Layout por breakpoint

Mobile-first, sin scroll horizontal en ningún ancho, `max-w-6xl` como contenedor de contenido (igual
que hoy). Objetivos táctiles ≥ 44 px.

| Breakpoint | Header | Hero | Recorrido | Grillas (problema/reglas/impacto) | Galería |
|---|---|---|---|---|---|
| 360-389 px | Logo + botón "Ingresar" + menú ☰ (nav de anclas y es/en adentro) | 1 columna: eyebrow, título, lead, CTAs, teléfono debajo | Pasos apilados, visual dentro de cada bloque (§3) | 1 columna | 2 columnas de miniaturas |
| 390-767 px | Igual que 360, más aire | Igual, teléfono a mayor escala | Igual | 1 columna | 2-3 columnas |
| 768-1023 px | Logo + nav de anclas visible + "Ingresar" + es/en; ☰ desaparece | 2 columnas: texto 7fr / teléfono 5fr | Pasos apilados (el sticky arranca en 1024, no antes: un sticky a media altura en tablet compite mal con el nav) | 2 columnas | 3 columnas |
| 1024-1439 px | Igual que 768 | Igual | **Sticky activo**: texto 5fr / panel 7fr | 3 columnas | 4 columnas |
| ≥ 1440 px | Igual, con más padding lateral (contenedor sigue en `max-w-6xl`, no crece sin límite) | Igual, con más aire | Igual, panel visual más grande (el teléfono/marco de email no estira más allá de su `max-w`) | 3-4 columnas | 4 columnas |

**Header sticky**: `sticky top-0`, fondo `bg-white/95 backdrop-blur`, borde inferior `border-mist`
(ya el patrón actual). Nav de anclas oculto bajo `lg:flex` (1024 px), antes de eso vive en el menú
`☰` como una hoja (`Drawer` ya existente en `components/`, reusado) con: los mismos anclas, "Hablemos"
(§2.10), es/en, "Ingresar" y "Probar Reclamo en regla" (ADR-0021 §2) al pie, fijo. El botón `☰` es un `<button
aria-expanded>` que abre el `Drawer` con foco atrapado y `Escape` para cerrar (mismo contrato que
`Lightbox`/`dialog` nativo donde se pueda, o el propio `Drawer` si ya maneja foco).

**El `Drawer` compartido de `components/` hoy no atrapa foco ni lo devuelve al cerrar.** No se crea
un drawer nuevo para la landing: se extiende el `Drawer` existente (foco inicial al primer elemento
enfocable al abrir, `Tab`/`Shift+Tab` circulan solo dentro, `Escape` y clic afuera cierran y devuelven
el foco al botón `☰` que lo abrió) — el checklist §10 #4 ya lo exige y hoy no se puede cumplir sin
este cambio, que además beneficia a cualquier otro uso del `Drawer` en la consola.

**Página larga**: 12 secciones más 7 pasos a ~80vh cada uno hacen una página muy larga. Dos ajustes:
los pasos del recorrido bajan a ~60vh en vez de 80vh (siguen siendo el "corazón" de §1, no hace falta
tanto alto por paso para que el `IntersectionObserver` de §3 marque bien el activo); y la sección
"Qué es simulado" (`#simulado`) y la galería (`#galeria`) se funden en un solo bloque, ya que las dos
hablan de honestidad sobre qué es real — la galería es la evidencia visual de esa misma idea, no una
sección aparte.

---

## 6. Sistema visual

**Paleta**: se mantiene pine/seal/brass — es la identidad ya aprobada (serif display, sello
dibujado). Extensiones necesarias a `@theme` (mismo archivo `index.css`, sin nuevo hex fuera de
ahí):

| Token nuevo | Uso | Nota |
|---|---|---|
| `--color-pine-mist` (tinte muy claro de pine, ~`#eef3f1`) | Fondo alterno de sección (hoy solo hay `paper`/`white`; con 12 secciones conviene un tercer fondo sutil para separar bloques sin recurrir siempre a `pine` oscuro) | Nuevo |
| `--color-seal-mist` (tinte muy claro de seal, ~`#fbeee9`) | Fondo de tarjetas "bloqueado"/alerta en el recorrido (paso 5), distinto de `danger-soft` que ya es semántico de error de formulario | Nuevo |
| Blobs decorativos | Reusa `pine-soft/60` y `seal/10` ya usados en `LoginView` (`BrandPanel`) — no son tokens nuevos, son el mismo patrón aplicado al hero de la landing | Reuso |
| `--animate-tour-cross-out` / `--animate-tour-cross-in` | Cruce del panel del recorrido (§4) | Nuevo, mismo patrón que `scene-in` |
| `--animate-count-up` (o lógica JS con `transform` de un contador de dígitos) | Contador de métricas | A decidir por `typescript-dev`: si el contenido es solo dígitos, CSS `counter` con `@property` numérica interpolable es viable sin JS; si el formato lleva `%`/`s` mezclado, un hook chico con `requestAnimationFrame` |

**Tipografía**: se mantiene `font-display` (serif) para H1/H2, `font-sans` para cuerpo — ya
correcto para "registro, no juguete de chat". Escala fluida con `clamp()` en el H1 del hero
(`clamp(2rem, 1.5vw + 1.5rem, 3.5rem)` — errata corregida, `rvw` no es una unidad válida — o el valor
que `typescript-dev` calibre) para que no rompa a
360 px ni se quede chico a 1440 px.

**Tratamiento de "marcos" (device frames)**:

| Marco | Para | Tratamiento |
|---|---|---|
| Teléfono | WhatsApp (pasos 1-2, hero) | Reusar el patrón de `RcsPhone` de la referencia (borde `pine-deep` grueso redondeado, pantalla `paper`), adaptado a burbujas de WhatsApp (verde/gris en vez de cian/navy — pero como color de marca, no de Meta: usar `success`/`mist` del theme, **nunca** el verde de WhatsApp ni su logo, `CONTEXT.md` "piel de chat genérica"). Lleva, fijo y siempre visible (no solo al hacer foco), el rótulo **"WhatsApp (simulado)"** / **"WhatsApp (simulated)"** en el marco del teléfono — nunca solo en el `alt` del manifiesto — para que ningún visitante confunda el simulador con un canal en vivo (§2.2, §3.1 pasos 1-2) |
| Navegador/consola | Pasos 3, 5, 6, 7 | Marco simple: barra superior `mist` con 3 puntos decorativos (`aria-hidden`) + `rounded-card`/`shadow-card` ya existentes; sin cromo de navegador real (no hace falta simular Chrome) |
| Email/PDF | Paso 4 | Reusar el patrón `EmailFrame` de la referencia (encabezados De/Asunto + cuerpo), con el rótulo `email.from`/`email.subject` ya presente en `copy.ts` |

**Dark/light**: la landing queda **solo light** (`color-scheme: light` ya fijado en `index.css` para
toda la app). No se agrega modo oscuro: es consistente con la consola (que tampoco lo tiene) y evita
duplicar todo el sistema visual de esta spec por un modo que nadie pidió. Si en el futuro se pide,
es un ADR nuevo, no una extensión silenciosa de esta spec.

---

## 7. Manifiesto de capturas para WP-44

Mismo patrón que el `captures.json` del script de landing de la Referencia (`docs/reuse-map.md`;
capturas de la consola real corridas
localmente sobre el seed sintético, con Playwright, logueado como `OPERATOR`). Un id por escena de
landing; `view`/`world`/`persona` son los parámetros que arma `scripts/landing/console-scenes.ts`
(a escribir en WP-44), no datos de producción.

**Dos formas de entrada, no una** (corrige la premisa de que todo lo que no es `capture` es
"pendiente"): los 7 visuales del recorrido (§3.1, §3.2) **no son archivos** — son componentes React
reales renderizados con datos sintéticos — así que no encajan en el `MediaItem` de
`packages/web/src/views/landing/media.ts`, que exige `file` bajo `/landing/`. El schema de
`media.ts` pasa a una unión discriminada por `status`:

- `status: "render"` → `{id, status: "render", component, replacedBy}`, **sin** `file`/`width`/
  `height`/`alt` (el componente trae su propio `alt`/`aria`; no es una `<img>`). `component` nombra
  el componente real que lo dibuja (`PhoneFrame`, `EvidenceCard`, `EmailFrame`, `TapeRow`,
  `RuleChip`); `replacedBy` es el id de la fila de este mismo manifiesto que lo va a reemplazar
  (`tour-01-whatsapp`, …, uno por cada fila de la tabla de abajo).
- `status: "placeholder" | "capture"` → el `MediaItem` de hoy (`file` bajo `/landing/`, con
  `width`/`height`/`alt`), sin cambios: sigue siendo lo correcto para lo que de verdad es una imagen
  pendiente de capturar (la galería `gallery-console-*`) o ya capturada.

Cada captura real lleva el rótulo "Captura de la consola real · datos sintéticos" / "Real console capture · synthetic data"; que las respuestas del agente de las capturas son guionadas lo dice la columna "Datos" de `#simulado` (arriba), sin encabezar cada pie con "guionado". Una captura recortada (los pasos 1 y 2: solo el teléfono) nunca se dibuja más ancha que su ancho 1x.

La insignia visible "captura pendiente" (`landingCopy.media.placeholderNote`) se muestra **solo**
para filas `status: "placeholder"`. Las filas `status: "render"` muestran, en su lugar, el rótulo
"Vista con componentes reales · datos sintéticos" / "Real-component view · synthetic data" — un
render con datos sintéticos no es una promesa incumplida, es la demo funcionando; decirle "pendiente"
a los 7 pasos del recorrido haría ver la landing entera como inconclusa ante un prospecto.

**Galería (`#galeria`)**: mientras `media` no tenga al menos 4 filas `status: "capture"`, la sección
se oculta por completo (no se muestra vacía ni llena de insignias "pendiente"); vuelve a mostrarse
sola en cuanto WP-44 sube la cuarta captura real.

Las 7 filas `status: "render"` de hoy usan **el mismo `id`** que su fila correspondiente en la tabla
de abajo (`tour-01-whatsapp` … `tour-07-metrics`) y `replacedBy` apunta a ese mismo `id`: cuando
WP-44 sube la captura real, esa fila del manifiesto pasa de `{status: "render", component,
replacedBy: "tour-01-whatsapp"}` a `{status: "capture", file, width, height, alt}` sin cambiar de
`id` — así ningún componente de la landing que consume `mediaOf(state, id)` necesita saber si está
mirando un render o una captura.

| id | Vista | Mundo/persona | Viewport | Archivo | Alt (es) | Alt (en) |
|---|---|---|---|---|---|---|
| `tour-01-whatsapp` | `/app/simulator`, recortada al teléfono hasta el mensaje del cliente | `demo` / `C01` Valeria Quiroga | 1280×800 y 390×844 (el recorte) | `tour-01-whatsapp@2x.avif` / `-mobile@2x.avif` | Mensaje de WhatsApp donde Valeria reporta que su pago no se refleja | WhatsApp message where Valeria reports her payment isn't showing |
| `tour-02-ack` | `/app/simulator`, recortada al teléfono hasta la burbuja del acuse | `demo` / `C01` | 1280×800 y 390×844 (el recorte) | `tour-02-ack@2x.avif` / `-mobile@2x.avif` | Acuse automático con el número de reclamo y el plazo | Automatic acknowledgement with the complaint number and deadline |
| `tour-03-evidence` | `/app/complaints/:id` (panel de evidencia): la tarjeta del comprobante leído y la línea de la rendición que coincide, lado a lado en escritorio y apiladas en el teléfono | `demo` / `C01`, reclamo `R-2026-000123` | 400 y 360 px de ancho (cada tarjeta, a la mitad del panel) | `tour-03-evidence@2x.avif` / `-mobile@2x.avif` | Comprobante leído junto a la línea de rendición que lo confirma | Read receipt next to the settlement line that confirms it |
| `tour-04-email` | `/app/emails`, recortada al detalle abierto: asunto y constancia, encabezados, integridad ("Coincide con el email enviado"), adjuntos PDF y eventos de SES | `demo` / `C01` | 640 y 360 px de ancho | `tour-04-email@2x.avif` / `-mobile@2x.avif` | Respuesta escrita por email con el PDF adjunto y la constancia de entrega | Written answer by email with the attached PDF and delivery proof |
| `tour-05-blocked` | `/app/tape` filtrada a `CH-WA-NO-COLLECTION`, recortada a las decisiones `BLOCKED` y `REROUTED` | `demo` / `C09` Martín Olmedo | 640 y 360 px de ancho | `tour-05-blocked@2x.avif` / `-mobile@2x.avif` | Intento de cobranza por WhatsApp bloqueado y reencaminado a un aviso formal por email | Attempted WhatsApp collection message blocked and rerouted to a formal email notice |
| `tour-06-register` | `/app/register` (tras export), recortada del botón de exportar al resultado verificado con sus archivos | `demo` | 640 y 360 px de ancho | `tour-06-register@2x.avif` / `-mobile@2x.avif` | Registro de reclamos exportado con su cadena de hash verificada | Complaint register exported with its verified hash chain |
| `tour-07-metrics` | Render `StatTile` de las metas de §2.7 (rotuladas "meta") hasta que exista un lote medido; después, `/app/metrics` con valores | — | — | — | — | — |
| `gallery-console-inbox` | `/app/inbox` | `demo` | 1280×800 | `gallery-console-inbox@2x.avif` | Bandeja de reclamos con el plazo restante de cada uno | Complaint inbox with each one's remaining deadline |
| `gallery-console-approvals` | `/app/approvals` | `demo` | 1280×800 | `gallery-console-approvals@2x.avif` | Pedido de aprobación sobre el tope del agente | An approval request above the agent's cap |

Las filas `tour-01-whatsapp` … `tour-07-metrics` viven hoy en `public/landing/manifest.json` como
`status: "render"` (arriba); `gallery-console-inbox` y `gallery-console-approvals` viven como
`status: "placeholder"` (con `landingCopy.media.placeholderNote`, ya existente, sin cambios de
contrato) porque de verdad no existen todavía ni como render de landing ni como vista de consola.
WP-44 reemplaza cada fila `render` por `capture` (mismo `id`) y cada fila `placeholder` también por
`capture`, sin dejar ninguna en un estado intermedio.

Las capturas de consola de los pasos 3 a 6 se toman al ancho con el que la landing las dibuja (panel de
620 px desde 1024 px, columna de unos 342 px en el teléfono) y recortadas al bloque del paso, sin barra
lateral ni cromo de la consola, para que su texto llegue a 11 px o más. Toda figura ampliable (pasos
del recorrido, diagrama de arquitectura, galería) lleva un chip visible "Ampliar" / "Zoom" siempre
presente (en pantallas táctiles no hay hover), además del nombre accesible del botón.

---

## 8. Accesibilidad y presupuestos de performance

**Accesibilidad** (estándar `poc-landing` §3):

- Teclado: cada CTA, cada tab del recorrido (si se usa un fallback de tabs en vez de scroll puro en
  algún punto) y cada control del `Drawer` de mobile alcanzable por `Tab`, con foco visible
  (`:focus-visible` ya define `outline-seal` en `index.css`).
- `alt` descriptivo en cada imagen del manifiesto (§7, ya bilingüe); ninguna imagen decorativa sin
  `aria-hidden="true"` (blobs, íconos de check).
- Contraste AA: verificar `seal` sobre `pine` (CTA del hero) y `slate` sobre `paper` (copy largo) con
  una herramienta de contraste antes de cerrar el WP visual; si `seal` sobre `pine` no llega a AA
  para texto, se resuelve subiendo el CTA a fondo blanco/`seal` sólido en vez de outline.
- Landmarks: `header`/`main`/`footer` (ya presentes), `nav aria-label` por bloque (ya el patrón de
  la referencia), un H1 único (el del hero), H2 por sección.
- Idioma declarado: `<html lang="es">` por defecto, `lang="en"` cuando `?lang=en` (mismo patrón que
  hoy, extendido a toda la página, no solo a los textos de `copy.ts`).
- `prefers-reduced-motion` (§4) no es opcional: es parte del checklist de aceptación (§9).

**Performance** (estándar `poc-landing` §3):

| Presupuesto | Valor | Cómo se cumple |
|---|---|---|
| LCP en 4G | < 2,5 s | Hero sin imagen de fondo pesada (blobs son CSS, no imagen); el teléfono del hero es SVG/CSS, no un PNG hasta que exista la captura real; primera pieza de media pesada (AVIF) fuera del viewport inicial |
| Formato de imagen | AVIF/WebP con `srcset` (2x para retina) | Mismo pipeline de render que el script de landing de la Referencia |
| Carga diferida | `loading="lazy"` en todo `<img>` fuera del hero (ya el contrato de `MediaFigure`) | Ya implementado, se mantiene |
| JS de landing | Sin librerías nuevas de animación (§4); el bundle de landing no crece por motion | Revisión de tamaño en el PR que la implemente |
| Hilo principal | Ningún handler de scroll sin throttle; `IntersectionObserver` en vez de listeners de `scroll` donde sea posible | §4 ya lo fija como requisito de implementación |

---

## 9. Signup y login — UX

Extiende el patrón visual ya construido en `LoginView.tsx`/`AuthFlowPanel.tsx` (panel de marca a la
izquierda en desktop, tarjeta blanca centrada con el flujo a la derecha) a un flujo más largo: alta
propia con verificación por código, aprovisionamiento de mundo, recuperación de contraseña, y logout.
El rol interno (`OPERATOR`/`SUPERVISOR`/`COMPLIANCE`) sigue siendo solo por invitación — nada de esto
cambia esa puerta; lo que se agrega es la puerta nueva, de autoservicio, para `GUEST`.

### 9.1 Mapa de pantallas

```
/signup ──code──> /signup/verify ──ok (CONFIRMED)──┬─ password en memoria ──> SRP silenciosa
   │                    │                           │   (ConsoleClient) ──> /signup/provisioning*
   └─ ya tengo cuenta ──┴── reenviar código          │        (ya autenticada) ──ready──> /app/inbox (GUEST)
        → /login                                     │
                                                      └─ sin password (recargó / cambió de pestaña)
                                                            ──> /login (email precargado, aviso
                                                                "cuenta confirmada, ingresá")

/login ──ok, mundo READY──────────────────────────> /app/inbox
   │
   ├─ mundo no READY ──> pantalla fija "Estamos preparando tu mundo" (o "Tu entorno venció…")
   ├─ olvidé mi contraseña → /login/recover ──código──> /login/recover/reset ──ok──> /login
   └─ rol interno con MFA/cambio de contraseña → flujo ya existente (AuthFlowPanel), sin cambios

Con el alta cerrada (`signup.availability` → `closed`: el operador la cerró o `KILL#SIGNUP` activo;
`SIGNUP_UNAVAILABLE`, §9.2): la landing no cambia (Reemplazado por ADR-0021: no hay "Pedí acceso");
/signup muestra el aviso fijo de §9.2 con "Hablemos" en vez del formulario.
```

`*` `/signup/provisioning` puede llegar ya autenticada (SRP silenciosa) o, si el visitante entra a esa
URL sin sesión (recargó la página), redirige a `/login` con el mismo aviso que la rama de abajo — ver
§9.3.

### 9.2 `/signup` — Alta

**Estado inicial.** Mismo layout que `/login` (`BrandPanel` a la izquierda con el mismo tagline;
tarjeta a la derecha). Formulario corto (estándar §5 de `poc-landing`, "Captación de leads"):

| Campo | Obligatorio | Tipo | Copy es | Copy en |
|---|---|---|---|---|
| Email | Sí | email | Email | Email |
| Contraseña | Sí | password (mostrar/ocultar) | Contraseña | Password |
| Nombre | No | text | Nombre (opcional) | Name (optional) |
| Empresa | No | text | Empresa (opcional) | Company (optional) |
| Tu rol | No | select corto: Atención/Operaciones · Cumplimiento/Legal · Tecnología · Producto · Otro | Tu rol (opcional) | Your role (optional): Support/Operations · Compliance/Legal · Technology · Product · Other |
| Consentimiento 1 (obligatorio, sin tildar por defecto) | Sí | checkbox | Acepto los <a>Términos</a> y la <a>Política de privacidad</a> | I accept the <a>Terms</a> and the <a>Privacy Policy</a> |
| Consentimiento 2 (opcional, sin tildar por defecto) | No | checkbox | Craftech puede contactarme sobre esta solución | Craftech may contact me about this solution |
| CTA primario | — | submit | Crear cuenta | Create account |
| Link secundario | — | link a `/login` | Ya tengo cuenta · Ingresar | I already have an account · Sign in |

Debajo del formulario, una línea fija (no un campo): *"Vas a operar sobre datos y clientes
sintéticos, en un entorno aislado creado para vos."* / *"You'll operate on synthetic data and
customers, in an isolated environment created just for you."* — pone el marco de "es una prueba"
sin decir la palabra prohibida.

**Errores de formulario** (inline, bajo el campo, `text-danger`, `role="alert"` en el primero que
aparece tras submit):

| Caso | Copy es | Copy en |
|---|---|---|
| Email inválido | Escribí un email válido | Enter a valid email |
| Email ya registrado y confirmado (`EMAIL_TAKEN`) | Ya existe una cuenta con este email. <a>Ingresá</a> o <a>recuperá tu contraseña</a>. | An account with this email already exists. <a>Sign in</a> or <a>recover your password</a>. |
| Alta previa sin confirmar, mismo email — no es un error ni tiene copy propio: el BFF reemplaza el alta sin confirmar por la nueva (con esta contraseña y estos consentimientos) y responde `CODE_SENT` como a un alta nueva, así nadie confirma con el código de la víctima un alta que armó otro (`docs/architecture-guests.md` §4) | — (mismo avance a `/signup/verify` que un alta nueva) | — |
| Contraseña débil | Usá al menos 12 caracteres, con mayúscula, minúscula y número | Use at least 12 characters, with an uppercase letter, a lowercase letter and a number |
| Consentimiento 1 no marcado | Tenés que aceptar los Términos y la Política de privacidad para crear la cuenta | You need to accept the Terms and the Privacy Policy to create an account |
| Límite de intentos (bot/rate limit, `RATE_LIMITED`) | Hubo demasiados intentos desde este origen. Probá de nuevo en unos minutos. | Too many attempts from this origin. Try again in a few minutes. |
| Alta cerrada (`SIGNUP_UNAVAILABLE` — `SWITCH#SIGNUP` sin abrir, `KILL#SIGNUP` activo, o SES todavía sin DKIM `SUCCESS`) — no es un error de formulario: reemplaza el formulario entero, con un único CTA | Por ahora no podemos crear cuentas nuevas. <a>Hablemos</a> (ADR-0021 §2: `https://craftech.io/contact/` con `utm_content=signup-unavailable`) | We can't create new accounts right now. <a>Let's talk</a> |
| Error de red/servidor | No pudimos crear tu cuenta. Probá de nuevo. | We couldn't create your account. Please try again. |
| Dominio descartable (`EMAIL_NOT_ACCEPTED`) | Usá un email permanente, personal o de trabajo. | Use a permanent personal or work email. |

**Atribución del lead**: al llegar a la landing, `sessionStorage` guarda `utm_*` y `referrer` (solo el
origen, nunca la URL completa) si están presentes, sin ningún dato personal; al navegar a `/signup`
desde cualquier CTA "Probar Reclamo en regla" (ADR-0021 §2), esos valores viajan como `utm`/`referrer` en `signup.start`
(§4 de `docs/architecture-guests.md`). Sin esta captura en la landing, se pierden en el clic.

### 9.3 `/signup/verify` — Código de verificación

Tarjeta con: título, un campo de 6 dígitos (o el que fije Cognito), CTA "Confirmar" y link
"Reenviar código" (deshabilitado con cuenta regresiva 30 s tras cada envío, patrón ya usado en
`AuthFlowPanel` para otros challenges).

| | es | en |
|---|---|---|
| Título | Confirmá tu email | Confirm your email |
| Lead | Te mandamos un código a **{email}**. Escribilo para activar tu cuenta. | We sent a code to **{email}**. Enter it to activate your account. |
| CTA | Confirmar | Confirm |
| Reenviar | Reenviar código | Resend code |
| Error: código incorrecto | Ese código no es correcto. Probá de nuevo. | That code isn't right. Try again. |
| Error: código vencido | Este código venció. Pedí uno nuevo. | This code expired. Request a new one. |

`signup.start` devuelve un `signupId` que la web guarda en `sessionStorage` (nunca en la URL) y que
`signup.confirm` y `signup.resend` exigen junto con el código: solo vale el último formulario enviado
para ese email. Si el BFF responde `SIGNUP_RESTART` (otro formulario lo reemplazó, venció o se cerró la
pestaña), la web vuelve a `/signup` con el aviso "Empezá de nuevo el alta: tu código anterior ya no
vale." / "Start the sign-up again: your previous code no longer works."

El email de verificación es neutral y bilingüe (según el idioma detectado en el alta), sin mención
al concurso ni a Craftech como remitente de producto (lo manda Cognito con el nombre del pool,
ajustado por `architect`); nunca lleva datos reales.

**Qué pasa al confirmar (`CONFIRMED`) — cómo queda logueado el visitante.** `signup.confirm` no
devuelve tokens (`GuestSignupClient` no tiene flujos de login), pero `/signup/provisioning` necesita
un JWT para sondear `guest.status`. La web resuelve esto sin pedirle una segunda contraseña a nadie
que recién la escribió:

1. La contraseña que el visitante tipeó en `/signup` se guarda **solo en memoria** (estado de React,
   nunca `localStorage`/`sessionStorage`/`indexedDB` — es la contraseña de la cuenta) mientras dura la
   navegación `/signup` → `/signup/verify`.
2. Al recibir `CONFIRMED`, si esa contraseña sigue en memoria, la web hace un login SRP silencioso con
   `ConsoleClient` usando el email y esa contraseña (sin pantalla intermedia, sin pedirle nada de
   nuevo al visitante) y entra a `/signup/provisioning` ya autenticada.
3. Si no la tiene (recargó `/signup/verify`, cerró y volvió a abrir la pestaña, o llegó a
   `/signup/provisioning` directamente sin ese estado): va a `/login` con el email precargado y el
   aviso fijo de abajo — nunca un error de Cognito, nunca le pide "iniciá sesión" sin contexto.

| | es | en |
|---|---|---|
| Aviso en `/login` con email precargado | Tu cuenta está confirmada; ingresá para ver tu entorno. | Your account is confirmed; sign in to see your environment. |

### 9.4 `/signup/provisioning` — Mundo en preparación

Pantalla fija, sin acción posible más que esperar o navegar (consistente con "Estamos reiniciando tu
mundo" ya usado en el patrón de reset de `clock.spec.ts`). Sondea el estado del mundo (`guest.status`,
`docs/architecture-guests.md` §4) hasta `READY`. Crear un mundo tarda **minutos** (presupuesto 600 s de
`WorldCreateDuration`, no segundos), y con el cupo de 40 mundos activos lleno puede haber cola: el
copy tiene que decir las dos cosas, y **nunca promete un aviso por email** — el email del invitado
solo recibe los correos de Cognito (ADR-0020; `docs/architecture-guests.md` §16 corrige justamente
este punto de la versión anterior de esta spec).

| Estado (`worldStatus` / respuesta del BFF) | es | en |
|---|---|---|
| `REGISTERED`, sin cola (posición 0) | Título: Estamos preparando tu mundo (título fijado por el CTO, se mantiene). Lead: Estamos armando tu entorno de prueba, aislado y con datos sintéticos, para que puedas probar el producto. Esto tarda unos minutos. | Title: We're getting your world ready (title as fixed by the CTO, kept as-is). Lead: We're setting up your test environment — isolated, with synthetic data — so you can try the product. This takes a few minutes. |
| `REGISTERED`, en cola (posición > 0, de `guest.status`) | Somos muchos probando la demo en este momento. Estás en el lugar **{posición}** de la fila; seguí esperando o volvé más tarde, tu lugar se mantiene. | A lot of people are trying the demo right now. You're **{posición}** in line; keep waiting or come back later, your place is kept. |
| `CREATING` | Ya estamos armando tu entorno de prueba. Esto tarda unos minutos. | We're already building your test environment. This takes a few minutes. |
| Mientras WP-34 (fábrica de mundos) no esté desplegada | Mismo texto de `REGISTERED`/`CREATING` según corresponda — la confirmación de alta ya encoló el pedido; la consola simplemente tarda más en pasar a `READY` hasta que la fábrica esté servida. Ningún texto de usuario distingue "todavía no existe la fábrica" de "está tardando": es un detalle de implementación. | Same copy as `REGISTERED`/`CREATING` — the confirmation already enqueued the request; the console just takes longer to reach `READY` until the factory is served. No user-facing text distinguishes "the factory doesn't exist yet" from "it's taking a while": that's an implementation detail. |
| Si tarda más del umbral de `qa` (FL-120: provisorio 600 s reales desde la confirmación sin cola, o desde `CREATING` si estuvo en cola; con datos reales de WP-34, el p95 de `WorldCreateDuration` redondeado al minuto, sin superar 600 s) | Esto está tardando más de lo esperado. Podés seguir esperando o volver más tarde: tu entorno sigue preparándose y lo vas a ver la próxima vez que ingreses. | This is taking longer than expected. You can keep waiting or come back later: your environment keeps getting ready and you'll see it next time you sign in. |
| `EXPIRED` (mundo vencido, §9.5; también llega acá si el visitante vuelve después de 7 días en cola) | Título: Tu entorno venció; lo preparamos de nuevo. Botón: Preparar mi entorno (llama `guest.requestWorld`, vuelve a `REGISTERED`) | Title: Your environment expired; we're setting it up again. Button: Set up my environment (calls `guest.requestWorld`, goes back to `REGISTERED`) |

Al llegar a `READY`, redirige sola a `/app/inbox` (sin botón "continuar" intermedio: no hay nada que
confirmar). Mientras espera, la pantalla muestra los 5 pasos del recorrido guiado
(`views/tour/steps.ts`, `docs/design-brief.md` §15) o el video si ya existe — la espera es de
minutos, no de segundos, y vale la pena aprovecharla en vez de dejar una pantalla en blanco con un
spinner.

**Límite de uso alcanzado** (FL-125; no es una pantalla de `/signup`, pero es uno de los cinco
estados que faltaban en esta spec): un invitado con su tope diario alcanzado ve, dentro de la
consola, un aviso fijo — no un error — y el sistema sigue emitiendo el número y el acuse por reglas.

| | es | en |
|---|---|---|
| Aviso fijo en la consola | Llegaste al límite de uso de hoy de este entorno. | You've reached today's usage limit for this environment. |

### 9.5 `/login` — Ingreso

Sin cambios de layout respecto del actual (`BrandPanel` + `AuthFlowPanel`); se agrega:

- Link "¿Olvidaste tu contraseña?" / "Forgot your password?" bajo el campo de contraseña.
- Link "¿No tenés cuenta? Probar Reclamo en regla" / "Don't have an account? Try Reclamo en regla"
  (Reemplazado por ADR-0021: sin variante "Pedí acceso"; con el alta cerrada, `/signup` muestra el
  aviso fijo) bajo el CTA de ingreso, apuntando a `/signup` — **siempre visible**, para cualquier
  visitante. No se puede mostrar "solo si no identificó un rol interno": antes de autenticar no hay
  ningún rol identificado (el email todavía no se validó contra nada), y condicionarlo por el email
  tipeado dejaría enumerar qué direcciones son de personal.
- Estado nuevo: **mundo no `READY`** (aplica tanto a un `GUEST` que todavía no terminó de
  aprovisionar como a cualquier mundo en reset) → mismo texto de §9.4 según el estado exacto
  (`REGISTERED`/en cola, `CREATING`, `EXPIRED`), nunca un error de Cognito genérico.
- Cuando llega desde el aviso de §9.3 ("Tu cuenta está confirmada…"), el campo de email llega
  precargado y de solo lectura hasta que el visitante lo toca.

### 9.6 `/login/recover` y `/login/recover/reset` — Recuperación de contraseña

Dos pasos, mismo layout de tarjeta:

| Pantalla | es | en |
|---|---|---|
| `/login/recover` — título | Recuperar contraseña | Recover your password |
| `/login/recover` — lead | Escribí tu email y te mandamos un código para elegir una nueva contraseña. | Enter your email and we'll send you a code to choose a new password. |
| `/login/recover` — CTA | Enviar código | Send code |
| `/login/recover/reset` — título | Elegí una nueva contraseña | Choose a new password |
| `/login/recover/reset` — campos | Código · Nueva contraseña · Confirmar contraseña | Code · New password · Confirm password |
| `/login/recover/reset` — CTA | Guardar contraseña | Save password |
| Éxito | Listo, tu contraseña cambió. Ya podés ingresar. | Done, your password has changed. You can sign in now. |
| Error: email no existe | Por privacidad, no confirmamos si un email tiene cuenta. Si existe, te llega un código. | For privacy, we don't confirm whether an email has an account. If it does, a code is on its way. |

(La respuesta neutral ante "email no existe" es deliberada: evita que el formulario de recuperación
sirva para enumerar qué emails están registrados.)

### 9.7 Logout

Un único punto de salida (botón en el shell de la consola, sin pantalla propia): limpia la sesión y
redirige a `/` (la landing), no a `/login` — el visitante que cierra sesión es, de nuevo, un
visitante público.

### 9.8 Roles internos

Sin cambios de UX respecto de lo ya construido: `OPERATOR`/`SUPERVISOR`/`COMPLIANCE` siguen
creándose solo por invitación (`console:invite` o el comando que resulte de renombrar el flujo de
alta de personal), sin exponer `/signup` como puerta para esos roles. El único punto de contacto
entre los dos mundos es `/login`, que sirve a los dos.

### 9.9 Cuándo el alta puede abrirse al público

**Reemplazado por ADR-0021 §1** (2026-10-06): el alta está abierta. `seed:load` escribe
`SWITCH#SIGNUP` abierto desde el deploy que trae la fábrica de mundos (WP-34); el operador puede
cerrarla con `--off` y `KILL#SIGNUP` la cierra por presupuesto o reputación de SES; no hay "Pedí
acceso" y la URL no se anuncia hasta que WP-55 está desplegado. El texto que sigue queda como
antecedente, sin efecto.

Publicar `/signup` antes de que WP-34 (fábrica de mundos) esté desplegada gasta cada lead en una
experiencia rota: el prospecto confirma, cae en "Estamos preparando tu mundo" y se queda ahí para
siempre. Por eso:

- **El alta arranca cerrada y queda cerrada (`SWITCH#SIGNUP` sin abrir) hasta que se cumplan las
  tres condiciones**: WP-34 desplegada en `poc`, `SC-24/2` (`docs/test-plan.md`, cierre de FL-113:
  confirmación, lead y pedido de mundo de punta a punta) en verde, y el umbral de costo del pool
  `SIGNUP` fijado por Craftech. Ninguna sola alcanza para abrirla
  (`docs/architecture-guests.md` §7). `KILL#SIGNUP` es aparte: lo activan el presupuesto y las alarmas
  de reputación de SES, y también cierra el alta.
- Con el alta cerrada, la landing entera usa "Pedí acceso" en vez de "Probar la demo" (§9.1) y
  `/signup` muestra el aviso fijo de `SIGNUP_UNAVAILABLE` (§9.2) en lugar del formulario, para quien
  llegue ahí por un link directo o un favorito viejo.
- El operador lo abre y lo cierra con `npm run guests:signup-switch -- --on \| --off`
  (`docs/architecture-guests.md` §7), auditado; no es una decisión de código sino una del CTO/`qa`
  una vez que las tres condiciones están confirmadas.

---

## 10. Checklist de aceptación (QA, Playwright 390×844 y 1440×900)

| # | Caso | Cómo se verifica |
|---|---|---|
| 1 | Landing carga en es y en en, sin mención a ninguna palabra de la lista prohibida ni a ninguna palabra del concurso (ADR-0019) | `lint:forbidden` y `lint:neutral-surfaces` (WP-52, FL-128) sobre fuente y `dist`; Playwright lee el DOM renderizado en los dos idiomas |
| 2 | Las 7 tarjetas/pasos del recorrido son alcanzables por teclado y por scroll, en los dos breakpoints | Playwright: `Tab` a través de los CTAs y bloques; en 1024+ el panel sticky cambia al hacer `scroll` hasta el centro de cada bloque |
| 3 | Con `prefers-reduced-motion: reduce`, todo el contenido del recorrido es legible sin esperar ninguna animación | Playwright con `emulateMedia({ reducedMotion: "reduce" })`; snapshot de accesibilidad sin elementos `opacity: 0` residuales |
| 4 | El header se comporta como `Drawer` accesible en 390×844 (abre, atrapa foco **desde el elemento que lo abrió y lo devuelve ahí al cerrar**, cierra con Escape y con clic afuera) | Playwright: abrir, `Tab` no sale del drawer, `Escape` cierra y el foco vuelve al botón ☰ |
| 5 | Galería: zoom, anterior/siguiente por teclado y por swipe, `Escape` cierra; con menos de 4 capturas reales, la sección no se muestra | Ya cubierto por `landing.test.ts`/`Lightbox`; extender a las nuevas imágenes del manifiesto y al caso de galería oculta (§7) |
| 6 | `/signup` → código → `/signup/provisioning` (ya autenticada por SRP silenciosa) → `/app/inbox` funciona de punta a punta con Cognito mockeado; y por separado, sin la contraseña en memoria (recargó la página), `/signup/verify` → `CONFIRMED` → `/login` con el email precargado y el aviso "Tu cuenta está confirmada; ingresá para ver tu entorno" (§9.3) | Nuevo `signup.spec.ts` (los dos caminos), mismo patrón que `login.spec.ts` |
| 7 | `/signup` rechaza un email ya registrado (`EMAIL_TAKEN`) y un consentimiento 1 sin marcar; reemplaza un alta previa sin confirmar sin duplicar cuenta (`CODE_SENT` y el `signupId` anterior responde `SIGNUP_RESTART`); exige 12 caracteres con mayúscula, minúscula y número (no 8); con `SIGNUP_UNAVAILABLE`/`KILL#SIGNUP` activo, muestra el aviso fijo en vez del formulario — todo con el copy exacto de §9.2 (ya sincronizado con `docs/architecture-guests.md` §2, §16) | `signup.spec.ts` |
| 8 | `/login/recover` no revela si un email existe o no | `login.spec.ts` (o `recover.spec.ts`) |
| 9 | Un `GUEST` cuyo mundo no está `READY` ve la pantalla fija de §9.4 según su estado exacto (en cola con posición, creando, vencido con botón de recrear), nunca un error crudo de Cognito ni una promesa de aviso por email | `provisioning.spec.ts` |
| 10 | Contraste AA verificado en los pares de color nuevos (§8) | Herramienta de contraste en el PR, no un test automatizado por ahora |
| 11 | LCP < 2,5 s simulando 4G sobre la build de `dist` | Lighthouse/`web-vitals` en CI o medición manual antes de cerrar el WP |
| 12 | El copy visible nunca afirma que el producto otorga crédito, cobra deuda, ofrece planes de pago ni refinancia (fuera de alcance, `docs/design-brief.md` §16); "cobranza"/"mora" solo aparecen para describir el bloqueo (regla 2 de §2.6, paso 5 de §3.1), nunca como una función del producto | Revisión manual contra el glosario `CONTEXT.md` "_Avoid_" (no `lint:forbidden`, que es la lista de marcas de terceros, no de estas palabras) |
| 13 | En 390×844 con `lang=en`, los pasos 5 a 7 del recorrido muestran una presentación compacta sin scroll horizontal, y `TapeRow`/`SlaChip`/`RuleChip` muestran la glosa de `copy/en-gloss.ts` junto al término en español (p. ej. "BLOQUEADO · BLOCKED") | Nuevo caso de Playwright en 390×844 + `lang=en`, foco en el paso 5 (§3.2) |
| 14 | En 360×800, es y en, con el menú cerrado y abierto, el conmutador es/en y el header no desbordan: `scrollWidth` ≤ ancho de la ventana (ADR-0021) | `landing.spec.ts` |
| 15 | "Hablemos" lleva a `https://craftech.io/contact/` con los UTM de su ubicación; la sección `#video` está oculta sin el video y, con él, usa `preload="none"`, póster y sin autoplay (ADR-0021) | `landing.test.ts`, `landing.spec.ts` |

---

## 11. Dependencias y pendientes para otros roles

Resuelto por `architect` (2026-09-26): vocabulario `GUEST` en `CONTEXT.md`, ADRs y docs; identidad
del alta propia sin alias (email normalizado como nombre de usuario, ADR-0020 §1); casilla de aviso
de leads como secreto `LeadNotifyEmail` cercado a `@craftech.io`; credenciales
`guest-NN` solo en las instrucciones privadas; "Del producto" de `CLAUDE.md` y `.claude/agents/*.md`
con el puntero a `poc-landing/SKILL.md`; FL-113 con el re-login por SRP silenciosa o vuelta a `/login`
(§9.3); la regla de §9.9 fijada en `docs/architecture-guests.md` §7 (`SWITCH#SIGNUP`).

- **`typescript-dev`**: WP-51 (renombre en el código), WP-57 (landing con renders: `ProductTour`,
  copy, `@theme`), WP-54 (servicio del alta, triggers post-confirmation y custom message, ticket
  `PROVISIONREQ#` que consume WP-34), WP-55 (`/signup`, recuperación y preparación del mundo reusando
  `AuthFlowPanel`), WP-44 (capturas reales). **División obligatoria por la regla de 400 líneas**: copy
  por idioma y por sección (`copy/landing/{es,en}/{hero,problema,recorrido,...}.ts` o equivalente),
  `ProductTour.tsx` (layout + `IntersectionObserver`) separado de `tour-steps.ts` (datos), un archivo
  por visual (`PhoneFrame.tsx`, `EvidenceCard.tsx`, `EmailFrame.tsx`, extraídos a `components/` por
  §3.1/§7) y hooks `useReveal`/`useActiveStep`/`useTypewriter`/`useCountUp` cada uno en su archivo. En
  desktop, montar solo el visual activo ±1 (no los 7 a la vez) para cuidar el hilo principal. La regla
  del schema de `media.ts` (unión discriminada `render`/`placeholder`/`capture`, §7) es de este rol.
- **`devops`**: WP-52 (grupo `GUEST`, scripts, guard `lint:neutral-surfaces` en CI) y WP-53 (Cognito
  del alta, WAF de borde y de Cognito, tabla `Leads`, secretos).
- **`seed-generator`**: nada nuevo para la landing en sí; los ids del manifiesto (§7) reusan personas
  ya sembradas (`C01`, `C09`).
- **`security`**: revisar que `/signup` no abra una puerta a roles internos; revisar el WAF y los topes
  del alta antes de abrirla; confirmar que las direcciones de leads nunca lleguen a logs, cinta ni
  export de la demo; confirmar que el `mailto:` de "Hablemos" no lleve ningún dato personal en la URL
  (§2.1, §2.10).
- **`qa`**: WP-56 (casos) y los specs de §10; decidir el umbral "tarda más de lo esperado" de §9.4
  con datos reales de WP-34; verificar `SC-24/2` en verde antes de que el CTO abra el alta
  (`SWITCH#SIGNUP`, §9.9).

**Neutralidad de lo ya mergeado**: la landing y el login de la ola 0 todavía nombran el concurso en
su copy; esta spec los reemplaza por completo (§0). WP-51 limpia el copy existente y WP-57 construye
la landing nueva; ninguna edición puntual de `copy.ts` fuera de esos WP.
