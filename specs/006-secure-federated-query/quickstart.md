# Quickstart: Validación de Consulta Federada Segura

**Feature**: `006-secure-federated-query`
**Date**: 2026-10-30
**Status**: Ready for Validation

Esta guía describe cómo verificar de extremo a extremo el funcionamiento y las compuertas de seguridad del **Orquestador de Consulta Federada Segura**, tanto en pruebas unitarias como en integración entre PostgreSQL y SQL Server.

---

## 1. Prerrequisitos y Configuración

1. Node.js 20+ LTS y dependencias instaladas:
   ```bash
   npm install
   npm run build
   ```
2. Instancias de prueba configuradas o mocks de adaptadores (`postgres-mock`, `sqlserver-mock`) registrados en el [`AdapterRegistry`](file:///c:/Users/hquel/Documents/db-mcp-node/src/core/engine-registry.ts) con sus credenciales de solo lectura.

---

## 2. Escenarios de Validación

### Escenario 1: Flujo Exitoso Heterogéneo (PostgreSQL → SQL Server) con Pseudonimización

**Objetivo**: Validar la extracción de claves de BD A (PostgreSQL), inyección como parámetros tipados en BD B (SQL Server), cruce en memoria (`LEFT` join) y pseudonimización determinista `pseudo_<16_hex>`.

**Invocación de la herramienta MCP (`execute_federated_query`)**:
```json
{
  "sourceAdapterId": "postgres-crm",
  "sourceSql": "SELECT cliente_id, nombre, region FROM clientes WHERE activo = true LIMIT 50",
  "sourceKeyColumn": "cliente_id",
  "targetAdapterId": "sqlserver-billing",
  "targetSqlTemplate": "SELECT id_cliente, numero_poliza, monto_total FROM contratos WHERE id_cliente IN (:keys)",
  "targetJoinColumn": "id_cliente",
  "joinType": "LEFT",
  "maxKeys": 500
}
```

**Resultado Esperado**:
- Ambas consultas son aprobadas por el Guard AST de forma independiente.
- Las claves se inyectan en SQL Server como `@p1, @p2, ...` sin concatenación de texto.
- En la salida JSON entregada al cliente MCP:
  - Las columnas `cliente_id` e `id_cliente` contienen el mismo valor pseudonimizado: `pseudo_4f89ab12cd34ef56`.
  - La fila unificada contiene `{ cliente_id: "pseudo_4f89ab...", nombre: "...", region: "...", numero_poliza: "...", monto_total: "..." }`.
  - El dato real (ej. `1029384`) **nunca** aparece en la respuesta final ni en los logs.
- Se emiten registros de auditoría en `audit.jsonl` compartiendo el mismo `federation_id` (`correlationId`).

---

### Escenario 2: Prueba Adversaria contra Inyección SQL de Segundo Orden

**Objetivo**: Demostrar que claves maliciosas retornadas por BD A no pueden quebrar el AST de BD B.

**Configuración**:
- Simular un registro en BD A donde `cliente_id = "'; DROP TABLE contratos; --"` o `' OR '1'='1"`.
- El orquestador extrae el valor y lo vincula como valor literal en el arreglo de parámetros tipados de BD B.

**Resultado Esperado**:
- La consulta SQL enviada al motor destino es estrictamente `SELECT ... WHERE id_cliente IN (@p1)`.
- El parámetro `@p1` lleva como valor la cadena hostil completa.
- El motor de BD B busca literalmente el registro con ese código, sin alterar la semántica de la consulta.
- Cero inyecciones de segundo orden; comprobación validada por la suite adversaria de Vitest:
  ```bash
  npm test tests/adversarial/federated-injection.test.ts
  ```

---

### Escenario 3: Intercepción por Guard AST en Consulta Destino

**Objetivo**: Verificar que sentencias maliciosas en la plantilla de BD B son bloqueadas antes de su ejecución.

**Invocación con infracción de seguridad**:
```json
{
  "sourceAdapterId": "postgres-crm",
  "sourceSql": "SELECT cliente_id FROM clientes WHERE activo = true",
  "sourceKeyColumn": "cliente_id",
  "targetAdapterId": "sqlserver-billing",
  "targetSqlTemplate": "SELECT id_cliente FROM contratos WHERE id_cliente IN (:keys); UPDATE balances SET saldo = 0;",
  "targetJoinColumn": "id_cliente"
}
```

**Resultado Esperado**:
- El orquestador expande `:keys` y somete la consulta al Guard AST (`SqlSecurityGuard`).
- El Guard AST detecta comandos apilados (`V01_STACKED_QUERIES`) o sentencias mutantes y rechaza la ejecución.
- La operación aborta inmediatamente con error estructurado `SqlSecurityRejectionError`.
- Ninguna instrucción llega a ejecutarse en SQL Server.
- Se registra el rechazo en auditoría bajo el `federation_id`.

---

### Escenario 4: Control de Tope de Claves (Truncamiento Seguro vs. Modo Fallo)

**Objetivo**: Verificar el comportamiento ante una consulta en BD A que devuelva 750 registros (superando el límite de 500).

1. **Prueba A: Comportamiento por Defecto (`overflowAction: 'truncate'`)**:
   - El orquestador extrae 750 claves, aplica deduplicación y trunca a las primeras 500.
   - En la respuesta se incluye la advertencia formal:
     ```json
     {
       "status": "TRUNCATED_KEYS",
       "keysProcessed": 500,
       "totalAvailableKeys": 750,
       "keysTruncated": true,
       "warnings": ["Key count (750) exceeded maxKeys limit (500). Results truncated to first 500 keys."]
     }
     ```
2. **Prueba B: Modo Estricto (`overflowAction: 'fail'`)**:
   - Con `overflowAction: 'fail'`, el orquestador aborta la operación antes de contactar a BD B, retornando error `KEY_LIMIT_EXCEEDED` con el conteo disponible.

---

### Escenario 5: Verificación de Cadena de Auditoría con `correlationId`

**Objetivo**: Confirmar que todos los pasos de la federación están enlazados forensemente.

**Comando de verificación**:
```bash
npm run audit:verify
```

**Resultado Esperado en `audit.jsonl`**:
- Todas las entradas generadas durante la operación federada poseen el mismo `correlationId` (ej. `fed-a1b2c3d4-e5f6-7890-abcd-ef0123456789`).
- La secuencia cronológica muestra:
  1. `FEDERATED_QUERY_INIT`
  2. `FEDERATED_STEP_SOURCE` (PostgreSQL)
  3. `FEDERATED_KEYS_EXTRACTED`
  4. `FEDERATED_STEP_TARGET` (SQL Server)
  5. `FEDERATED_QUERY_COMPLETE`
- Ninguna clave cruda sensible figura en el archivo de auditoría.
