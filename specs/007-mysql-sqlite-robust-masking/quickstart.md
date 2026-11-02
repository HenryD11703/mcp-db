# Quickstart & Validation Guide: Conectores MySQL/MariaDB, SQLite y Enmascaramiento Robusto

**Feature**: `007-mysql-sqlite-robust-masking`
**Date**: 2026-11-02
**Status**: Ready for Validation

Esta guía detalla los pasos de prueba y verificación de extremo a extremo para validar los nuevos conectores de bases de datos y la batería de enmascaramiento morfológico robusto.

---

## 1. Prerrequisitos y Configuración de Entorno

### Variables de Entorno Clave
```bash
# Lista blanca de directorios permitidos para bases de datos SQLite persistentes
export SQLITE_ALLOWED_DIRECTORIES="/path/to/project/data,/var/data/sqlite,./data"

# Catálogo extensible de prefijos corporativos para sistemas legados
export MASKING_CUSTOM_PREFIXES="gal,erp,suc,corp"

# Configuración de base de datos MySQL (usuario con solo lectura SELECT)
export MYSQL_HOST="localhost"
export MYSQL_PORT="3306"
export MYSQL_USER="usr_readonly"
export MYSQL_PASSWORD="secret_password"
export MYSQL_DATABASE="empresa_db"
```

---

## 2. Escenarios de Validación Ejecutables

### Escenario 1: Validación de Caja Negra contra el Corpus de Sensibilidad
Evalúa el 100 % de casos sensibles y 0 % de falsos positivos sobre el conjunto de prueba oficial.

```bash
# Ejecutar la suite de pruebas unitarias de clasificación léxica contra el corpus
npm run test -- tests/unit/lexical-column-analyzer.spec.ts
```

**Resultado Esperado**:
- **100 % de casos `sensible`** (incluyendo `nit`, `empnit`, `galempnit`, `emp_nit`, `nitempleado`, `clinit`, `tax_id`, `dpi`, `correoElectronico`, `gal_telefono`) son clasificados como sensibles y enmascarados.
- **0 % de falsos positivos en `no_sensible`** (`unit`, `unit_price`, `monitor`, `benito`, `definition`, `nitrate`, `ignite`, `granite`, `thumbnail`, `salad_type` conservan sus datos intactos).

---

### Escenario 2: Conexión SQLite en Modo Solo Lectura y Aislamiento de Archivos
Comprueba que SQLite solo acepte archivos persistentes en disco autorizados y rechace escrituras y `:memory:`.

```bash
# Ejecutar pruebas de contrato y preflight gate para SQLite
npm run test -- tests/contract/sqlite-adapter.spec.ts
```

**Resultado Esperado**:
1. Conexión a `./data/analitica.sqlite` abre en `mode=ro` y ejecuta `SELECT count(*) FROM ventas` con éxito.
2. Conexión hacia `:memory:` es rechazada en el preflight check con `SQLITE_MEMORY_DISALLOWED`.
3. Conexión hacia una ruta fuera de la lista blanca es rechazada con `PATH_OUTSIDE_ALLOWED_WHITELIST`.
4. Consultas con `CREATE`, `DROP`, `INSERT` o `ATTACH DATABASE` son abortadas en el Guard AST.

---

### Escenario 3: Conexión MySQL/MariaDB y Cancelación Efectiva en ≤ 500 ms
Comprueba la verificación previa de privilegios mínimos y la cancelación real en el motor ante timeouts.

```bash
# Ejecutar pruebas de integración y watchdog de cancelación para MySQL
npm run test -- tests/contract/mysql-adapter.spec.ts tests/unit/mysql-cancellation.spec.ts
```

**Resultado Esperado**:
1. Conexión con usuario con permisos de escritura falla el preflight check y niega el arranque del adaptador.
2. Conexión válida fuerza `sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'`.
3. Consulta pesada con `SLEEP(10)` y timeout de 100 ms activa el watchdog de control y emite `KILL QUERY <threadId>`, completando la cancelación en el motor en ≤ 500 ms.

---

### Escenario 4: Inspección de Patrón de Contenido ante Alias Opacos
Comprueba que alias arbitrarios no permitan la fuga de datos sensibles.

```bash
# Ejecutar prueba de salvaguarda secundaria por patrón de contenido
npm run test -- tests/unit/data-masking-fallback.spec.ts
```

**Resultado Esperado**:
- Una consulta como `SELECT empnit AS codigo_aleatorio FROM empleados` donde el alias no coincide morfológicamente es evaluada celda a celda; los valores de NIT guatemalteco son interceptados y entregados enmascarados como `*******-4`.

---

### Escenario 5: Introspección Segura sin Exposición de Muestras Crudas
Comprueba las herramientas MCP `describe_table` e `introspect_schema`.

```bash
# Ejecutar validación de herramientas MCP de introspección
npm run test -- tests/contract/mcp-discovery.spec.ts
```

**Resultado Esperado**:
- Para la tabla `empleados`, la columna `galempnit` retorna `{ name: 'galempnit', isSensitive: true, sensitiveType: 'nit', isMasked: true }` y el campo `sampleValues` es omitido en la respuesta JSON.

---

### Escenario 6: Consistencia en Consultas Federadas y Auditoría Inmutable
Comprueba que los cruces entre SQLite y MySQL enmascaren datos de forma uniforme y que `audit.jsonl` no contenga valores de NIT o datos sensibles en crudo.

```bash
# Ejecutar pruebas de consistencia federada y auditoría estructurada
npm run test -- tests/contract/federated-masking-consistency.spec.ts tests/unit/audit-no-raw-pii-multi-engine.spec.ts
```

**Resultado Esperado**:
1. Cruce federado SQLite ↔ MySQL correlacionando registros por `nit` efectúa el join en memoria con datos íntegros y proyecta hacia el cliente valores enmascarados o pseudonimizados de manera uniforme.
2. Todas las entradas generadas en `audit.jsonl` contienen `masked_columns` y registran las consultas parametrizadas, con 0 fugas de valores crudos de celdas sensibles.

