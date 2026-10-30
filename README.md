# db-mcp-node

Servidor MCP de base de datos de solo lectura desacoplado por contrato (`DatabaseAdapter`), con blindaje contra inyección SQL, guardián AST, enmascaramiento dinámico de datos sensibles en memoria, defensas zero-trust, **sistema de auditoría estructurada e inmutable con encadenamiento criptográfico SHA-256** y **control de costo de ejecución con flujo de aprobación humana fuera de banda**.

## Repositorio e Identidad Oficial

- **Repositorio Canónico**: [https://github.com/HenryD11703/mcp-db.git](https://github.com/HenryD11703/mcp-db.git)
- **Autor / Desarrollador**: `HenryD11703` (`3680558330101@ingenieria.usac.edu.gt`)
- **Gestión CLI Oficial**: GitHub CLI (`gh`) autenticado y vinculado.

---

## Características Principales

1. **Solo Lectura Inquebrantable**: Validación AST estricta (`SELECT` puro como nodo raíz, rechazo de sentencias encadenadas con `;`, comentarios ofuscadores, CTEs mutantes y `SELECT INTO`).
2. **Preflight Check en Arranque**: Verificación forzosa de permisos en base de datos; si el usuario tiene privilegios de modificación, el servidor aborta el inicio (*fail-closed*).
3. **Privacidad en Memoria**: Enmascaramiento de DPI, correos, teléfonos y montos financieros antes de serializar respuestas al cliente MCP.
4. **Defensa Zero-Trust**: Delimitación estructural de resultados (`<data_result>`) contra inyección indirecta de prompts en celdas de base de datos.
5. **Auditoría Estructurada e Inmutable**:
   - Cada consulta recibida genera un registro JSON estructurado en formato JSON Lines (`.jsonl`).
   - Captura: `correlationId`, `requesterId`, `timestamp` (ISO 8601), `engine`, `database`, `evaluatedSql`, `status` (`EXECUTED`, `REJECTED_BY_GUARD`, `BLOCKED_BY_COST`, `PENDING_APPROVAL`, `CANCELLED_BY_TIMEOUT`), `rejectionReason`, `executionTimeMs`, `rowCount`, `previousHash` y `entryHash`.
   - **Cero Filtración de Datos Sensibles**: Redacción estricta de literales de cadena (`'[REDACTED_LITERAL]'`), numéricos (`[REDACTED_NUM]`) y exclusión absoluta de parámetros o filas en crudo en los logs.
   - **Inmutabilidad Criptográfica**: Cada línea está encadenada mediante `SHA-256(previousHash + canonicalJson)`.
   - **Rotación Configurable**: Soporte de rotación por fecha y umbral de tamaño (100 MB por defecto) preservando el hash previo.
   - **Herramienta CLI de Verificación**: Comando `audit-verify` para auditar la integridad de cualquier log y detectar alteraciones o borrados de líneas.
6. **Control de Costo y Cancelación Real en Motor**:
   - Evaluación previa de planes de ejecución (`EXPLAIN JSON` en PostgreSQL, `SET SHOWPLAN_XML ON` en SQL Server).
   - Detección de operaciones críticas (escaneos secuenciales en tablas grandes, uniones cartesianas) y rechazo inmediato (`BLOCKED_BY_COST`).
   - Cancelación real en el motor de base de datos (`pg_cancel_backend` / `request.cancel`) registrando `CANCELLED_BY_TIMEOUT`.
   - Rate limiting de dos niveles (por cliente y global) mediante ventana deslizante en memoria.
7. **Aprobación Humana Asíncrona (Human-in-the-Loop)**:
   - Consultas con advertencias de riesgo quedan en estado `PENDING_APPROVAL` con ticket y TTL de 15 minutos sin congelar la conexión del cliente MCP.
   - La IA tiene prohibido constitucionalmente aprobar sus propias consultas (Principio II).
   - Operador humano revisa y decide fuera de banda mediante la CLI `db-mcp`.
   - Herramienta pasiva de solo lectura `get_query_result` para consultar el estado y recoger resultados una vez autorizados.

---

## CLI del Operador (`db-mcp`)

Gestión fuera de banda de tickets de aprobación para consultas en cuarentena:

```bash
# Listar solicitudes pendientes
npx db-mcp list

# Aprobar una consulta retenida
npx db-mcp approve appr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx --operator "nombre_operador" --reason "Motivo de autorización"

# Rechazar una consulta retenida
npx db-mcp reject appr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx --operator "nombre_operador" --reason "Motivo de rechazo"
```

---

## Verificación de Integridad de Auditoría (`audit-verify`)

El sistema incluye una herramienta CLI dedicada para verificar forensemente que la cadena de auditoría no ha sido manipulada ni truncada:

```bash
# Verificación directa vía npx / node:
node dist/src/bin/audit-verify.js [ruta-al-archivo-log.jsonl]

# O vía script npm:
npm run audit:verify
```

### Respuestas de Verificación:
- **Éxito**: Código de salida `0` con informe de registros verificados y rango de secuencias.
- **Detección de Manipulación**: Código de salida `1` con identificación exacta del número de línea, secuencia, correlación y discrepancia de hash (`HASH_MISMATCH`, `SEQUENCE_GAP`, `PREVIOUS_HASH_MISMATCH` o `INVALID_JSON`).

---

## Configuración

Variables de entorno y opciones de configuración:
- `AUDIT_LOG_PATH`: Ruta al archivo activo de auditoría (por defecto: `./audit.jsonl`).
- `APPROVAL_STORE_PATH`: Ruta al almacén de tickets de aprobación (por defecto: `./.db-mcp/pending-approvals.json`).

---

## Pruebas y Compilación

```bash
# Ejecutar suite completa (24 suites, 166 tests)
npm test

# Pruebas de límites de costo y DOS
npm run test:limits

# Pruebas de rate limiting
npm run test:rate-limit

# Pruebas del flujo de aprobación humana
npm run test:approval

# Compilación y verificación de tipos estricta
npm run typecheck
npm run build
```
