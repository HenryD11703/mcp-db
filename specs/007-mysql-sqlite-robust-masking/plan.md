# Implementation Plan: Conectores MySQL/MariaDB, SQLite y Enmascaramiento Robusto de Variaciones Sensibles

**Branch**: `007-mysql-sqlite-robust-masking` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-mysql-sqlite-robust-masking/spec.md`

## Summary

Expandir el servidor MCP `db-mcp-node` incorporando dos nuevos adaptadores relacionales de solo lectura (`MySqlAdapter` y `SqliteAdapter`) tras el contrato unificado `DatabaseAdapter`, y robustecer el motor de privacidad y enmascaramiento en memoria mediante un clasificador léxico determinista de 5 capas (`LexicalColumnAnalyzer`).

La solución técnica implementa:
1. `MySqlAdapter` sobre `mysql2/promise` con verificación previa de privilegios mínimos en el arranque (*preflight check* sin permisos de escritura), forzado de `sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'` y cancelación efectiva en el motor mediante directiva nativa y canal de control `KILL QUERY <threadId>` en ≤ 500 ms (trazable a SC-007).
2. `SqliteAdapter` sobre `better-sqlite3` con apertura forzada en modo de solo lectura (`SQLITE_OPEN_READONLY`), restricción obligatoria a una lista blanca de directorios persistentes en disco y exclusión terminante de bases de datos efímeras `:memory:`.
3. Incorporación formal del tipo de dato `nit` en `SensitiveDataType` (manteniendo `amount` como el tipo canónico para montos, sueldos y salarios según `DEFAULT_MASKING_RULES`) y del enmascarador `formatMaskedNit` (preservando guion y dígito verificador, o redacción/pseudonimización por sesión).
4. Clasificador léxico determinista evaluado contra `corpus/column-name-sensitivity-corpus.json` (100 % de casos sensibles enmascarados y 0 % de falsos positivos en términos como `unit`, `monitor`, `benito`), capaz de descomponer concatenaciones continuas sin separadores (`empnit`, `galempnit`, `clinit`, `nitempleado`, `nitno`) con el catálogo unificado `UnifiedPrefixCatalog` extensible vía `MASKING_CUSTOM_PREFIXES`.
5. Red de seguridad por patrón de contenido celda a celda ante alias opacos o expresiones (`SELECT empnit AS cod`), con validación estructural estricta (formato con guion `\b\d{2,8}-[0-9kK]\b` o comprobación de dígito verificador Módulo 11 de la SAT guatemalteca para valores de 6 a 10 dígitos), impidiendo falsos positivos sobre años (ej. 2024), códigos postales o enteros generales. La señal de contenido NUNCA anula un match positivo de nombre.
6. Frontera estricta entre estados de confianza:
   - `none`: Términos presentes en `SafeVocabularyDictionary` o columnas comunes sin indicios sensibles (garantía de 0 % falsos positivos; nunca entra a fail-safe).
   - `deterministic`: Coincidencia concluyente por token o por prefijo/sufijo conocido con raíz sensible.
   - `low_confidence_fail_safe`: Exclusivo para nombres no presentes en el diccionario seguro con morfología ambigua respecto a tokens sensibles, enmascarando preventivamente y registrando en `audit.jsonl` un evento `low_confidence_match` sin filtrar PII.
7. Enriquecimiento de las herramientas de introspección `describe_table` e `introspect_schema` con `sensitive_type` e `is_masked: true`, suprimiendo categóricamente muestras de datos crudos (`sample_values`).
8. Pruebas dedicadas de integración para la Historia de Usuario 5 que validan consistencia de enmascaramiento en cruces federados entre MySQL y SQLite (`tests/contract/federated-masking-consistency.spec.ts`) y ausencia absoluta de PII cruda en `audit.jsonl` para los nuevos motores (`tests/unit/audit-no-raw-pii-multi-engine.spec.ts`).

## Technical Context

**Language/Version**: TypeScript 5.7+ (`strict: true`, `noUncheckedIndexedAccess: true`) sobre Node.js 20+ LTS

**Primary Dependencies**:
- `@modelcontextprotocol/sdk` (protocolo MCP oficial)
- `mysql2` (driver de alto rendimiento para MySQL 5.7/8.x y MariaDB 10.x/11.x)
- `better-sqlite3` (motor SQLite C++ síncrono con soporte de modo `readonly: true` e interrupciones)
- `node-sql-parser` (analizador sintáctico AST con soporte para dialectos MySQL, MariaDB y SQLite)
- `zod` (validación de esquemas de conexión y parámetros)
- `crypto` (módulo nativo de Node.js para HMAC-SHA256 y generación del salt efímero de sesión)

**Storage**:
- Memoria volátil del proceso MCP para `SessionContext` (salt efímero de sesión) y cache de pseudónimos.
- Archivos SQLite persistentes en disco en rutas autorizadas (`mode=ro`).
- Registro estructurado inmutable en `audit.jsonl` (cero datos crudos de celdas sensibles).

**Testing**:
- Vitest:
  - Pruebas de caja negra del `LexicalColumnAnalyzer` contra `corpus/column-name-sensitivity-corpus.json` (100 % de casos sensibles detectados, 0 % de falsos positivos en `unit`, `monitor`, etc.).
  - Pruebas de preflight gate y rechazo de escrituras / `:memory:` en `SqliteAdapter`.
  - Pruebas de preflight gate y watchdog de cancelación reactiva (≤ 500 ms) en `MySqlAdapter`.
  - Pruebas de salvaguarda secundaria por patrón de contenido con validación Módulo 11 ante alias opacos y funciones calculadas.
  - Pruebas de introspección segura en `describe_table` e `introspect_schema` verificando `sample_values: []`.
  - Pruebas de consistencia de enmascaramiento en federación MySQL ↔ SQLite (`federated-masking-consistency.spec.ts`).
  - Pruebas de verificación de auditoría estructurada sin PII cruda para los nuevos motores (`audit-no-raw-pii-multi-engine.spec.ts`).

**Target Platform**: Servidor Node.js multiplataforma (stdio y SSE).

**Project Type**: Servidor MCP (extensión de adaptadores de catálogo y hardening de seguridad y privacidad).

**Performance Goals**:
- Sobrecarga de análisis léxico y clasificación de nombres de columna ≤ 2 ms para tablas de hasta 100 columnas.
- Cancelación efectiva de consultas en MySQL/MariaDB en ≤ 500 ms tras expirar el timeout (trazable a SC-007).
- Sobrecarga global del adaptador sobre latencia nativa de base de datos ≤ 50 ms (trazable a SC-004).

**Constraints**:
- **I. Solo Lectura Inquebrantable**: Preflight check obligatorio y validación previa con Guard AST en cada consulta.
- **II. Defensa en Profundidad**: AST + timeout configurado con cancelación real en motor en ≤ 500 ms + forzado de `sql_mode` estricto en MySQL + control de concurrencia y límites de costo.
- **III. Cero Confianza en los Datos**: Parámetros tipados obligatorios (`?`); prohibida cualquier concatenación de cadenas en sentencias SQL.
- **IV. Privacidad en Memoria**: Datos reales procesados exclusivamente en memoria volátil; la salida serializada aplica enmascaramiento o pseudonimización determinista.
- **V. Auditoría Inmutable**: `audit.jsonl` nunca registra valores crudos de datos sensibles de ninguno de los motores soportados.
- **VI. Pruebas Adversarias**: Toda la suite adversaria de ataques (`corpus/adversarial-attacks.json`) debe ejecutarse y ser bloqueada en MySQL, MariaDB y SQLite.
- **VII. Desacoplamiento por Contrato**: El núcleo del servidor interactúa únicamente mediante la interfaz `DatabaseAdapter`.

**Scale/Scope**:
- Clasificación determinista de 115+ variantes de nombres en el corpus oficial.
- Soporte para bases de datos SQLite en disco de cualquier volumen bajo lista blanca.
- Soporte para instancias locales y remotas de MySQL y MariaDB.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principio Constitucional | Pre-research | Post-design | Justificación y Notas de Cumplimiento |
|---|:---:|:---:|---|
| **I. Solo Lectura Inquebrantable** | PASS | PASS | `MySqlAdapter` y `SqliteAdapter` validan preflight check obligatorio en arranque (verificando ausencia de permisos de escritura) y evalúan cada consulta mediante Guard AST (`SELECT` raíz exclusivo). `SqliteAdapter` fuerza `SQLITE_OPEN_READONLY` en el archivo. |
| **II. Defensa en Profundidad** | PASS | PASS | Múltiples capas superpuestas: AST guard, usuario de solo lectura, límites de tiempo con cancelación real en motor en ≤ 500 ms vía `KILL QUERY`, forzado de `sql_mode` estricto, y aislamiento de archivos SQLite en lista blanca. |
| **III. Cero Confianza en los Datos** | PASS | PASS | Todos los valores de consulta viajan como parámetros tipados en sentencias preparadas nativas (`?`); cero concatenación de cadenas en MySQL y SQLite. |
| **IV. Privacidad en Memoria** | PASS | PASS | `LexicalColumnAnalyzer` clasifica y enmascara en memoria antes de la serialización hacia el cliente. Identificadores como NIT preservan guion/dígito o aplican pseudonimización determinista por sesión con salt efímero. Señal de contenido actúa como salvaguarda secundaria con verificación Módulo 11 y jamás anula un match positivo de nombre. |
| **V. Auditoría Inmutable** | PASS | PASS | `audit.jsonl` registra cada ejecución documentando `masked_columns` y eventos `low_confidence_match` sin exponer valores crudos de celdas para consultas directas y federadas. |
| **VI. Pruebas Adversarias** | PASS | PASS | MySQL, MariaDB y SQLite pasan la suite completa de ataques del corpus adversario (`corpus/adversarial-attacks.json`), y el clasificador léxico supera el 100 % de casos en `corpus/column-name-sensitivity-corpus.json`. |
| **VII. Desacoplamiento por Contrato** | PASS | PASS | Los adaptadores implementan estrictamente `DatabaseAdapter`, registrándose en `AdapterRegistry` sin alterar el contrato público del servidor MCP. |

## Project Structure

### Documentation (this feature)

```text
specs/007-mysql-sqlite-robust-masking/
├── plan.md              # Este plan de implementación (/speckit-plan)
├── research.md          # Fase 0: Investigación técnica y decisiones arquitectónicas
├── data-model.md        # Fase 1: Entidades, modelos de datos y diagramas de estados
├── quickstart.md        # Fase 1: Guía ejecutable de validación paso a paso
├── contracts/           # Fase 1: Contratos TypeScript y esquemas JSON
│   ├── engine-adapter.contract.ts
│   ├── robust-masking.contract.ts
│   └── mcp-introspection-patch.schema.json
├── checklists/
│   └── requirements.md  # Checklist de calidad de especificación (12/12 aprobado)
└── tasks.md             # Fase 2: Tareas de implementación (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── contracts/
│   ├── database-adapter.ts          # Extensión de EngineDialect ('mysql' | 'mariadb' | 'sqlite')
│   ├── security.contract.ts         # Extensión de SensitiveDataType ('nit')
│   └── discovery.contract.ts        # Enriquecimiento de ColumnMetadata con sensitiveType
├── adapters/
│   ├── postgres/                    # Existente
│   ├── sqlserver/                   # Existente
│   ├── mysql/                       # Nuevo: MySqlAdapter sobre mysql2/promise
│   │   ├── mysql-adapter.ts
│   │   ├── mysql-preflight.ts
│   │   └── mysql-cancellation.ts    # Watchdog KILL QUERY <= 500ms
│   └── sqlite/                      # Nuevo: SqliteAdapter sobre better-sqlite3
│       ├── sqlite-adapter.ts
│       ├── sqlite-preflight.ts      # Whitelist de rutas y permisos de archivo
│       └── sqlite-security.ts
├── core/
│   ├── engine-registry.ts           # Registro de dialectos mysql, mariadb y sqlite
│   ├── security/
│   │   ├── lexical-column-analyzer.ts # Pipeline determinista de 5 capas
│   │   ├── unified-prefix-catalog.ts  # Catálogo unificado de prefijos extensible
│   │   ├── safe-vocabulary-dict.ts    # Filtro anti-falsos positivos (unit, monitor, etc.)
│   │   ├── masking-rules.ts           # Reglas de NIT, formatMaskedNit y validateNitChecksumModulo11
│   │   ├── default-masking-profile.ts # Perfil actualizado con NIT
│   │   ├── data-masking-engine.ts     # Integración de clasificador léxico y fallback de contenido Módulo 11
│   │   └── session-pseudonym.ts       # SessionContext con salt efímero en memoria
│   ├── discovery/
│   │   └── catalog-introspector.ts    # Introspección enriquecida sin datos crudos
│   └── tools/
│       └── introspection-tools.ts     # describe_table e introspect_schema actualizados
└── bin/
    └── db-mcp.ts                    # Configuración de CLI y variables de entorno

tests/
├── unit/
│   ├── lexical-column-analyzer.spec.ts        # Evaluación contra column-name-sensitivity-corpus.json
│   ├── unified-prefix-catalog.spec.ts         # Pruebas de recorte y segmentación de prefijos
│   ├── safe-vocabulary-dict.spec.ts           # Pruebas de descarte de falsos positivos
│   ├── data-masking-fallback.spec.ts          # Pruebas de contenido Módulo 11 ante alias opacos
│   ├── mysql-cancellation.spec.ts             # Pruebas de cancelación KILL QUERY <= 500ms
│   └── audit-no-raw-pii-multi-engine.spec.ts  # Verificación de auditoría sin PII cruda para nuevos motores
├── contract/
│   ├── mysql-adapter.spec.ts                  # Pruebas de contrato y preflight para MySQL
│   ├── sqlite-adapter.spec.ts                 # Pruebas de contrato, whitelist y readonly para SQLite
│   ├── mcp-discovery.spec.ts                  # Pruebas de introspección sin muestras crudas
│   └── federated-masking-consistency.spec.ts  # Cruce federado MySQL ↔ SQLite con enmascaramiento consistente
└── adversarial/
    └── adversarial-suite-multi-engine.spec.ts # Batería de ataques sobre MySQL y SQLite
```

**Structure Decision**: Se mantiene la arquitectura modular de proyecto único de TypeScript estricto con desacoplamiento por adaptadores bajo `src/adapters/` y lógica transversal de seguridad y privacidad bajo `src/core/security/`.

## Complexity Tracking

> Ninguna violación constitucional identificada. Todas las compuertas han sido satisfechas y verificadas en PASS.
