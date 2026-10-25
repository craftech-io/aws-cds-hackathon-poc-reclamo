---
status: accepted
---

# Registro de reclamos append-only con cadena de hash anclada fuera de las tablas

La norma pide números correlativos y una base que solo se modifica para agregar presentaciones o información de estado. Una tabla con `UpdateItem` sobre el estado no lo garantiza. Decidimos que el **registro** sea una tabla de **eventos inmutables** (`FILED`, `STATUS`, `FINAL_ANSWER`, `DELIVERY_PROOF`, …) con `seq`, `prevHash` y `hash` encadenados (HMAC con `RegisterChainKey`, publicada con cada exportación), y que **ningún rol del app** tenga `UpdateItem`, `DeleteItem` ni `BatchWriteItem` sobre ella (política y boundary). El estado corriente del reclamo vive aparte (`Complaints`) y cada transición escribe su evento en la misma transacción.

**Escritura optimista sin huecos.** No hay contador reservado antes de escribir (una transacción cancelada dejaría un `seq` consumido sin entrada y dos escritores concurrentes no sabrían el `prevHash`). `appendChained` lee la cabeza (`COUNTER#REGSEQ#e<epoch>` con `{seq, hash}`) con lectura fuertemente consistente y manda **una** `TransactWriteItems` con el `Update` de la cabeza condicionado a `seq = n − 1`, el `Put` de la entrada con `attribute_not_exists` y los items del llamador (p. ej. el reclamo); una cancelación relee y reintenta, y no consume nada. El número de reclamo usa el mismo esquema. El registro de reintegros (`RRI#`) y la cinta de cumplimiento (`TAPE#`) también.

**Qué garantiza y qué no.** IAM no puede exigir una `ConditionExpression`: un rol con `PutItem` podría sobrescribir una entrada. Eso **no se impide, se detecta**: cada entrada se **ancla** (`{worldId, epoch, seq, hash}`) en un log group de CloudWatch Logs que ningún rol del app puede borrar ni recortar (deny en la boundary). El ancla la escribe **solo** `AnchorWriter`, que relee la entrada comprometida: los roles que escriben las tablas no tienen `PutLogEvents` (deny en la boundary). Como `PutLogEvents` acepta un `timestamp` elegido por el cliente, la verificación ordena las anclas por `ingestionTime`: vale la **primera ingerida** de cada `seq`, dos anclas que no coinciden son `ANCHOR_CONFLICT` (rotura) y un `seq` sin ancla deja el resultado en `partial`, nunca en `ok`. Así una sobrescritura se delata en toda entrada anclada aunque quien sobrescribe recalcule los hashes con la clave publicada y agregue un ancla atrasada; y los PDFs del acuse y de la respuesta escrita, que el cliente ya recibió por SES, llevan el hash de `FILED` y de `FINAL_ANSWER`. Así se les dice a los evaluadores, con el límite explícito: una entrada sin ancla se muestra sin verificar, y un administrador de la cuenta puede borrar anclas (lo borrado queda `partial`).

## Considered options

- **QLDB**: discontinuado.
- **Estado mutable + historial en un atributo**: modificable por quien escribe el item.
- **S3 Object Lock como registro**: garantiza inmutabilidad pero complica consultas, cadena y reinicios por mundo. Como **ancla** (modo governance, retención de 1 día, compatible con removal `remove`) es una alternativa válida al log group; elegimos el log group por simpleza.
- **Contador atómico reservado antes de escribir**: deja huecos ante una cancelación y carreras de `prevHash`.
- **Eventos inmutables en DynamoDB + IAM + cadena + ancla externa** (elegida).

## Consequences

- Un reinicio de mundo no borra el registro: la época nueva usa otra partición y la vieja vence por TTL fijado al escribir. `AuditLog` sigue la misma regla (append-only, conservado a través de los reinicios).
- La exportación incluye el resultado (`ok`, `partial` o `broken`), el hash de cabeza, la clave y las anclas con su `ingestionTime`; `scripts/register/verify.ts` verifica un archivo sin acceso al stage con las mismas reglas.
- `register.tamperProbe` prueba en `poc` que actualizar y borrar dan `AccessDenied`, que una sobrescritura con `PutItem` la detecta la verificación (`brokenAt`) y que una sobrescritura con los hashes recalculados más un ancla falsa con `timestamp` atrasado da `ANCHOR_CONFLICT`.
- Una Lambda más (`AnchorWriter`) y una invocación asíncrona por escritura encadenada; su falla alimenta la alarma `AnchorWriteFailed`.
- La retención de 10 años de la norma se recorta en la POC a la vida del stage (declarado).
