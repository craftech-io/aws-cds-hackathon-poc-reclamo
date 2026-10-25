---
status: accepted
---

# Estado del reclamo en DynamoDB con máquina de estados en código y un schedule por hito

Un reclamo vive hasta 10 días hábiles, espera eventos externos (lote de la red, aprobación humana, respuesta del cliente, eventos de SES) y tiene hitos regulatorios que se cancelan al responder. Decidimos guardar el estado en **DynamoDB** con una **máquina de estados en código** (transiciones como datos, escritura condicional por `version` y estado de origen) y modelar cada hito como un **timer** con **un schedule de EventBridge Scheduler por hito** (`at()`, `ActionAfterCompletion DELETE`) que el reloj de demo sabe avanzar; un disparo tardío se descarta por estado, versión y época.

## Considered options

- **Step Functions por reclamo (Standard, con `waitForTaskToken`)**: la historia de ejecución es atractiva, pero el reloj de demo no puede adelantar un `Wait` de una ejecución en curso, los tokens de aprobación complican el reinicio por mundo, y el scaffolding registró un error de serialización del `Timeout` de SST 4.
- **Un solo schedule por reclamo que se reprograma**: esconde qué hito está pendiente y complica el descarte.
- **DynamoDB + un schedule por hito** (elegida).

## Consequences

- `transition()` es la única función que cambia el estado y escribe en la misma transacción la entrada del registro.
- Tres timers por reclamo (`OPERATOR_REMINDER`, `SUPERVISOR_ESCALATION`, `DEADLINE`); al responder, `CANCELLED` con versión nueva y `DeleteSchedule`.
- En un mundo `PAUSED` no hay schedules: el reloj despacha lo vencido; en `RUNNING` (con compresión) hay schedules reales, con nombre por mundo y época (`tm-<worldId>-e<epoch>-<hash del timer>`) para que dos mundos con los mismos timers de plantilla no choquen. El ejecutor prueba los dos caminos.
- Un timer se procesa siempre a su hora simulada (`eventAtSim = dueAtSim`), aunque el Scheduler llegue hasta un minuto real tarde; la publicación de un lote despacha ella misma sus rechequeos, así ningún efecto depende del orden de llegada.
