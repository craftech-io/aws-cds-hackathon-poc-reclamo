---
status: accepted
---

# El rol de CI y el de QA nacen de un bootstrap de CloudFormation que aplica el operador

GitHub Actions deploya por OIDC; el rol que asume no puede crearlo el mismo deploy que lo necesita, y en una cuenta compartida ese rol tiene que estar cercado para no tocar otras apps. Decidimos, como en el scaffolding, un template `infra/bootstrap/ci-role.yaml` que el operador aplica una vez: rol de deploy (trust por `sub` en sus dos formas, ids numéricos y `job_workflow_ref`), rol `qa-runner`, permissions boundary, KVS del Router y response headers policy; cercas por tag `sst:app`, nombre, path IAM, ARN y nombres de registros DNS; **deny** de recepción de SES, MAIL FROM y registros `MX`.

## Considered options

- **Access keys en GitHub**: prohibido.
- **Rol creado por SST**: el huevo y la gallina.
- **Bootstrap de CloudFormation del operador** (elegida).

## Consequences

- `ci-role.test.ts` controla tamaños (51.200 bytes inline, 6.144 por política), trust, cercas y los deny.
- Un permiso faltante falla cerrado con `AccessDenied`; el arreglo es un statement nuevo con su cerca, nunca un comodín.
