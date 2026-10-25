---
status: accepted
---

# Las superficies públicas son de un producto, no de un concurso, y la landing es comercial

La POC publicada en `reclamo.demo.craftech.io` la va a abrir un cliente futuro (un prestamista de consumo o una billetera regulada de Latinoamérica), un partner o un evaluador, y la tiene que entender y probar solo. El estándar de Craftech para superficies públicas (skill `poc-landing`, fuera de este repositorio; decisiones del 2026-09-26) es vinculante. Las reglas del concurso, verificadas el 2026-09-26, **no exigen** mencionarlo en el proyecto publicado: exigen acceso gratis para probar hasta el fin del juzgamiento, credenciales en las instrucciones de prueba **privadas** si hay login, materiales de la submission en inglés y el código preexistente declarado en la submission.

Decidimos:

1. **Superficies neutrales.** Ninguna superficie visible (landing, `/signup`, `/login`, recuperación, consola, páginas legales, simulador de teléfono, visor de emails, emails, PDFs, plantillas de WhatsApp, textos del seed que ve un usuario, emails de Cognito) menciona hackathon, hackatón, Devpost, concurso, premio(s), jurado(s), juez, jueces, judge(s), evaluación, ni "AWS CDS" como certamen. El contexto del concurso vive solo en los documentos internos (`CLAUDE.md`, `CONTEXT.md`, `docs/`, agentes) y en una sección **"Submission notes"** separada, al final del `README.md`, que arranca como README de producto.
2. **El rol de los evaluadores es `GUEST`** ("Invitado" / "Guest"), con el mismo comportamiento que tenía `JUDGE` (un mundo aislado por cuenta) y el mismo vocabulario en enums, clases de mundo, rutas, auth, BFF, infra, seed, fixtures, tests, escenarios y docs: mundos `g01..g99`, `gtest`, `gprobe` (antes `j01..j99`, `jtest`, `jprobe`), usuarios `guest-NN` (antes `judge-NN`), plantilla `guest`. Las credenciales de los evaluadores van **solo** en las instrucciones privadas de la submission; también pueden darse de alta como cualquiera (ADR-0020).
3. **Guard en CI** `npm run lint:neutral-surfaces` (`scripts/lint/neutral-surfaces.ts`): recorre las fuentes visibles (`packages/web/src/**` salvo tests, `packages/web/public/**`, `packages/bff/src/copy/**`, `packages/bff/src/pdf/**`, `packages/bff/src/auth-triggers/custom-message*.ts`, textos del seed en `scripts/seed/data/**` que ve un usuario) y el build `packages/web/dist`, sin distinguir mayúsculas ni acentos, por palabra completa, y falla con archivo y línea. Corre junto a `lint:forbidden` en `ci.yml` y `deploy.yml`, con un test que falla por cada palabra. El identificador técnico del app (`aws-cds-hackathon-poc-reclamo`) es infraestructura, nunca texto visible: el guard también falla si aparece en `dist`, en un MIME renderizado o en un PDF.
4. **Landing comercial** en `/`, con la esencia de la landing interna de referencia (habla del producto, lo muestra con renders o capturas reales, dice qué es real y qué es simulado, galería con zoom) pero con identidad propia de este repo (paleta pino y rojo sello, display con serifa, wordmark "Reclamo en regla" con el sello dibujado): hero con propuesta de valor, problema, **recorrido del producto** sticky y conducido por el scroll (carrusel o pasos apilados en mobile) cuyas imágenes cambian paso a paso, qué resuelve por actor, reglas que garantiza el código, impacto como **metas** rotuladas, cómo se integra, qué es simulado y un llamado comercial: **"Probar la demo"** (`/signup`), **"Ingresar"** (`/login`) y **"Hablemos"** (contacto de Craftech). es/en, `prefers-reduced-motion`, accesibilidad AA y presupuestos de performance del estándar. La experiencia detallada (copy, motion, layout, manifiesto de capturas, UX de alta y login) es `docs/landing-spec.md`, del diseñador de UI/UX; los demás documentos la referencian y no la repiten.
5. **Imágenes honestas.** Hasta que existan las vistas de la consola (ola 5), el recorrido usa **renders animados construidos con los componentes y el copy reales** (`TapeRow`, `SlaChip`, `MoneyText`, `RuleChip`, burbujas de WhatsApp de las plantillas y del copy reales, la tarjeta del número de reclamo, una vista previa de email y de PDF) con datos sintéticos; nunca un mockup que prometa una función inexistente. Cada imagen provisoria figura en el **manifiesto de capturas** (`docs/landing-spec.md` §7) con la captura real que la reemplaza en WP-44, que la toma el pipeline de captura (Playwright sobre la consola servida localmente con un mundo sintético determinista, desktop y mobile).

## Considered options

- **Landing "de concurso"** (botón para jurados, recorrido de 5 minutos para jueces): no sirve para vender después y el reglamento no lo pide.
- **Mantener `JUDGE` en el código y cambiar solo los textos**: el vocabulario se filtra a rutas, usuarios, emails y capturas; dos nombres para lo mismo.
- **Mockups estáticos hasta tener la consola**: prometen lo que no existe y se desincronizan del producto.
- **Superficies neutrales, rol `GUEST`, landing comercial con renders de componentes reales y guard en CI** (elegida).

## Consequences

- `CONTEXT.md` reemplaza "Jurado" por **Invitado** (`GUEST`); ADR-0009, ADR-0011, ADR-0017 y ADR-0018 quedan con el vocabulario nuevo.
- El renombre de lo ya construido (olas 0 y 1) es un WP propio antes de la ola 2 (`docs/build-plan.md`, ola 1b): `WorldKind`, `StaffRole`, grupos de Cognito, `console:invite --guest`, `console:check-guests`, `guest-world.ts`, copy, rutas y tests.
- WP-44 pasa a ser "capturas reales y pulido final de la landing"; la landing comercial se construye antes, con renders.
- `security` suma a su revisión las superficies neutrales; `qa` verifica en Playwright (390×844 y 1440×900) la landing es/en, el recorrido con y sin `prefers-reduced-motion`, y el guard sobre `dist`.
- La glosa en inglés de la consola ya no se justifica "para jurados": es para usuarios que no leen español (ADR-0012).

## Enmiendas

- ADR-0021 (2026-10-06): el CTA primario es "Probar Reclamo en regla" / "Try Reclamo en regla" (→ `/signup`), sin variante "Pedí acceso"; "Hablemos" lleva al formulario `https://craftech.io/contact/` con UTM fijos; la landing suma una sección de video antes de "Cómo se integra" y el diagrama de arquitectura público renderizado por script; ningún ancho de 360 a 1440 px tiene scroll horizontal, tampoco el conmutador de idioma.
