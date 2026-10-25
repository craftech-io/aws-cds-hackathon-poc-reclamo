---
status: accepted
---

# Modos de canal por mundo: email en vivo solo salida, WhatsApp simulado salvo aprobación explícita y vivo solo en demo

El cliente vive en WhatsApp; la respuesta escrita va por email. Email por Amazon SES se puede operar hoy de verdad: la cuenta está en producción y el **simulador de buzones de SES** produce entregas, rebotes y quejas reales sin afectar la reputación de la cuenta compartida. WhatsApp por AWS End User Messaging Social necesita una WhatsApp Business Account, un número y plantillas aprobadas por Meta, y cada mensaje vivo llega a un teléfono real. Decidimos que cada canal tenga un **modo** (`live` o `simulated`) **por mundo** (`Worlds/…/SETTINGS.channelModes`): email `live` (solo salida, ADR-0003) en todos; WhatsApp `simulated` en todos con un transporte que persiste exactamente el JSON de `SendWhatsAppMessage` y un **simulador de teléfono** en la consola que entra por el mismo sobre SNS firmado y el mismo normalizador que un evento real. Solo `demo` (y un mundo QA explícito para `SC-23`) puede pasar a `live`, y solo con una aprobación explícita; los mundos de invitado, `gtest`, `qa-*` y `sim-*` siguen siempre en `simulated`.

## Considered options

- **Depender de una WABA para todo mundo**: ata el flujo central a un número real y a la revisión de Meta, y expone teléfonos reales a cada visitante.
- **Un chat web propio**: probaría otra cosa; el valor es que el cliente no instala nada.
- **Un modo global**: al encenderlo, todo mundo de invitado perdería su simulador y sus personas sintéticas (cuyos teléfonos no están en el cerco vivo), y el camino vivo no sabría a qué mundo pertenece un teléfono real que existe en `demo` y en cada `gNN`.
- **Modo simulado con el mismo contrato, por mundo** (elegida).

## Consequences

- `channels/whatsapp/` tiene dos transportes detrás de una interfaz; el transporte y el rechazo de sobres simulados leen el modo del mundo del mensaje. El topic SNS y la suscripción existen siempre.
- WhatsApp es `simulated` en todo mundo salvo los que `infra/channel-modes.ts` lista en `liveWorlds` con una aprobación explícita (`whatsappLiveApproval`, fecha y aprobador), y solo `demo` y `qa-live-*` pueden figurar; `npm run channels:check-modes` (CI) impide un mundo vivo sin aprobación o uno que no sea `demo` ni `qa-live-*`.
- El camino vivo resuelve un teléfono solo en un mundo vivo (`Runtime/LIVEPHONE#`), y `SeedOverrides.personaPhones` se aplica solo a `demo`; el E.164 real queda en el core solo para el transporte vivo.
- La ventana de 24 h se mide con el reloj del mundo en simulado y con el reloj real en vivo.
- El costo de WhatsApp de la demo se valoriza como si fuera vivo y se rotula.
- **Media entrante en vivo por prefijo.** En `GetWhatsAppMessageMedia`, `destinationS3File.key` es un prefijo al que el servicio le agrega el `mediaId` (referencia de la API, tipo `S3File`): la clave final no se predice. `InboundWhatsApp` anuncia el `SCANOBJ#` por el prefijo `wa/<worldId>/<wamid>/` (una imagen por mensaje), pasa ese prefijo como `key` y descubre la clave real con `ListObjectsV2` (`s3:ListBucket` con `s3:prefix = wa/*`), que guarda en `s3Key`; `media-intake/resolve.ts` lleva una `objectKey` `wa/…` a su anuncio quitando el último segmento, y `up/` y `sim/` siguen con clave exacta porque las arma el código. Tamaño, tipo mágico, cuarentena y plazo leen `s3Key`. El patrón `[A-Za-z0-9]+` del `mediaId` queda solo como validación de entrada. Se descartó predecir la clave (`prefijo + mediaId`): depende de un detalle del servicio que los mocks no ven y, si cambia, rompe todo el camino vivo sin que falle una prueba. `channels/whatsapp/media.test.ts` fija la semántica de prefijo con un mock que escribe en `key + mediaId`.

## Enmiendas

- ADR-0021 (2026-10-06): el modo `live` usa un número y una WhatsApp Business Account **nuevos, propios de este producto**, vinculados en AWS End User Messaging Social. Todo el camino vivo está construido y se prueba en `simulated`.
