---
status: accepted
---

# Reusamos el scaffolding interno de Craftech del período de la hackathon

Hay seis semanas hasta el cierre y dos referencias internas de Craftech creadas en el mismo período: un app completo, desplegado y probado (SST, CI con OIDC y bootstrap, patrón de AgentCore con Harness, Gateway, Memory, Policy y Guardrails, pipeline de salida de SES con cerco de destinatarios, login propio sobre Cognito, consola y componentes, landing con galería, herramienta de capturas, tooling de seed, lint de tamaño y duplicados, agentes de `.claude/`) y un diseño con scaffold (catálogo de flujos, plan de pruebas con ejecutor de escenarios y `QaDriver`, simulador de teléfono y adaptador de WhatsApp, reloj de demo por mundo, guard de términos prohibidos y de propiedad de archivos). Decidimos **copiar o adaptar lo genérico** de las dos, según `docs/reuse-map.md`, y escribir de cero todo lo del dominio (reclamos, registro, core, redes, política de canal).

## Considered options

- **Empezar de cero**: repetiría semanas de trabajo ya probado (y los errores de sus primeros deploys).
- **Fork de una referencia**: arrastraría su dominio, sus nombres y su historia de commits a un repo que no puede nombrarlos.
- **Copia selectiva con mapa de reuso** (elegida).

## Consequences

- El README declara que el patrón de AgentCore y de CI viene de scaffolding interno de Craftech del período, sin nombrar productos ni clientes.
- Todo archivo copiado pasa `lint:forbidden` (la lista externa incluye los nombres y dominios de las referencias).
- Las lecciones de sus primeros deploys vienen resueltas en el código que se copia (`docs/architecture.md` §16).
