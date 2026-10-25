---
status: accepted
---

# El clasificador de entrada usa un modelo chico; el agente sigue en Opus

El número de reclamo tiene que salir en menos de 5 s (ADR-0015), y el clasificador está en ese camino cada vez que las reglas deterministas no alcanzan (un invitado que escribe con sus palabras). Con el mismo perfil global de Opus que el agente, el tiempo al primer token más la salida forzada y un arranque en frío superan a menudo el timeout de 3 s, y cada caso termina `UNCLEAR`: el número llega recién después de un turno completo. Decidimos que `classifierModelId` sea un **perfil de inferencia global de la familia Claude Haiku**, con el id exacto confirmado `ACTIVE` en el paso 0 del deploy; `receiptModelId` sigue en Opus mientras `EV-2` no demuestre que uno más chico alcanza; el Harness sigue en Opus.

## Considered options

- **Opus para todo**: más simple, pero pone en riesgo el número en el acto y el recall de `EV-3`.
- **Solo reglas**: rígido frente a texto libre de un invitado.
- **Reglas que cubren todos los guiones + Haiku para lo demás** (elegida).

## Consequences

- `intake/classifier.test.ts` exige que todo guion de persona de un flujo de reclamo lo resuelva una regla: los escenarios no dependen del modelo para el número.
- `EV-3` mide exactitud y latencia del camino por modelo (p95 < 3 s); `SMK/4` informa el p95 del acuse.
- Cambiar de modelo (en cualquiera de los tres usos) es un cambio con ADR y con `EV-2`/`EV-3` en umbral.

## Enmiendas

- ADR-0021 (2026-10-06): **el agente deja Opus**. El Harness y Memory usan `global.anthropic.claude-sonnet-5-5` por un perfil de inferencia de aplicación con tags (`<app>-<stage>-sonnet-5-5`), con las lecturas precargadas del worker y la regla `ALWAYS_ANSWER`. El clasificador sigue con el modelo chico de esta decisión y el lector de comprobantes con el suyo.
