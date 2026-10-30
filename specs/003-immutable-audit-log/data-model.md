# Data Model: Sistema de Auditoría Estructurada e Inmutable

**Feature Branch**: `003-immutable-audit-log`  
**Date**: 2026-10-30  
**Status**: Completed  

---

## 1. Entities & Data Structures

### 1.1 `AuditQueryOutcome` (Enumeration)
Estado estandarizado del ciclo de vida de la consulta.

```typescript
export type AuditQueryOutcome =
  | 'EXECUTED'
  | 'REJECTED_BY_GUARD'
  | 'BLOCKED_BY_COST'
  | 'PENDING_APPROVAL'
  | 'CANCELLED_BY_TIMEOUT';
```

---

### 1.2 `AuditLogEntry` (Core Immutable Record)
Representa un evento atómico de auditoría estructurada. Cada registro es inmutable tras su creación y serializado como una línea individual JSON en formato JSON Lines.

| Field | Type | Description | Constraints & Validation |
| :--- | :--- | :--- | :--- |
| `sequenceNumber` | `number` | Número de secuencia monotónico continuo. | Entero positivo incremental (`1, 2, 3...`). No puede tener huecos. |
| `correlationId` | `string` | Identificador de correlación único de la petición. | Formato UUID v4. |
| `requesterId` | `string` | Identidad o sesión del cliente que solicita la consulta. | String no vacío. Si no se provee, `anonymous-session:<id>`. |
| `timestamp` | `string` | Marca temporal UTC en formato ISO 8601. | Cumple `YYYY-MM-DDTHH:mm:ss.sssZ`. |
| `engine` | `DatabaseEngineType` | Motor de base de datos destino (`mssql`, `postgres`). | Valor restringido por motores registrados. |
| `database` | `string` | Nombre o catálogo de la base de datos destino. | String no vacío. |
| `evaluatedSql` | `string` | Sentencia SQL evaluada con literales y valores sensibles sanitizados. | Literales redactados; truncado a 16 KB si excede tamaño. |
| `status` | `AuditQueryOutcome` | Estado final del procesamiento. | Uno de los 5 estados válidos. |
| `rejectionReason` | `string \| null` | Código de error y descripción detallada en caso de rechazo, costo o timeout. | Obligatorio si `status != 'EXECUTED'`, `null` si es `EXECUTED`. |
| `executionTimeMs` | `number` | Tiempo de ejecución o evaluación en milisegundos. | Número no negativo con hasta 2 decimales. |
| `rowCount` | `number` | Cantidad exacta de filas retornadas por la consulta. | Entero `>= 0`. Obligatoriamente `0` si `status != 'EXECUTED'`. |
| `previousHash` | `string` | Huella SHA-256 del registro de auditoría inmediatamente anterior. | 64 caracteres hexadecimales. 64 ceros para bloque génesis. |
| `entryHash` | `string` | Huella SHA-256 del registro actual calculada sobre `previousHash` y el payload canónico. | 64 caracteres hexadecimales. |

---

### 1.3 `CanonicalAuditPayload`
Estructura intermedia normalizada para el cálculo determinista del hash de integridad. Contiene todos los campos del registro excluyendo `previousHash` y `entryHash`, con claves ordenadas lexicográficamente.

```typescript
export interface CanonicalAuditPayload {
  correlationId: string;
  database: string;
  engine: string;
  evaluatedSql: string;
  executionTimeMs: number;
  rejectionReason: string | null;
  requesterId: string;
  rowCount: number;
  sequenceNumber: number;
  status: AuditQueryOutcome;
  timestamp: string;
}
```

**Cálculo de Huella**:
$$\text{entryHash} = \text{SHA-256}(\text{previousHash} + \text{JSON.stringify(canonicalPayload)})$$

---

### 1.4 `AuditVerificationResult`
Resultado de la verificación de integridad de una secuencia de registros (utilizado por el verificador forense).

```typescript
export interface AuditVerificationResult {
  readonly isValid: boolean;
  readonly totalEntries: number;
  readonly firstSequenceNumber: number;
  readonly lastSequenceNumber: number;
  readonly violatedEntry?: {
    readonly sequenceNumber: number;
    readonly correlationId: string;
    readonly expectedHash: string;
    readonly actualHash: string;
    readonly reason: 'HASH_MISMATCH' | 'SEQUENCE_GAP' | 'INVALID_JSON' | 'PREVIOUS_HASH_MISMATCH';
    readonly lineNumber: number;
    readonly rawLine?: string;
  };
}
```

---

### 1.5 `AuditLoggerOptions`
Configuración del componente de auditoría.

```typescript
export interface AuditLoggerOptions {
  /** Ruta al archivo base de auditoría o directorio de logs. */
  readonly logFilePath: string;
  /** Tamaño máximo antes de rotar en bytes (por defecto 104,857,600 = 100MB). */
  readonly maxFileSizeBytes?: number;
  /** Activar rotación diaria de archivos (por defecto true). */
  readonly rotateDaily?: boolean;
  /** Política ante fallo de persistencia (por defecto true = fail-closed). */
  readonly failClosed?: boolean;
}
```

---

## 2. State Machine / Lifecycle Transitions

```
                 [Consulta recibida en MCP Server]
                                |
               +----------------+----------------+
               |                                 |
       (Infracción Guard)                 (Costo Excedido)
               |                                 |
               v                                 v
      [REJECTED_BY_GUARD]                [BLOCKED_BY_COST]
               |                                 |
               +----------------+----------------+
                                |
                   (Requiere Confirmación)
                                |
                                v
                       [PENDING_APPROVAL]
                                |
                +---------------+---------------+
                |                               |
          (Autorizado)                     (Denegado)
                |                               |
                v                               v
          [Aprobado]                   [REJECTED_BY_GUARD]
                |
     (Ejecución en Base de Datos)
                |
        +-------+-------+
        |               |
   (Éxito DB)      (Timeout DB)
        |               |
        v               v
   [EXECUTED]  [CANCELLED_BY_TIMEOUT]
```

*Nota*: Cada evento de transición escribe una entrada inmutable con su propio `sequenceNumber` y `timestamp`, vinculados mediante el mismo `correlationId`.
