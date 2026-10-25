---
status: accepted
---

# Grounding en código sobre documentos sintéticos cortos, sin Knowledge Base

Las respuestas sobre condiciones, tarifas y derechos del reclamo tienen que estar fundadas. Los documentos son nuestros, sintéticos y cortos (≈ 45 cláusulas numeradas) y cambian por versión. Decidimos **no** usar una Knowledge Base: `get_terms` y `check_charge` devuelven cláusulas por tema o id desde `Reference`, deterministas, y G2 usa esas cláusulas (y los resultados de tools del turno) como fuente de contextual grounding.

## Considered options

- **Knowledge Base sobre S3 Vectors**: recuperación semántica innecesaria para 45 cláusulas; ingestión y costo; el scaffolding registró que S3 Vectors reserva los nombres que empiezan con `aws` (el app empieza con `aws-cds-`); la recuperación variable complica un eval reproducible.
- **Documentos en el system prompt**: ocupan contexto en cada turno y no dejan rastro de qué cláusula se usó.
- **Recuperación determinista por tema e id** (elegida).

## Consequences

- El eval `EV-1` exige las cláusulas esperadas en `TURN#`, no solo un puntaje.
- Los calificadores de contextual grounding de G2 van solo en `REPLY` con cifras o hechos y en el `draftBody` de la respuesta escrita; los textos cortos de servicio no se evalúan contra grounding (darían `GROUNDING_FAIL` falsos).
- El umbral de grounding (0,75) es provisional: se calibra con `EV-1` antes de congelarlo y el valor calibrado se registra en esta ADR.
- Si más adelante los documentos crecen, una Knowledge Base se agrega con ADR y con el nombre de vector bucket `kb-<app>-<stage>-…`.

## Enmiendas

- ADR-0021 (2026-10-06): si el mensaje del cliente no pregunta nada (hasta tres palabras y sin "?"), la `query` de relevancia de G2 es la pregunta fija "¿Cómo están mi cuenta y mi reclamo?"; los umbrales no cambian. Todo rechazo de G2 deja en el log y en `AuditLog` el motivo y los scores de grounding y relevancia, sin el texto.
- Ola 6 (2026-10-10): cómo se calibra el umbral. Cada mensaje que G2 deja salir guarda sus scores de grounding y relevancia en la fila del mensaje (`Message.g2`, sin el texto), y cada rechazo los deja en `AuditLog` (`OUTBOUND_G2_REFUSED`). `EV-1` los lee con la acción `turn.inspect` del `QaDriver` y propone el umbral como el percentil 5 de los scores de grounding de **todas** las respuestas a preguntas bien fundadas que G2 juzgó por grounding (las enviadas **y** las rechazadas por `GROUNDING`; un rechazo por relevancia no cuenta), redondeado hacia abajo a 0,05 y acotado entre 0,50 y 0,90 (`scripts/evals/score-grounding.ts`). Tomar solo las enviadas daría un trinquete de un solo sentido: verían únicamente scores que el umbral vigente ya dejó pasar y nunca podrían proponer uno más bajo. El reporte informa además cuántas de esas respuestas buenas rechaza el umbral vigente y cuántas rechazaría el propuesto. Hasta la primera corrida de `EV-1` en `poc`, que necesita el OK del CTO por el gasto en Bedrock, el umbral sigue en 0,75; el valor calibrado, con N y fecha del reporte, se registra en esta lista.
