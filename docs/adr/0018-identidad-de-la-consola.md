---
status: accepted
---

# El mundo de un usuario de la consola sale de su fila de staff, y el navegador no administra la cuenta

Todo usuario autenticado de Cognito recibe por defecto un access token con el scope `aws.cognito.signin.user.admin`, que le permite llamar la API de Cognito desde el navegador: cambiar sus atributos, su contraseña o borrar su cuenta. Con un atributo `custom:worldId` editable, un invitado podría apuntarse al mundo `demo` o al de otro invitado; con cuentas `guest-NN` compartidas, uno podría cambiar la contraseña y dejar afuera a los demás. Decidimos: `custom:worldId` **inmutable**, escrito solo por `AdminCreateUser` y fuera de los atributos que escribe el cliente; el trigger **pre-token V2** toma mundo, rol y `staffId` **solo** de la fila `STAFF#` del mundo (vía `BySub`), nunca del atributo, y **suprime** el scope de administración para todo grupo; un mundo de invitado lo crea `console:invite` (pre-registro, `create_world`, `READY`) antes de entregar la credencial, y el trigger **nunca escribe un mundo**: solo lee la fila de staff y `META`, exige `READY` (si no, falla el login con un mensaje fijo y audita `WORLD_NOT_READY`) y suprime el scope, dentro del tope de 5 s de Cognito (crear un mundo escribe cientos de transacciones encadenadas y no entra ahí, y los reintentos del trigger correrían creaciones en paralelo); los cambios de contraseña del personal pasan por el BFF con APIs de administrador después de verificar la contraseña actual; la recuperación de contraseña es solo por administrador.

## Considered options

- **Rechazar el cambio en el BFF**: el navegador llama a Cognito directo y lo saltea.
- **Atributo inmutable solamente**: sigue habilitando `ChangePassword` y `DeleteUser` sobre cuentas compartidas.
- **Mundo desde la fila de staff + scope suprimido + atributo inmutable** (elegida).

## Consequences

- El user pool usa el plan `ESSENTIALS` (lo exige personalizar el access token).
- Salir de la consola es `RevokeToken`; el alta de TOTP del personal ocurre dentro del login (`MFA_SETUP`).
- `auth-triggers/triggers.test.ts` y `SC-22/5` prueban que las tres llamadas devuelven `NotAuthorizedException` y que un atributo falsificado nunca cambia el mundo.
- `SC-22/8` crea un usuario de invitado con el mismo código de `console:invite` en un mundo `qa-*`, hace un login SRP real a través del trigger desplegado (p95 < 3 s) y exige que la consola abra en un mundo prístino; `console:check-guests` verifica cada `gNN` antes de entregar credenciales (que van solo en las instrucciones de prueba privadas).
- El trigger no tiene `WORLDS`: su rol solo lee `Worlds` y escribe su `AuditLog` (`docs/architecture.md` §14).

## Enmiendas

- ADR-0019 (2026-09-26): el rol `JUDGE` pasa a llamarse `GUEST` (mundos `gNN`, `gtest`, `gprobe`; usuarios `guest-NN`), mismo comportamiento.
- ADR-0020 (2026-09-26): los invitados de alta propia (`gs-*`) ingresan con su mundo en cualquier estado (el trigger sigue siendo de solo lectura y agrega el claim `worldStatus`). Como no tienen `custom:worldId` ni grupo, para ellos el atributo inmutable y "rol ∈ grupos" se reemplazan por un invariante bidireccional que verifican el trigger y `principalFromClaims` (nombre con `@` ⇔ mundo `gs-*`, `role GUEST`, sin grupos ni atributo, mundo igual al del lead de ese `sub`; `docs/architecture-guests.md` §3); para todo nombre sin `@` rigen las dos señales de siempre. Para leer el mundo del lead, el rol del trigger suma un `GetItem` sobre `Leads` limitado al atributo `worldId`. La recuperación por email verificado vale **solo** para los invitados de alta propia y siempre a través del BFF: el personal y los `guest-NN` siguen con recuperación **solo por administrador**, porque `console:invite` no marca `email_verified` en el personal, el ACL de Cognito bloquea `ForgotPassword` y `ConfirmForgotPassword` para todo cliente distinto del `GuestSignupClient`, y `password.*` solo actúa sobre cuentas de alta propia. Ningún `AuditEntry` lleva un nombre de usuario con `@`.
