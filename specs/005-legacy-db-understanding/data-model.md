# Data Model: Descubrimiento Legacy

Extiende `TableMetadata`/`ColumnMetadata`/`SchemaCatalog` de `src/contracts/database-adapter.ts`.

## TableSummary (salida de `list_tables`)
| Campo | Tipo | Notas |
|---|---|---|
| schema, name | string | Nombre calificado `schema.table` |
| kind | `TABLE` \| `VIEW` | |
| estimatedRows | number \| null | Desde estadísticas del catálogo |
| glossaryTitle | string \| null | Si existe entrada de glosario |

## ColumnDetail (extiende `ColumnMetadata`)
`maxLength`, `precision`, `scale`, `defaultExpression`, `isPrimaryKey`, `isUnique`, `indexNames[]`, `glossary?: ColumnGlossary`.

## TableDetail (salida de `describe_table`)
`TableSummary` + `columns: ColumnDetail[]`, `indexes[]`, `declaredForeignKeys[]`, `glossary?: TableGlossary`, `warnings[]`.

## InferredRelationship
| Campo | Tipo | Validación |
|---|---|---|
| child {schema, table, column} | | existe en catálogo |
| parent {schema, table, column} | | PK, única o indexada |
| score | number | 0.0–1.0 |
| level | `HIGH`\|`MEDIUM`\|`LOW` | derivado de score |
| factors | {lexical, typeCompat, statistical \| null} | cada uno 0–1 |
| reasons | string[] | explicación (sanitizada) |
| statisticalStatus | `VERIFIED`\|`SKIPPED`\|`TIMED_OUT`\|`UNAVAILABLE` | |

Regla: tipos incompatibles ⇒ la relación no se emite. Sin evidencia estadística ⇒ `score ≤ 0.84`. Relaciones ya declaradas como FK no se reinfieren.

## BusinessGlossary
`version` (string), `entries[]` de `GlossaryTable`.
- **GlossaryTable**: `table` (calificado o simple), `description`, `synonyms[]`, `columns[]`.
- **GlossaryColumn**: `column`, `meaning`, `synonyms[]`, `domainCodes[]`.
- **DomainCodeMapping**: `code`, `meaning`, `deprecated?`.

Estados del glosario cargado: `LOADED` → (archivo cambia) → `VALID_RELOAD` | `INVALID_KEPT_PREVIOUS` (con `errorLine`, `errorMessage`); `NOT_CONFIGURED` si no existe archivo (las tools siguen funcionando sin enriquecimiento).

## GlossaryReferenceWarning
`kind: stale_glossary_reference`, `target`, `reason`.

## DiscoveryAuditEvent
`action` (`CATALOG_DISCOVERY` | `RELATIONSHIP_INFERENCE` | `GLOSSARY_QUERY`), `requesterId`, `timestamp`, `parameters` (sin valores crudos), `resultCount`, `correlationId`.
