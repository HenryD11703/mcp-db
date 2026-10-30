# Research: Descubrimiento para Bases de Datos Legacy

## R1. Fuentes de catálogo sin leer filas
- **Decision**: PostgreSQL: `pg_class`/`pg_attribute`/`pg_index`/`pg_stats` (estimación `reltuples`); SQL Server: `sys.tables`/`sys.columns`/`sys.indexes`/`sys.dm_db_partition_stats` y `sys.dm_db_stats_properties`. Se exponen vía nuevos métodos de `DatabaseAdapter`.
- **Rationale**: Cumple FR-002/FR-004 sin `COUNT(*)`; consistente con Principio VII.
- **Alternatives**: Solo `INFORMATION_SCHEMA` (carece de conteos e índices); `COUNT(*)` (rechazado: costoso y lee datos).

## R2. Motor de inferencia de relaciones
- **Decision**: Puntaje ponderado determinista: `score = 0.5·léxico + 0.2·tipo + 0.3·evidencia`, con la compatibilidad de tipos como compuerta (tipos incompatibles ⇒ descartar). Léxico: tokenización (snake/camel/prefijos `id_`, `cod_`, `fk_`), singularización, diccionario de abreviaturas configurable y coincidencia contra nombre de tabla padre + clave primaria/única. Columnas genéricas (`id`, `status`, `fecha`, `tipo`, `codigo`) solo puntúan si hay prefijo/sufijo de entidad. Niveles: HIGH ≥ 0.85, MEDIUM ≥ 0.65, LOW < 0.65; umbral de salida por defecto 0.70. Sin evidencia estadística, el puntaje se limita a 0.84 (nunca HIGH solo por nombre).
- **Rationale**: Explicable (desglose por factor), reproducible y probable con corpus etiquetado (SC-003).
- **Alternatives**: Modelo ML/embeddings (no determinista, difícil de auditar); solo coincidencia exacta de nombres (baja cobertura en legacy).

## R3. Muestreo estadístico seguro
- **Decision**: Orden de preferencia: (1) estadísticas del motor (distintos, nulos, histogramas agregados); (2) comprobación de contención agregada con muestra ≤ 100 filas (`TABLESAMPLE` donde exista) calculada **dentro del motor**, retornando solo `matchRatio` y conteos; timeout 1 s con `AbortSignal`/cancelación nativa. Si falla o expira, se degrada la confianza (no se bloquea). Requiere que el candidato padre sea PK/único/indexado.
- **Rationale**: Evita exfiltrar valores (Principios III/IV) y respeta la cancelación real (feature 004).
- **Alternatives**: Traer valores y compararlos en Node (filtra datos, rechazado); escaneo completo (DoS).

## R4. Glosario versionable
- **Decision**: Archivo YAML o JSON en el repo (`docs/glossary.yaml`), validado con `zod` (esquema en [glossary.schema.json](./contracts/glossary.schema.json)), campo `version` obligatorio. Carga al arranque y recarga con `fs.watch` con debounce (+ herramienta/comando de recarga como respaldo, pues `fs.watch` es poco fiable en algunas plataformas). Ante error: se conserva la última versión válida y se reporta línea/causa. Textos limitados en longitud, se eliminan caracteres de control y se envuelven con el `zero-trust-sanitizer` al emitirse. Referencias a objetos inexistentes ⇒ advertencia `stale_glossary_reference`.
- **Rationale**: Versionado y revisión por PR; la validación evita glosarios corruptos o maliciosos.
- **Alternatives**: Glosario en tabla de BD (escritura prohibida, sin Git); carga solo al arranque (SC-005 incumplido).

## R5. Búsqueda en glosario
- **Decision**: Índice léxico en memoria (tokens normalizados sin tildes, sinónimos, códigos de dominio) con ranking por campo; sin embeddings. La spec menciona "semántica/léxica": se implementa léxica con sinónimos.
- **Alternatives**: Búsqueda vectorial (dependencia y no determinismo innecesarios para ≤ 5k entradas).

## R6. Auditoría
- **Decision**: Añadir a `AuditQueryOutcome` el tipo de actividad vía campo de acción (`CATALOG_DISCOVERY`, `RELATIONSHIP_INFERENCE`, `GLOSSARY_QUERY`) manteniendo la cadena de hash; se registran parámetros (esquema, tabla, umbral), nunca contenido del glosario ni valores muestreados.
- **Rationale**: Principio V; evita romper el verificador existente (cambio aditivo en el payload canónico con versionado de formato).

## Resoluciones de ambigüedad de la spec
- El texto de la spec menciona `LIMIT` pequeño para muestreo: se reemplaza por muestreo agregado interno (R3) para no devolver valores.
- La ruta por defecto del glosario es `docs/glossary.yaml` (se descarta `.specify/` por ser infraestructura de Spec Kit).
