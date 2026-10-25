---
status: accepted
---

# Reloj de demo por mundo, en pausa por defecto y con compresión

La historia central dura 10 días hábiles; un invitado tiene minutos. Además, varios invitados y el ejecutor usan el stage a la vez. Decidimos un **reloj por mundo** (`Runtime/W#<worldId>#CLOCK`) inyectado en toda la lógica: `PAUSED` por defecto (se avanza con "Avanzar al próximo evento", "+1 h", "+1 día hábil"), o `RUNNING` con un **factor de compresión** (`rate`, por defecto 1440: un día simulado por minuto real) que crea schedules reales; todo lo que pasa a una hora simulada es un timer que el reloj sabe despachar. Un mundo por invitado, épocas que nunca vuelven atrás y reinicio por mundo.

## Considered options

- **Tiempo real**: un invitado no puede ver un vencimiento.
- **Reloj global**: un invitado le movería el tiempo a otro.
- **Reloj por mundo con pausa y compresión** (elegida).

## Consequences

- Ningún módulo llama `Date.now()` para lógica de negocio; el plazo y los hitos se calculan en tiempo simulado.
- `WORLD_BUSY` impide mover el reloj con un turno o un email en vuelo.
- `rate` va de 1 a 2.880 desde la consola, con hasta 50 schedules por mundo; los topes contra abuso **no** usan este reloj sino el real (ADR-0017).
- "Avanzar al próximo hito de este reclamo" avanza hasta el próximo timer del reclamo elegido, así el recorrido no depende de cuántos timers de plantilla hay en el medio.
- Reiniciar un mundo sube la época: sesiones, actores de Memory (`w-<worldId>-…`, así la memoria de un mundo nunca aparece en otro) y particiones del registro nuevos; el registro y la bitácora de la época vieja quedan intactos (append-only).
