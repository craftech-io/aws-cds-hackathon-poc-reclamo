---
status: accepted
---

# Los flujos se prueban en el stage con un ejecutor de escenarios y un principal de QA propio, sin credenciales guardadas

"100 % probada" exige ver cada flujo con los servicios reales: el Harness decidiendo, Bedrock leyendo un comprobante, SES entregando al simulador y devolviendo sus eventos, el Scheduler disparando un hito, Cognito emitiendo tokens. Las pruebas locales con un Harness guionado prueban la plomería, no el agente. Decidimos correr un **ejecutor de escenarios** (`scripts/scenarios/`) contra `poc`, solo desde CI, a través de una Lambda **`QaDriver`** sin URL, invocable solo por el rol **`aws-cds-hackathon-poc-reclamo-qa-runner`** que crea el bootstrap; cada escenario trabaja en su propio **mundo** `qa-<runId>-<escenario>`, con su propia cola, y asierta sobre estado persistido, registro y cinta.

Las vistas de consola en `poc` (`SC-21`, `SC-22`, el login del smoke) no usan un formulario con una contraseña guardada: `auth.session({sessionKey, …})` crea (o reutiliza) un usuario efímero de Cognito `qa-<runId>-<escenario>-<rol>` en un mundo QA, hace un login real **dentro de la Lambda** con una contraseña aleatoria que nunca sale y devuelve solo tokens de 15 minutos, sin refresh token. Cada llamada con la misma `sessionKey` emite tokens nuevos con un `auth_time` nuevo, así un recorrido de 20 minutos re-emite antes de que venzan y antes de cada paso que exige login reciente; el usuario vive hasta `world.destroy` o `WorldJanitor`. Playwright inyecta esos tokens y el `Bff` real los verifica (acepta la audiencia `ServerClient` solo si `cognito:username` empieza con `qa-` **y** la fila de staff del usuario apunta a un mundo `qa-*`; el pool es basado en nombre de usuario, `docs/architecture.md` §11). El formulario de login y el modal de login reciente se prueban localmente con Cognito mockeado; el camino real del invitado (usuario creado por el código de `console:invite`, login SRP a través del trigger desplegado) lo prueba `SC-22/8`.

## Considered options

- **Solo pruebas locales**: no prueban permisos, propagación de IAM, entregas de SES ni Cedar de verdad.
- **Playwright con usuarios reales o una cuenta sintética con contraseña en un secreto de CI** (`guest-test`): exige credenciales persistentes en CI y un login humano para cubrir lo demás.
- **Invocar las Lambdas de producto desde el runner**: permisos amplios y medio sistema reimplementado.
- **Un driver con acciones acotadas y sesiones efímeras** (elegida).

## Consequences

- El `QaDriver` solo muta mundos `qa-*` (y una lista cerrada sobre `qamin`); un invitado nunca ve una corrida ni le quita capacidad. **IAM** cierra lo que el `QaDriver` hace con su propio rol: DynamoDB (`LeadingKeys` de mundos QA; `gprobe` solo lectura), la cola (solo `QaCustomerEvents.fifo`), S3 (`qa/*`), el Scheduler (`tm-qa-*`), las anclas (streams `qa-*`) y `EmailEvents` (sin permiso). Lo que hace **a través de otra Lambda que escribe con su propio rol** no lo cierra IAM sino una firma o un chequeo en esa Lambda: `InboundWhatsApp` acepta la clave de sobre del `QaDriver` (`QaSimEnvelopeKey`) solo para `qa-*`, `qamin` y `sim-*`; `ScheduleDispatch` decide desde el timer y el reloj guardados y descarta todo disparo en un mundo en pausa o fuera de hora; `CoreMock` y `NetworkMock` solo se alcanzan por Function URL y autorizan el mundo contra el rol invocante; `WorldJanitor` exige un ticket que el `QaDriver` no puede escribir en un mundo de invitado y toma la época de la tabla. `qa-driver/guard.ts` es una capa más, no la única. `fence.probe(WORLD_PATHS)` prueba los cuatro caminos contra `gprobe`, un mundo de clase `GUEST` que nadie usa (`SC-18/10`); la tabla completa está en `docs/architecture.md` §14. Un administrador de la cuenta compartida queda fuera de estas cercas (riesgo residual declarado).
- Las acciones de consola corren el `appRouter` real con un principal armado en el servidor (`OPERATOR`, `SUPERVISOR`, `COMPLIANCE` y, solo en `qa-*`, `GUEST`); nada saltea la compuerta, Cedar ni la máquina de estados.
- `SC-21` y `SC-22` corren sobre mundos QA de plantilla `guest` servidos por el `Bff` real (por eso el `Bff` alcanza `qa-*`); `SC-21` nunca ve el modal de login reciente porque re-emite la sesión antes; `guest-test` queda para una verificación manual opcional del operador, fuera de la compuerta.
- El registro y la cinta de un mundo QA no se borran (append-only): vencen por TTL; `WorldJanitor` limpia lo que deje un job cancelado.
- La suite completa cuesta turnos de Bedrock: se corre a pedido y antes de cada entrega, con tope y chequeo previo de actividad de invitados; en cada deploy solo el smoke.
