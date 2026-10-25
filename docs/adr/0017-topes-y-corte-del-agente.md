---
status: accepted
---

# Topes contra abuso con el reloj real, tope global y corte del agente sin deploy

La cuenta es compartida, las credenciales de invitado se comparten y cada turno de Opus cuesta. El reloj simulado lo maneja el invitado ("+1 h", avanzar), así que un tope contado en horas simuladas no limita nada, y un tope por mundo multiplicado por 15 a 17 mundos no tiene techo. AWS Budgets solo avisa, y un kill switch de Cedar exige un deploy por CI. Decidimos: todos los topes contra abuso con el **reloj real** (por remitente por hora, imágenes por conversación por día, turnos y lecturas de imagen por mundo de invitado por día); un **tope global** por hora y por día sobre todos los mundos públicos juntos (y otro para QA); y un **corte del agente en runtime** (`Runtime/KILL#AGENT`, y uno por mundo) que el worker, el clasificador y el lector miran antes de cada llamada a Bedrock, y que activan un supervisor del mundo `demo` o el aviso del 100 % del presupuesto (SNS → `BudgetBreaker`), sin deploy.

## Considered options

- **Topes en tiempo simulado**: el invitado los esquiva avanzando el reloj.
- **Solo `CED-KILL-SWITCH`**: necesita un deploy; queda como segunda capa.
- **Solo AWS Budgets**: avisa, no corta.
- **Reloj real + tope global + corte en runtime** (elegida).

## Consequences

- Con el corte o un tope alcanzado, el número y el acuse siguen saliendo por reglas deterministas y el reclamo pasa a una persona con un aviso fijo.
- `SC-19` prueba que "+1 h" no reinicia el tope, que el tope global y el corte por mundo frenan turnos sin llamar al Harness; el corte global y el de Cedar se prueban en `U` y post-deploy (activarlos en `poc` cortaría a los invitados).

## Enmiendas

- ADR-0020 (2026-09-26): suma el pool global `SIGNUP` (5 turnos por minuto real, 60 por hora real y 400 por día real, y 200 lecturas de imagen por día real) para los mundos de alta propia `gs-*`, separado del pool `PUBLIC` (`demo`, `gNN`, `gtest`), y topes por mundo de alta propia (60 turnos por día, 150 por época, 20 lecturas de imagen y 40 emails por día, 3 reinicios por día). Esos topes se miran antes de toda llamada que cuesta (clasificador, G1, Harness, lectura multimodal). La ejecución también se separa: cola `SignupCustomerEvents.fifo` y `SignupEventWorker` (concurrencia reservada 2), así los `gs-*` no ocupan los `EventWorker` de `demo` y de los `gNN`. `KILL#SIGNUP` lo activan además las alarmas de reputación de SES de la cuenta.
