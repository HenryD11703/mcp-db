# Phase 0 Research: Base Arquitectónica de Adaptadores y Suite Adversaria de Seguridad

**Feature**: `001-adapters-adversarial-suite`
**Date**: 2026-10-30

## 1. Selección y Arquitectura del Validador Sintáctico de SQL frente al Corpus Adversario

### Decision
Adoptar una arquitectura de validación en dos etapas implementada detrás de una interfaz `SqlParserCandidate`:
1. **Escáner Léxico Consciente de Literales (Pre-AST Lexical Scanner)**: Analiza la cadena SQL carácter por carácter respetando literales de cadena (`'...'`, `N'...'`, `E'...'`, `$$...$$`) e identificadores delimitados (`"..."`, `[...]`) para rechazar de forma estricta cualquier comentario inline (`--`) o de bloque (`/* */`) fuera de literales (Vector 3), múltiples sentencias separadas por `;` (Vector 1), y comandos de sesión/retardo no soportados consistentemente por gramáticas estándar (`WAITFOR DELAY`, `DBCC`, `SELECT ... EXEC` sin `;` en T-SQL).
2. **Inspección de Árbol Sintáctico Abstracto (AST) con `node-sql-parser`**: Evalúa el AST con dialectos `transactsql` y `postgresql` para verificar que el nodo raíz sea única y exclusivamente un `SELECT` sin cláusula `INTO` (Vector 2), sin cláusulas de bloqueo `FOR UPDATE` / `FOR SHARE` / hints de bloqueo (Vector 6), sin CTEs mutantes (`WITH ... INSERT/UPDATE/DELETE RETURNING`, Vector 4), sin referencias de 4 partes ni `OPENQUERY`/`OPENROWSET` (Vector 7) y sin funciones administrativas prohibidas como `pg_terminate_backend` o `pg_read_file` (Vector 5).

Además, el repositorio incluirá un arnés comparativo (`ParserBenchmarkRunner`) que ejecuta el corpus adversario contra candidatos puros (`node-sql-parser` sin reglas adicionales, `pgsql-ast-parser` para Postgres y el `HardenedAstValidator` combinado) y genera una tabla de resultados verificable.

### Rationale
- Ningún parser de SQL en el ecosistema JavaScript/TypeScript bloquea por sí solo los 10 vectores obligatorios: la mayoría de los lexers descartan silenciosamente los comentarios `--` y `/* */` antes de producir el AST, y varios dialectos de T-SQL permiten sentencias separadas solo por espacio (`SELECT 1 EXEC sp_who`).
- Combinar un escáner léxico determinista con el AST de `node-sql-parser` permite cumplir el 100% de los 10 vectores (`SC-001`) con 0% de falsos positivos en consultas `SELECT` legítimas (`SC-002`).

### Alternatives Considered
- **Solo Expresiones Regulares (Regex)**: Rechazado porque las expresiones regulares no pueden distinguir de forma fiable palabras clave o `--` dentro de literales de texto complejos y son vulnerables a evasión por anidamiento.
- **`node-sql-parser` sin capa léxica ni visitante de seguridad**: Rechazado porque ignora comentarios SQL por defecto y convierte `SELECT * INTO` o `SELECT ... FOR UPDATE` en nodos AST válidos si no se inspeccionan explícitamente las propiedades del nodo.
- **`pgsql-ast-parser` como único parser**: Rechazado como parser único porque solo soporta dialecto PostgreSQL y carece de soporte para T-SQL (SQL Server).

---

## 2. Drivers de Base de Datos y Cancelación Nativa mediante `AbortSignal`

### Decision
- **SQL Server (T-SQL)**: Utilizar el paquete `mssql` (basado en `tedious`) y enlazar `AbortSignal` directamente a `request.cancel()`. Cuando la señal se activa, `tedious` envía un paquete TDS `Attention` fuera de banda al motor SQL Server, cancelando la ejecución en el servidor de inmediato (`< 1s`).
- **PostgreSQL**: Utilizar el paquete `pg` (`node-postgres`). Cuando se ejecuta una consulta parametrizada con `AbortSignal`, el adaptador registra un listener sobre la señal que invoca la cancelación nativa del proceso activo en PostgreSQL (mediante el protocolo de cancelación de `pg` / `pg_cancel_backend(pid)` sobre el `processID` de la sesión activa) y libera limpiamente el cliente del pool.

### Rationale
- Cumple estrictamente el criterio de aceptación `SC-003` y la Historia 6: la consulta se cancela realmente en el servidor de base de datos y no solo rechazando la promesa en Node.js.
- Maneja condiciones de carrera (aborto previo al envío o posterior a la respuesta) removiendo el listener en el bloque `finally`.

### Alternatives Considered
- **`Promise.race` con timeout solo del lado de Node.js**: Rechazado porque deja la consulta pesada consumiendo CPU e I/O en el servidor de base de datos.

---

## 3. Normalización del Plan de Ejecución (`NormalizedRiskProfile`)

### Decision
- **PostgreSQL**: Ejecutar `EXPLAIN (FORMAT JSON) <sql>` pasando los parámetros tipados o marcadores seguros sin `ANALYZE` (para no ejecutar la consulta real). Recorrer recursivamente el árbol JSON `Plan`:
  - `hasFullScan`: `true` si algún nodo tiene `"Node Type": "Seq Scan"`.
  - `hasUnconditionalJoin`: `true` si algún nodo de tipo `"Nested Loop"`, `"Hash Join"` o `"Merge Join"` carece de `"Hash Cond"`, `"Merge Cond"`, `"Join Filter"` y su subnodo interno no aplica `"Index Cond"` vinculado al exterior.
  - `estimatedRows`: valor numérico de `"Plan Rows"` del nodo raíz.
  - `estimatedCost`: valor numérico nativo de `"Total Cost"` del nodo raíz (`number >= 0`).
- **SQL Server (T-SQL)**: En una conexión aislada del pool, activar `SET SHOWPLAN_XML ON`, enviar la consulta parametrizada para obtener el XML del plan estimado sin ejecutarla, y restaurar `SET SHOWPLAN_XML OFF` en un bloque `finally`. Analizar los nodos `<RelOp>`:
  - `hasFullScan`: `true` si algún `<RelOp>` tiene `PhysicalOp="Table Scan"` o `PhysicalOp="Clustered Index Scan"` sin predicado de búsqueda.
  - `hasUnconditionalJoin`: `true` si algún `<RelOp>` presenta `NoJoinPredicate="1"` / `NoJoinPredicate="true"` o es un operador de *join* sin condición de unión.
  - `estimatedRows`: atributo numérico `EstimateRows` del `<RelOp>` raíz.
  - `estimatedCost`: atributo numérico nativo `EstimatedTotalSubtreeCost` del `<RelOp>` raíz (`number >= 0`).

### Rationale
- Garantiza que el plan se obtenga sin efectos secundarios ni lectura real de datos (`EXPLAIN` sin `ANALYZE` en Postgres y `SHOWPLAN_XML` en SQL Server).
- Expone el costo nativo exacto del optimizador conforme a la clarificación aprobada para `FR-005`.

### Alternatives Considered
- **`EXPLAIN ANALYZE` / `SET STATISTICS XML ON`**: Rechazado porque ejecuta realmente la consulta antes de poder bloquearla por costo excesivo.

---

## 4. Verificación de Solo Lectura en el Arranque (*Preflight Check*)

### Decision
- **PostgreSQL**:
  1. Configurar la sesión con `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`.
  2. Consultar en una sola verificación de catálogo si el usuario actual es superusuario (`rolsuper`), tiene roles administrativos (`rolcreatedb`, `rolcreaterole`) o posee privilegios efectivos `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `TRIGGER` o `CREATE` sobre la base de datos o cualquier tabla/esquema de usuario accesible (incluyendo permisos otorgados a `PUBLIC`).
- **SQL Server (T-SQL)**:
  1. Consultar membresía efectiva en roles fijos de servidor y base de datos (`IS_SRVROLEMEMBER('sysadmin')`, `IS_ROLEMEMBER('db_owner')`, `IS_ROLEMEMBER('db_datawriter')`, `IS_ROLEMEMBER('db_ddladmin')`).
  2. Consultar `sys.fn_my_permissions(NULL, 'DATABASE')` y permisos efectivos en esquemas/objetos de usuario para detectar cualquier permiso `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CONTROL`, `CREATE TABLE`, `CREATE PROCEDURE` o `EXECUTE`.
- Si cualquiera de las comprobaciones detecta permisos de modificación, `verifyReadOnly()` retorna `isReadOnly: false` con la lista detallada de violaciones y el servidor aborta el arranque para esa conexión.

### Rationale
- Cumple `FR-003` y la clarificación acordada: detecta permisos directos y heredados (incluyendo `public`/`db_datawriter`) sin ejecutar escrituras de prueba en entornos de producción.

### Alternatives Considered
- **Intentar `CREATE TABLE #tmp` o `INSERT` con `ROLLBACK`**: Rechazado porque puede disparar alertas de auditoría en producción o fallar por razones ajenas a permisos de tablas reales.

---

## 5. Framework de Pruebas y Ejecución en CI

### Decision
Utilizar **Vitest** sobre Node.js 20+ con TypeScript 5.x (`strict: true`).
- La suite compartida de contrato (`tests/contract/database-adapter.shared.spec.ts`) exporta una función parametrizada `runDatabaseAdapterContractSuite(adapterName, createAdapterFixture)` que se ejecuta idénticamente contra `PostgresAdapter` y `SqlServerAdapter`.
- El corpus adversario vive en `corpus/adversarial-attacks.json` validado con Zod / JSON Schema y se ejecuta en CI mediante `npm run test:adversarial` y `npm test`.
