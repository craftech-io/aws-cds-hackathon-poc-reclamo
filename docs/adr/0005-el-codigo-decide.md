---
status: accepted
---

# El código decide topes, plazos, elegibilidad y política; el modelo investiga y redacta

En un reclamo financiero, la plata, el plazo y lo que se le promete al cliente son responsabilidad del prestamista. Un modelo puede equivocarse o ser manipulado (texto, imagen). Decidimos que **todo número y toda decisión** salgan de código: montos del core, topes por acción y por tier (`AGENT`, `OPERATOR`, `SUPERVISOR`), elegibilidad de adjuntos, transiciones, plazo e hitos, número de reclamo, política de canal. El agente elige qué tool llamar, interpreta lo que el cliente quiere, investiga y redacta; las acciones exigen la evidencia de su investigación y sobre el tope solo puede **pedir** aprobación. No existe una tool que apruebe: aprueba una persona en la consola con login reciente.

## Considered options

- **Límites en el prompt**: no son verificables ni resisten una inyección.
- **Aprobación automática por puntaje del modelo**: traslada la responsabilidad a algo no auditable.
- **Código decide, modelo investiga** (elegida).

## Consequences

- `LAM-EVIDENCE` y `LAM-CAP` en las tools de acción; `capOverride` y `decision` declarados en el schema y prohibidos por Cedar y zod.
- Las aprobaciones se ejecutan en el worker por código con el monto del core, nunca con un monto del modelo ni con lo que diga el evento: `execute_approved_action` relee la aprobación, reclama la ejecución una vez y recalcula el monto.
- Toda acción de dinero toma en el core un claim por su clave natural (código de operación, cargo, débito, transferencia): una sola ejecución aunque haya dos reclamos.
- Lo que el reclamo exige después de un turno (la respuesta escrita, la conciliación, un aviso) lo garantizan obligaciones deterministas del worker, no la memoria del modelo.
- El acuse y el número los da el código, no el modelo (ADR-0015).
- La respuesta al desafío de identidad sale del cliente, no del modelo: `verify_challenge` solo acepta una respuesta que aparece en un mensaje entrante del cliente escrito después del último `IDENTITY_CHALLENGE` que salió y antes de que se abriera el turno (reloj real, leído por el `sessionToken`, nunca de un campo que escriba el modelo), la normaliza (fechas d/m, dd/mm, con o sin año; montos es-AR), le manda al core el fragmento que escribió el cliente y usa cada mensaje una sola vez. Lo demás se rechaza con `INVALID` (`CHALLENGE_NOT_ASKED`, `ANSWER_NOT_WRITTEN`, `ANSWER_ALREADY_USED`), se audita `CHALLENGE_ANSWER_REFUSED` y no cuenta un fallo del cliente. El texto del desafío no trae un ejemplo que pueda ser una respuesta válida.
