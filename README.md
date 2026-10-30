# db-mcp-node

Servidor MCP de base de datos de solo lectura desacoplado por contrato (`DatabaseAdapter`), con blindaje contra inyección SQL, guardián AST, enmascaramiento dinámico de datos sensibles en memoria, defensas zero-trust y **sistema de auditoría estructurada e inmutable con encadenamiento criptográfico SHA-256**.

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

## Configuración de Auditoría

Variables de entorno y opciones de configuración:
- `AUDIT_LOG_PATH`: Ruta al archivo activo de auditoría (por defecto: `./audit.jsonl`).

---

## Pruebas

```bash
# Ejecutar suite completa
npm test

# Ejecutar pruebas unitarias de auditoría
npm run test:audit

# Compilación y verificación de tipos estricta
npm run typecheck
npm run build
```
