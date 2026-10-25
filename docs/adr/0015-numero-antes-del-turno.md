---
status: accepted
---

# El número de reclamo lo da el código antes del turno y antes del desafío

La norma pide el número **en el acto** cuando la presentación entra por un canal automático, y el objetivo es < 5 s. Un turno del Harness con desafío de identidad tarda más y depende de que el modelo decida registrar. Decidimos un **clasificador de entrada** (reglas deterministas y, si no alcanzan, `Converse` con salida forzada sobre un modelo chico, ADR-0016) en `InboundWhatsApp`: si es un reclamo de un teléfono vinculado, el código registra (número, entrada `FILED`, reclamo e hitos en una transacción), y manda el acuse con número, tipo y plazo **antes** de encolar el turno. El acuse no revela datos de la cuenta, así que no necesita el desafío; el desafío se exige antes de revelar datos o actuar.

## Considered options

- **El agente registra en el turno**: más lento y dependiente del modelo.
- **Registrar todo mensaje**: registraría saludos y consultas que la norma no pide registrar.
- **Clasificador + registro por código antes del turno** (elegida).

## Consequences

- El agente puede registrar lo que el clasificador dejó pasar (`register_complaint`), nunca desregistrar.
- Un reclamo abierto del mismo tipo no genera número nuevo.
- `ackLatencyMs` se mide desde la recepción del mensaje hasta la aceptación del transporte, en `poc`; mientras WhatsApp sea simulado, el rótulo lo dice (no incluye el tramo de Meta). El objetivo p95 < 5 s se mide sobre la suite, con los arranques en frío aparte.
