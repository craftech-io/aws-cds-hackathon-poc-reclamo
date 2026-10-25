---
status: accepted
---

# Marca neutra con un prestamista ficticio

El concepto se diseñó mirando un problema real de un tipo de empresa, pero el CTO exige cero datos y cero dependencia de cualquier empresa real y que ningún cliente de Craftech aparezca. Decidimos una marca pública propia (**Reclamo en regla** + "Powered by Craftech") y un tenant **ficticio**, **Jarilla — préstamos y billetera**; se descartó un nombre de trabajo por coincidir con una empresa real (búsqueda del 2026-09-26). Redes neutras ("Red de cobro Norte", "Red de cobro Sur", "Red de transferencias"); condiciones, tarifas, personas, teléfonos en un rango no asignable, CVU y documentos sintéticos escritos de cero; una piel de chat genérica en el simulador, sin logos de Meta.

## Considered options

- **Nombrar un prestamista real "como ejemplo"**: viola la restricción y expone a la empresa.
- **Sin tenant ("un prestamista")**: la demo pierde concreción (PDFs, remitente, landing).
- **Tenant ficticio verificado** (elegida).

## Consequences

- Lista de términos prohibidos fuera del repo (secreto `FORBIDDEN_TERMS`), falla cerrado en CI sobre árbol, commits, PDFs, metadatos de imágenes, seed y build; los nombres descartados y cualquier marca de terceros mencionada en el diseño van a esa lista, nunca al repo.
- `Reference/NAMECHECK` registra solo los nombres inventados que se usan, con su búsqueda y fecha.
- El display name de WhatsApp lo decide Craftech al vincular el número (Meta lo revisa contra una empresa real, así que nunca es Jarilla); el perfil vivo dice "Reclamo en regla (demo) · Jarilla es un prestamista ficticio".
