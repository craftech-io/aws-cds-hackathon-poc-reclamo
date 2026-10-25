---
status: accepted
---

# Idiomas

El producto es para consumidores de Argentina; los evaluadores leen en inglés. Decidimos: consola, textos al cliente, plantillas, emails y PDFs en **español rioplatense** (con glosa en inglés de los textos fijos en el simulador y el recorrido, y de la navegación, los encabezados, los botones clave y el banner de la cinta en la consola); landing es/en con conmutador; README, instrucciones para invitados y materiales de submission en **inglés**; documentación interna (`CLAUDE.md`, `CONTEXT.md`, `docs/`, ADRs, casos de QA) en español; código, identificadores, comentarios y commits en inglés.

## Considered options

- **Todo en inglés**: la demo dejaría de parecer un reclamo real de un consumidor argentino.
- **Todo en español**: los evaluadores no podrían seguir la submission.

## Consequences

- Un texto tiene una sola fuente en `packages/bff/src/copy/` (y `copy/en-gloss.ts` para la glosa).
- El README en inglés incluye un glosario corto (complaint, register, tape, reglas `CH-*`, estados) y un resumen en inglés de la arquitectura y de las reglas de política, con enlaces a los documentos internos en español.
- El detector de idioma de la verificación exige español en todo saliente al cliente.
