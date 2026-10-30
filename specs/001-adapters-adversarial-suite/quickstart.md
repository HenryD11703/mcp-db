# Quickstart & Validation Guide: Base Arquitectónica de Adaptadores y Suite Adversaria

**Feature**: `001-adapters-adversarial-suite`
**Contracts**: [database-adapter.contract.ts](./contracts/database-adapter.contract.ts) | [adversarial-corpus.schema.json](./contracts/adversarial-corpus.schema.json)
**Data Model**: [data-model.md](./data-model.md)

## Prerequisites

- **Node.js**: v20 LTS o superior
- **TypeScript**: v5.x (`strict: true`)
- **Contenedores opcionales para pruebas de integración contra motores reales**: Docker Compose con SQL Server 2022 y PostgreSQL 16 (las pruebas de contrato y suite adversaria corren tanto contra arneses de protocolo/fixtures como contra instancias reales).

## Setup

```powershell
npm install
npm run typecheck
```

## Escenario 1: Ejecutar la Suite Adversaria de Seguridad (10 Vectores Obligatorios)

Valida que el corpus estructurado (`corpus/adversarial-attacks.json`) cumpla el esquema JSON, contenga los 10 vectores obligatorios y bloquee el 100% de los ataques en `tsql` y `postgres` sin rechazar los casos de control `SELECT` legítimos (`SC-001`, `SC-002`).

```powershell
npm run test:adversarial
```

**Resultado esperado**:
- 10/10 vectores de ataque con 100% de tasa de rechazo (`V01_STACKED_QUERIES` a `V10_SESSION_OR_INTERNAL_CMD`).
- 100% de consultas `SELECT` de control aceptadas (`0` falsos positivos).
- Reporte comparativo de parsers candidatos generado en consola y verificable en CI.

## Escenario 2: Ejecutar la Suite Compartida de Contrato (`DatabaseAdapter`)

Ejecuta la misma batería de pruebas sobre `SqlServerAdapter` y `PostgresAdapter` verificando las 4 operaciones del contrato (`FR-003` a `FR-009`, `SC-003`, `SC-004`):
1. `verifyReadOnly()`: Acepta cuentas con solo `SELECT` y rechaza cuentas con permisos efectivos de escritura o heredados (`public` / `db_datawriter`).
2. `analyzeQueryPlan()`: Devuelve `NormalizedRiskProfile` con `hasFullScan`, `hasUnconditionalJoin`, `estimatedRows` y `estimatedCost` nativo (`>= 0`).
3. `executeQuery()`: Ejecuta consultas parametrizadas tipadas y cancela en `< 1s` en el motor cuando se dispara `AbortSignal`.
4. `introspectSchema()`: Devuelve el `SchemaCatalog` normalizado sin leer filas de tablas de usuario.

```powershell
npm run test:contract
```

## Escenario 3: Verificar Desacoplamiento del Núcleo (`SC-005`)

Verifica que un tercer adaptador de prueba que implemente `DatabaseAdapter` pueda registrarse y operar con el núcleo sin modificar ninguna línea de `src/core/`.

```powershell
npm test
```
