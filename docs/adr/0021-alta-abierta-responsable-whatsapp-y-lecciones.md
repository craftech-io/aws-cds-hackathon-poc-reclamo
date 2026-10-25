---
status: accepted
---

# Alta pública abierta, datos del responsable, número de WhatsApp y lecciones portadas

Decisiones del CTO del 2026-10-06. Un producto hermano, construido desde el mismo scaffolding interno, ya está desplegado en la misma cuenta y verificado de punta a punta (alta con leads y mundos de invitado, landing con recorrido y video, páginas legales, WhatsApp vivo por End User Messaging Social, SES, ejecutor de escenarios). El CTO pidió seguir **la misma estrategia** acá: abrir el alta con los topes ya diseñados, fijar los datos del responsable que ese producto ya publica en producción, darle a este producto su propio número de WhatsApp y portar lo que su primer uso real enseñó sobre el agente, la salida, la observabilidad y la landing.

## Decidimos

### 1. El alta pública queda abierta

- El alta propia de invitados (ADR-0020) **se abre** con verificación del email por código y los topes contra abuso ya diseñados, sin un umbral de costo aparte: una cuenta por email, cupo de 40 mundos de alta propia y vencimiento, topes por mundo y por pool con el reloj real, reglas por tasa y Challenge del WAF, tope global de emails de autenticación, corte por presupuesto al 100 % (`docs/architecture-guests.md` §7, §8). El CTO acepta el costo del peor día del pool `SIGNUP` que esos topes acotan.
- **Abierta por defecto.** `signup.start` sigue leyendo `Runtime/SWITCH#SIGNUP` y una fila ausente sigue valiendo "cerrado" (falla cerrado); lo que cambia es quién la abre: `seed:load` (WP-34, en cada deploy de CI) la escribe `{open: true}` con `attribute_not_exists`. Así el alta se abre sola en el primer deploy que trae la fábrica de mundos, y un `npm run guests:signup-switch -- --off` del operador sobrevive a los deploys siguientes. `KILL#SIGNUP` (presupuesto, alarmas de reputación de SES) sigue cerrándola como antes.
- Ya no hay CTA alternativo: la landing nunca dice "Pedí acceso". Con el alta cerrada por el operador o por `KILL#SIGNUP`, `/signup` muestra el aviso fijo de `SIGNUP_UNAVAILABLE` con "Hablemos", y los CTA de la landing no cambian. Como en el producto hermano, la URL no se anuncia hasta que el camino de alta (WP-55) está desplegado.

### 2. CTA y "Hablemos"

- Landing y `/login`: **"Probar Reclamo en regla"** / "Try Reclamo en regla" → `/signup` (navegación completa, Challenge del WAF); **"Ingresar"** / "Sign in" → `/login`; **"Hablemos"** / "Let's talk" → `https://craftech.io/contact/` (formulario de contacto de Craftech) con UTM fijos y sin ningún dato del visitante: `?utm_source=reclamo-en-regla&utm_medium=demo&utm_campaign=poc-landing&utm_content=<ubicación>` (`header`, `drawer`, `hero`, `closing`, `footer`, `signup-unavailable`). Ningún `mailto:`.

### 3. Responsable de los datos y política de privacidad

Los mismos datos que el producto hermano publica en producción; nada inventado:

| Punto | Valor |
|---|---|
| Responsable | **Craftech**, Ciudad Autónoma de Buenos Aires, Argentina |
| Casilla de privacidad y de ejercicio de derechos | `sales@craftech.io`; también por el formulario `https://craftech.io/contact/` |
| Finalidad | Dar acceso al entorno de prueba y, solo con el consentimiento opcional, que Craftech contacte por esta solución |
| Base legal | Consentimiento (los dos consentimientos separados y sin tildar de ADR-0020) |
| Retención | 24 meses desde el último ingreso, o hasta que el titular pida el borrado (cuenta y lead); imágenes subidas, 2 días; sin copias de respaldo |
| Transferencia internacional | Los datos se alojan en AWS, en los Estados Unidos (`us-east-1`) |
| Derechos | Acceso, rectificación, actualización y supresión (Ley 25.326, arts. 14 a 16), gratuitos, por la casilla o el formulario |
| Leyenda | La del órgano de control de la Ley 25.326 (Agencia de Acceso a la Información Pública): acceso gratuito cada seis meses salvo interés legítimo y facultad de atender denuncias y reclamos |

Sin CUIT ni domicilio postal (no los inventamos) y sin marcas "a confirmar". Lo que dice la política es nuestra lectura, no asesoramiento legal; la inscripción de la base de leads en el registro del órgano de control queda a cargo de Craftech como responsable.

### 4. Aviso de leads

`LeadNotifyEmail` = la casilla `@craftech.io` que fija el operador (fuera del repo). Lo carga el operador con `npx sst secret set LeadNotifyEmail … --stage poc`; el código nunca lo escribe, y el cerco a una única dirección `@craftech.io` de ADR-0020 no cambia.

### 5. WhatsApp: número y WABA nuevos, propios de este producto

Este producto usará **un número y una WhatsApp Business Account propios**, no los del producto hermano. Todo está construido de punta a punta (adaptador, modo `live`, plantillas como código, destino de eventos, scripts, `SC-23`). WhatsApp es `simulated` con el simulador de teléfono en todo mundo salvo los que `infra/channel-modes.ts` lista en `liveWorlds` con una aprobación explícita (`whatsappLiveApproval`, fecha y aprobador), y solo `demo` y `qa-live-*` pueden figurar (ADR-0002).

### 6. El agente usa Claude Sonnet 5.5 por un perfil de inferencia de aplicación con tags

- El Harness y las tres estrategias de Memory usan `global.anthropic.claude-sonnet-5-5` a través de un **perfil de inferencia de aplicación** con los tags del app, llamado `<app>-<stage>-sonnet-5-5` (`infra/agentcore-spec.ts`). El nombre lleva el modelo: un cambio de modelo crea el perfil nuevo antes de borrar el viejo y el agente nunca queda sin modelo; el costo queda atribuido por tag.
- Tarifa: US$ 2 / 10 por millón de tokens de entrada / salida, con caché US$ 0,2 (lectura) / 2,5 (escritura); WP-46 la verifica con URL y fecha. Con las dos llamadas al modelo por turno que dejan las lecturas precargadas (§7), un turno típico es del orden de US$ 0,07 a 0,13 (supuesto hasta la medición de WP-46).
- El clasificador sigue con el modelo chico de ADR-0016 y el lector de comprobantes con el suyo: esta decisión cambia solo el agente y Memory.
- Lección del primer deploy: después de un cambio de modelo, la actualización de Memory puede fallar por propagación de IAM; se resuelve volviendo a correr el job de CI (`docs/architecture.md` §16).

### 7. Lecturas precargadas

El Harness ejecuta **en serie** las tools que pide una misma respuesta del modelo, y cada una cuesta una vuelta del Gateway, Cedar y la Lambda (de 0,8 a 3,5 s medidos en el producto hermano). Lo que todo turno necesita lo lee el código antes:

- `turns/preload.ts`, en el worker, después de los cortes y topes y del pre-filtro G1, y **antes** de invocar el Harness, corre en paralelo, con el `sessionToken` del propio turno y la firma en proceso de `createToolHandler` (las mismas cercas `LAM-*` que una llamada por el Gateway):
  - en todo turno, `identify_customer` (el cliente que resolvió el teléfono y su estado de identificación);
  - si la sesión está identificada, además `get_account` (resumen de cuenta, billetera y préstamos) y `list_operations` de los últimos 30 días del reloj del mundo (hasta 50 filas).
- Los reclamos abiertos del cliente ya los pone el código en `<facts>` desde `Complaints`; no hace falta una tool.
- Cada lectura deja su fila `Runtime/W#<w>#TURN#<turnId>/RESULT#…`, así lo que el modelo lee respalda a G2 y a la verificación igual que si hubiera llamado a la tool. Va al sobre como `<tool-result tool="…">` con `<`, `>` y `&` escapados en el JSON, y el prompt lo trata como dato. Una lectura que falla o no identifica queda afuera y el modelo la pide como antes.

### 8. Regla `ALWAYS_ANSWER`

Todo mensaje del cliente recibe respuesta: el agente responde, deriva o pide lo que falta; un saludo, un "ok" o un "gracias" reciben el estado breve de su cuenta y de su reclamo abierto. La regla le gana a cualquier nota de la memoria (el producto hermano mostró al agente siguiendo una conclusión de un turno fallido guardada en la memoria de la conversación). El prompt aclara que cada id de evento es un mensaje nuevo aunque el reloj simulado esté en pausa y repita la hora. La instrucción de exclusión de Memory suma "conclusiones sobre el funcionamiento del sistema, rechazos de envío o errores". Una conversación que ya aprendió una nota así se reinicia subiendo su `sessionEpoch`, el mismo mecanismo que un bloqueo de G1. La obligación `HOLDING_NOTICE` (`AGENT_SILENT`) sigue como red determinista.

### 9. Un mismo WhatsApp, una sola vez por turno

Si el modelo pide dos veces el mismo envío en un turno (mismo canal WhatsApp, mismo texto, o la misma plantilla con los mismos parámetros), `outbound/repeat.ts` contesta el segundo pedido con el mensaje ya enviado (`replayOf`), como a un evento reentregado, y no sale nada más: el chequeo corre **antes** de la política, no consume G2 ni deja una entrada nueva en la cinta, y se audita `OUTBOUND_REPLAYED` con el `messageId` original. Complementa a `LAM-ONCE-PER-EVENT` (que solo cubre `COMPLAINT_UPDATE`) y al claim `SEND#` (que cubre reintentos del mismo pedido, no pedidos nuevos iguales).

### 10. G2 con un saludo y scores en el log

Si el mensaje del cliente no pregunta nada (hasta tres palabras y sin "?"), la `query` de relevancia de G2 es la pregunta fija de estado "¿Cómo están mi cuenta y mi reclamo?" en lugar del texto del cliente: con "hola" como pregunta, cualquier respuesta útil queda en el borde del umbral de relevancia 0,5 y G2 la rechaza. Los umbrales, el grounding y el resto de G2 no cambian. Todo rechazo de G2 deja en el log (`outbound.g2_refused`) y en `AuditLog` el motivo y los scores de grounding y de relevancia, sin el texto.

### 11. Observabilidad: solo logs, 30 días, sin dashboards

La observabilidad sale de los logs JSON: las métricas son metric filters sobre esos logs, las alarmas miran esas métricas, no hay dashboards de CloudWatch ni tracing propio, y Model Invocation Logging sigue apagado. Todo log group del app retiene **30 días** (las anclas del registro, 180, por ADR-0014). El grupo `…-DEFAULT` del runtime del Harness lo crea AgentCore sin retención y ningún provider lo modela: sus 30 días son configuración manual declarada (`docs/architecture.md` §17), igual que `aws/spans`, configuración de la cuenta compartida.

### 12. Landing: sección de video y conmutador de idioma a 360 px

- Una sección **video** (`#video`) antes de "Cómo se integra" (`#integracion`, la sección de arquitectura): `<video controls preload="none" playsInline poster>` servido desde `public/landing/video/`, sin autoplay, con subtítulos en la imagen. No se muestra sin un video publicado (ningún placeholder); el CTA terciario del hero "Ver el recorrido (3 min)" baja a esa sección.
- El conmutador es/en nunca desborda a 360 px: ningún ancho de 360 a 1440 px tiene scroll horizontal, en los dos idiomas, con el header cerrado y con el menú abierto.

### 13. Diagrama de arquitectura renderizado por script

El diagrama de AWS del README y de la galería de la submission se dibuja en una **grilla**, con conectores ortogonales que nunca cruzan una caja e íconos oficiales de AWS de 56 px, y se renderiza a PNG con Playwright (`npm run diagram:render`, `scripts/diagram/render-architecture.ts`, escala 2). La versión de la submission marca los servicios del concurso que usa el producto (Amazon SES y AWS End User Messaging Social); la versión pública, la de la landing en `#integracion`, no lleva esas marcas (ADR-0019).

## Considered options

- **Mantener el alta cerrada hasta un umbral de costo** (ADR-0020 §6): los topes ya acotan el peor día y el CTO prefiere captar leads desde el primer deploy completo.
- **Lista de espera mientras tanto**: guarda consentimientos de direcciones sin verificar y cambia el CTA; el producto hermano la descartó por lo mismo.
- **`mailto:` para "Hablemos"**: el formulario de Craftech ya existe y concentra los contactos con UTM.
- **Reusar el número y la WABA del producto hermano**: mezcla las plantillas, los eventos y el display name de dos productos.
- **Quedarse en Opus 5 o pasar a Haiku 4.5**: con Opus un turno tardaba de 38 a 43 s; Haiku siguió su propia nota de memoria antes que la regla. Sonnet sigue mejor las reglas y, con dos llamadas por turno, la diferencia de velocidad es chica.
- **Pedirle al modelo que lea todo en un paso**: el modelo pide las lecturas juntas pero el Harness las corre en serie; no ahorra el tiempo de las lecturas.
- **Dashboards de CloudWatch**: cuestan por mes y nadie los mira en una POC; las alarmas y los logs alcanzan.
- **Alta abierta por seed, CTA único, formulario de Craftech, número propio, Sonnet 5.5 por perfil con tags, lecturas precargadas, `ALWAYS_ANSWER`, guarda de envío repetido, consulta fija de G2, logs solamente, sección de video y diagrama por script** (elegida).

## Consequences

- **Reemplaza**: ADR-0020 §6 "el alta arranca cerrada" y la condición del umbral de costo; ADR-0020 §9 "retención (supuesto)" pasa a decisión del CTO; ADR-0019 §4 "Probar la demo" y el "contacto de Craftech" pasan a §2 de esta decisión; ADR-0016 "el agente sigue en Opus" pasa a Sonnet 5.5; ADR-0002 suma que el número y la WABA son propios. `docs/landing-spec.md` §2.1, §2.2, §2.10, §9.1, §9.5 y §9.9 y `docs/architecture-guests.md` §4, §7, §10 y §16 quedan marcados donde esta decisión los reemplaza.
- Cada lección entra en los criterios de aceptación del WP dueño del archivo (`docs/build-plan.md`): WP-22 y WP-26 (G2 y guarda de envío repetido), WP-31 y WP-46 (modelo, perfil, tarifa), WP-33 (lecturas precargadas y `ALWAYS_ANSWER`), WP-34 (apertura del alta por `seed:load`), WP-37 (logs, 30 días, sin dashboards), WP-57 y WP-44 (CTA, legales, video, 360 px, diagrama público), WP-47 (`SC-00` asierta el alta abierta), WP-50 y el cierre del architect (diagrama de la submission).
- `docs/flows-catalog.md` suma `ALWAYS_ANSWER`, la consulta fija de G2 y las lecturas precargadas a FL-001, la guarda de envío repetido a FL-106 y los CTA, legales, video y 360 px a FL-102; FL-112 pierde "Pedí acceso".
