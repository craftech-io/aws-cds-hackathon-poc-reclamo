---
status: accepted
---

# Un solo punto de salida con motor de política de canal y cinta de cumplimiento

La regla que más importa (nunca cobranza por WhatsApp) tiene que valer para el agente, para el sistema y para los operadores humanos. Si cada emisor evaluara la política por su cuenta, alcanza con que uno lo olvide. Decidimos que todo mensaje salga por **una función**, `sendThroughGate` (`packages/bff/src/outbound/gate.ts`), que corre el motor de política de canal (reglas `CH-*`, módulo puro), render (con el aviso de automatización del primer saliente), G2, verificación determinista y cerco, escribe la decisión `ALLOWED` en una **cinta de cumplimiento** append-only **antes** del transporte, toma un claim de envío, transporta y asienta el resultado (`DISPATCH`); toda decisión, también `BLOCKED` y `DEFERRED`, queda en la cinta, y un bloqueo con camino permitido ofrece reencaminamientos que vuelven a pasar por la compuerta.

## Considered options

- **Política en cada tool y en la consola**: duplicada y olvidable.
- **Solo Cedar**: Cedar ve el input de las tools del agente, no los envíos del operador ni el contenido renderizado.
- **Solo guardrails**: probabilísticos; no cubren ventana, horario, opt-in ni reencaminamiento.
- **Compuerta única en código + cinta** (elegida).

## Consequences

- `lint:chokepoint` falla si un comando de envío (`SendEmailCommand`, `SendRawEmailCommand`, `SendWhatsAppMessageCommand`) aparece fuera de `outbound/transports/` (la descarga de media de WhatsApp tiene su propio archivo); solo los roles con `PIPELINE` pueden llamar a SES y EUM Social; `EmailEvents` solo encola.
- Un reintento después de un envío aceptado encuentra el claim y nunca manda dos veces; un claim sin id de proveedor es `UNKNOWN_DELIVERY` y va a una persona.
- Los correos de cuentas del personal que manda Cognito son una excepción declarada (no son mensajes a clientes) y tienen su propia política de autorización de envío.
- `PolicyAudit` reevalúa cada saliente contra la cinta (0 violaciones es un criterio de aceptación).
- La consola nunca envía: encola `OPERATOR_SEND`; el operador ve el bloqueo en la cinta en rojo y elige un camino permitido.

## Enmiendas

- ADR-0020 (2026-09-26): la excepción de correos de cuentas fuera de la compuerta incluye los correos de Cognito del invitado de alta propia (código de verificación y de recuperación, textos del trigger custom message) y el aviso de lead a Craftech (`outbound/transports/lead-notice.ts`, cercado a una sola casilla `@craftech.io`). Ninguno es un mensaje a un cliente del prestamista.
- ADR-0021 (2026-10-06): la compuerta suma un paso 0, `outbound/repeat.ts`: un mismo WhatsApp pedido dos veces en un turno (mismo texto, o la misma plantilla con los mismos parámetros) devuelve el mensaje ya enviado (`replayOf`) sin evaluar ni enviar de nuevo, y audita `OUTBOUND_REPLAYED`. Sigue habiendo un solo punto de salida.
