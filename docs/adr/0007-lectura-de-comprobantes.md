---
status: accepted
---

# Lectura de comprobantes con Bedrock multimodal y un respaldo determinista solo para cuando Bedrock no está

El cliente manda una foto del comprobante. Leerla con Bedrock (multimodal) muestra un servicio real y maneja fotos imperfectas; pero un modelo puede leer mal, alucinar un campo o seguir texto impreso en la imagen. Decidimos: `Converse` con la imagen y **salida forzada** a una sola tool con schema, temperatura 0, sin historia ni otras tools; imágenes de hasta 3,75 MB y 8.000 px por lado (el máximo que acepta `Converse`; por encima, se pide una foto más liviana en todos los caminos de entrada); validación por código (formato y dígito verificador del código de operación); un **parser de respaldo determinista** que lee un chunk PNG de nuestros comprobantes sintéticos legibles; y que **nada leído imputa**: la imputación exige una línea `MATCHED` de la rendición publicada, del mismo cliente.

El respaldo se usa **solo** cuando Bedrock no está disponible (timeout, throttling o error después de los reintentos) y como cruce de una lectura `CLEAR`; **nunca** rescata una lectura `ILLEGIBLE` o `PARTIAL`. Si lo hiciera, la demo parecería leer una foto borrosa cuando en realidad lee metadatos ocultos que una foto real no tiene. Las variantes borrosas y "no es un comprobante" no llevan chunk.

## Considered options

- **OCR propio o Textract**: suma un servicio para leer campos que igual hay que conciliar; no aporta a la narrativa.
- **Solo el parser de respaldo**: no demuestra lectura real de una foto.
- **Solo Bedrock**: sin plan B ante throttling ni forma de detectar una lectura en desacuerdo.
- **Respaldo que completa lecturas ilegibles**: haría pasar `EV-2` sin probar nada y engañaría a un evaluador.
- **Bedrock + validación + respaldo solo ante indisponibilidad + conciliación obligatoria** (elegida).

## Consequences

- La imagen nunca llega al Harness; `suspiciousText` se audita y no cambia la decisión; los campos leídos nunca se loguean en claro.
- `ILLEGIBLE` → `UNREADABLE` haya o no chunk; `DISAGREE`, dígito inválido o ilegible dos veces → caso humano, sin acusar al cliente.
- `EV-2` mide exactitud por variante, exige que las borrosas den `UNREADABLE` o una lectura exacta **de Bedrock**, un subconjunto de los comprobantes que usan los escenarios al 100 % y 0 imputaciones indebidas.
