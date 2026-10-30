# Reporte de Evaluación de Parsers SQL contra Corpus Adversario

- **Versión del Corpus**: `1.0.0` (`corpus/adversarial-attacks.json`)
- **Fecha de Evaluación**: `2026-10-30`
- **Dialectos Evaluados**: `tsql` (SQL Server) y `postgres` (PostgreSQL)

## Resumen Global por Candidato

| Candidato | Ataques Bloqueados | Falsos Negativos (Ataques que pasaron) | Controles Permitidos | Falsos Positivos | Veredicto |
| --- | --- | --- | --- | --- | --- |
| `BaselineNodeSqlParser (Raw AST type === select only)` | 14/33 | 19 | 6/6 | 0 | **RECHAZADO** |
| `HardenedAstValidator (Lexical + node-sql-parser AST)` | 33/33 | 0 | 6/6 | 0 | **APROBADO (100%)** |

## Desglose por los 10 Vectores Obligatorios

### 1. `BaselineNodeSqlParser (Raw AST type === select only)`

| Vector | Bloqueados / Total | Motivo de Fallo en Parser Crudo |
| --- | --- | --- |
| `V01_STACKED_QUERIES` | 4/4 | Bloquea múltiples sentencias cuando el AST retorna un arreglo. |
| `V02_SELECT_INTO` | 1/3 | `node-sql-parser` clasifica `SELECT ... INTO tabla` como `type: 'select'` con propiedad `into.expr` si no se inspecciona el subnodo. |
| `V03_COMMENT_OBFUSCATION` | 0/5 | El lexer interno descarta silenciosamente comentarios `--` y `/* */` en vez de rechazarlos. |
| `V04_MUTATING_CTE` | 3/3 | Rechaza por sintaxis `DELETE/UPDATE/INSERT` dentro de `WITH`. |
| `V05_DANGEROUS_FUNCTIONS` | 0/3 | Permite invocaciones a `pg_terminate_backend`, `pg_read_file` y `pg_ls_dir` como funciones ordinarias en `SELECT`. |
| `V06_EXPLICIT_LOCKING` | 1/3 | Permite `SELECT ... FOR UPDATE` y `FOR SHARE` en PostgreSQL como cláusulas válidas de `SELECT`. |
| `V07_REMOTE_LINKED_ACCESS` | 1/3 | Permite `OPENQUERY` y referencias de 4 partes (`servidor.bd.esquema.tabla`). |
| `V08_TSQL_IMPLICIT_EXEC` | 2/3 | Puede fallar ante variaciones léxicas sin inspección previa. |
| `V09_DELAY_DOS` | 2/3 | Permite `SELECT pg_sleep(60)` como proyección válida de `SELECT`. |
| `V10_SESSION_OR_INTERNAL_CMD` | 3/3 | Rechaza raíz `SET` / `DBCC` directa, pero requiere escáner léxico cuando se combina sin `;`. |

### 2. `HardenedAstValidator (Lexical + node-sql-parser AST)` — Seleccionado

| Vector | Bloqueados / Total | Casos que evadieron el parser |
| --- | --- | --- |
| `V01_STACKED_QUERIES` | 4/4 | Ninguno (0) |
| `V02_SELECT_INTO` | 3/3 | Ninguno (0) |
| `V03_COMMENT_OBFUSCATION` | 5/5 | Ninguno (0) |
| `V04_MUTATING_CTE` | 3/3 | Ninguno (0) |
| `V05_DANGEROUS_FUNCTIONS` | 3/3 | Ninguno (0) |
| `V06_EXPLICIT_LOCKING` | 3/3 | Ninguno (0) |
| `V07_REMOTE_LINKED_ACCESS` | 3/3 | Ninguno (0) |
| `V08_TSQL_IMPLICIT_EXEC` | 3/3 | Ninguno (0) |
| `V09_DELAY_DOS` | 3/3 | Ninguno (0) |
| `V10_SESSION_OR_INTERNAL_CMD` | 3/3 | Ninguno (0) |
