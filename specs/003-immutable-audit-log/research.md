# Phase 0: Research & Technical Decisions: Sistema de Auditoría Estructurada e Inmutable

**Feature Branch**: `003-immutable-audit-log`  
**Date**: 2026-10-30  
**Status**: Completed  

---

## 1. Technical Context Findings

- **Runtime & Language**: Node.js `>=20.0.0`, TypeScript 5.7+ (`strict: true`), ESM (`"type": "module"`).
- **Core Dependencies**:
  - `@modelcontextprotocol/sdk` (^1.0.4) para manejo de peticiones de herramientas.
  - Node.js native `crypto` module para cálculo de `SHA-256` y generación de UUIDs/correlation IDs (`randomUUID`).
  - Node.js native `node:fs` y `node:fs/promises` con streams de solo adición (`flags: 'a'`) para persistencia atómica en modo append-only.
- **Testing**: `vitest` (^2.1.8) con cobertura unitaria, suites adversarias y pruebas de integridad encadenada.
- **Performance Targets**:
  - Sobrecarga acumulada de auditoría (sanitización de SQL + SHA-256 hash + serialización JSON + append-only write) `< 5 ms` en p95.
  - Operación asíncrona no bloqueante pero con semántica estricta de *fail-closed* ante fallos de persistencia.

---

## 2. Research Decisions & Design Choices

### Decision 1: Hashing Criptográfico Encadenado y Formato Canónico
- **Decision**: Se utilizará el algoritmo nativo `SHA-256` provisto por `node:crypto`. La huella de integridad se calcula como `SHA-256(previousHash + canonicalJson)`.
- **Canonical Serialization**: Se implementa un serializador JSON determinista (`canonicalizeJson`) que ordena alfabéticamente las claves del registro excluyendo los campos `entryHash` y `previousHash` antes de computar la huella.
- **Genesis Block**: Para el primer registro del sistema o cuando se inicia un log sin predecesor, `previousHash` se fija en 64 ceros hexadecimales (`"0000000000000000000000000000000000000000000000000000000000000000"`).
- **Rationale**: SHA-256 en Node.js es una operación síncrona optimizada en C++ que toma menos de 0.05 ms por bloque de tamaño típico. No introduce dependencias externas y permite validación forense universal con herramientas estándar.
- **Alternatives Considered**:
  - *HMAC con clave simétrica*: Requiere gestión de secretos y distribución de claves entre servidores y herramientas de auditoría externa.
  - *Firma asimétrica Ed25519*: Mayor sobrecarga de CPU por registro, innecesaria para verificación de inmutabilidad interna en logs estructurados.

### Decision 2: Sanitización Estricta de Literales SQL para Auditoría (`SqlSanitizerForAudit`)
- **Decision**: Sanitizar todas las sentencias SQL evaluadas antes de grabarlas en el log. Se reemplazan de forma exhaustiva:
  1. Todos los literales de cadena entre comillas simples o dobles (`'...'`, `"..."`) por `'[REDACTED_LITERAL]'`.
  2. Todas las constantes numéricas situadas en cláusulas de filtrado/comparación por `[REDACTED_NUM]`.
  3. Los valores reales de los parámetros de consulta (`params`) NUNCA se escriben; solo se registran los nombres y tipos o el marcador `[REDACTED_PARAM]`.
  4. Truncamiento de seguridad a 16 KB si la consulta evaluada es excesivamente grande, anexando `[TRUNCATED]`.
- **Rationale**: Cumple el Principio IV y Principio V de la Constitución ("Privacidad en Memoria" y "Auditoría Estructurada Inmutable"), asegurando que datos personales (DPI, correos, montos, teléfonos) inyectados como literales directos jamás queden plasmados en disco.
- **Alternatives Considered**:
  - *Regex simple de patrones sensibles*: Falla si un usuario introduce un dato confidencial que no sigue una regex específica (ej. nombre propio, dirección privada). El reemplazo universal de literales es determinista y no deja brechas.

### Decision 3: Persistencia Append-Only, Rotación y Manejo de Concurrencia
- **Decision**:
  - El componente `AuditLogger` utiliza un `WriteStream` o cola secuencial en memoria respaldada por `fs.appendFile` con bloqueo lógico de cola secuencial (*async mutex/queue*).
  - La numeración secuencial (`sequenceNumber`) es estrictamente monotónica e incremental (1, 2, 3...).
  - Soporte de rotación configurable:
    - Diaria: `audit-YYYY-MM-DD.jsonl`.
    - Por tamaño: cuando el archivo actual alcance el umbral configurable (100 MB por defecto), se genera un nuevo archivo indexado (ej. `audit-YYYY-MM-DD.1.jsonl`).
    - El primer registro del archivo rotado enlaza como `previousHash` el hash del último registro del archivo anterior, asegurando continuidad de la cadena criptográfica a través de particiones físicas de archivo.
- **Rationale**: Evita la corrupción de líneas ante peticiones concurrentes y previene agotamiento de almacenamiento.
- **Alternatives Considered**:
  - *Archivos SQLite dedicados para auditoría*: Rompe la simplicidad de formato universal JSON Lines (NDJSON) y complica el streaming forense en herramientas SIEM (Datadog, Splunk, Elastic).

### Decision 4: Política Fail-Closed e Integración con el Servidor MCP
- **Decision**:
  - Toda llamada a `query_database`, `explain_query` o herramienta futura es interceptada por un wrapper de auditoría que:
    1. Genera un `correlationId` (UUID v4) al recibir la solicitud.
    2. Registra el contexto del solicitante (`requesterId` extraído de la sesión/transporte o `anonymous-session:<id>`).
    3. Cronometra la ejecución con alta resolución (`performance.now()`).
    4. En caso de éxito, registra `EXECUTED` con `executionTimeMs` y `rowCount`.
    5. En caso de rechazo del guard, registra `REJECTED_BY_GUARD` con el código y motivo exacto de la violación.
    6. En caso de timeout, costo o estados intermedios, registra `CANCELLED_BY_TIMEOUT`, `BLOCKED_BY_COST` o `PENDING_APPROVAL`.
    7. Si la escritura del log de auditoría falla (disco lleno, error de permisos), el sistema lanza una excepción crítica `AuditPersistenceError` y se niega a devolver los resultados al cliente MCP (*fail-closed*).
- **Rationale**: Garantiza que no exista ninguna consulta "fantasma" sin rastro auditable.

### Decision 5: Herramienta CLI de Verificación Forense (`audit-verify`)
- **Decision**: Crear un script CLI TypeScript ejecutable (`bin/audit-verify.ts` expuesto en package.json como `audit-verify` y `npm run audit:verify`) que recibe la ruta a un archivo `.jsonl` (o directorio de logs rotados), valida línea por línea el parsing JSON, la continuidad secuencial de `sequenceNumber` y recalcula la cadena de hashes SHA-256.
- **Rationale**: Permite a auditores independientes validar la inmutabilidad de los logs sin necesidad de levantar el servidor MCP ni depender de bases de datos.
