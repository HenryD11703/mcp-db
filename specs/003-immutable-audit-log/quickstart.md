# Quickstart Validation Guide: Sistema de Auditoría Estructurada e Inmutable

**Feature Branch**: `003-immutable-audit-log`  
**Date**: 2026-10-30  
**Status**: Ready for Validation  

Esta guía proporciona los pasos y comandos ejecutables para verificar de extremo a extremo que el sistema de auditoría registra con precisión matemática todas las consultas, protege los datos sensibles y garantiza la inmutabilidad de los registros.

---

## 1. Requisitos Previos

1. Dependencias instaladas en el repositorio:
   ```bash
   npm install
   ```
2. Compilación de tipos sin errores:
   ```bash
   npm run typecheck
   ```

---

## 2. Escenarios de Validación Rápida

### Escenario 1: Ejecución de la Suite de Pruebas Automatizadas de Auditoría

Ejecutar la batería completa de pruebas unitarias y de integridad:

```bash
npm run test:audit
# o directamente vía vitest:
npx vitest run tests/unit/audit-logger.spec.ts tests/unit/sql-sanitizer-for-audit.spec.ts tests/unit/audit-verifier.spec.ts
```

**Resultado Esperado**:
- 100% de las pruebas pasan.
- Verificación de que consultas exitosas generan estado `EXECUTED`, rechazos generan `REJECTED_BY_GUARD` con causa exacta, y que nunca se exfiltraron parámetros ni filas en el log.

---

### Escenario 2: Prueba de Sanitización de Literales y Protección contra Filtración de Datos

Ejecutar la prueba especializada de sanitización de SQL:

```bash
npx vitest run tests/unit/sql-sanitizer-for-audit.spec.ts
```

**Pruebas Clave**:
- Consulta con DPI: `SELECT * FROM clientes WHERE dpi = '2458912340101'`  
  -> Evaluada como: `SELECT * FROM clientes WHERE dpi = '[REDACTED_LITERAL]'`
- Consulta con montos y correos: `SELECT * FROM cuentas WHERE saldo > 50000 AND email = 'admin@corp.gt'`  
  -> Evaluada como: `SELECT * FROM cuentas WHERE saldo > [REDACTED_NUM] AND email = '[REDACTED_LITERAL]'`
- Cero valores de parámetros ni celdas en el log.

---

### Escenario 3: Verificación de Inmutabilidad y Detección Forense de Alteraciones

Generar un log de prueba y comprobar la integridad con la herramienta CLI:

1. **Verificar log íntegro**:
   ```bash
   npx tsx bin/audit-verify.ts ./test-audit.jsonl
   ```
   **Salida Esperada**:
   ```text
   [AUDIT VERIFY SUCCESS] 150 entries verified. Chain intact.
   Range: Sequence #1 to #150
   Status: OK (0 violations)
   ```

2. **Simular alteración adversaria** (modificar una celda de un registro o borrar una línea intermedia):
   ```bash
   # Tras alterar un campo en test-audit.jsonl:
   npx tsx bin/audit-verify.ts ./test-audit.jsonl
   ```
   **Salida Esperada**:
   ```text
   [AUDIT VERIFY FAILED] Integrity chain broken!
   Line: 42 (Sequence #42)
   Violation: HASH_MISMATCH (Expected: a9f3..., Actual: 8b12...)
   Correlation ID: c8b0e77d-7043-4e67-8e62-c124e930f1d5
   Exit Code: 1
   ```

---

### Escenario 4: Verificación de Política Fail-Closed

1. Configurar una ruta de log sin permisos de escritura (o apuntar a un archivo de solo lectura simulado).
2. Intentar ejecutar una consulta mediante el servidor MCP.
3. **Resultado Esperado**: El servidor MCP rechaza devolver datos al cliente, arrojando un error estructurado de persistencia de auditoría (`AuditPersistenceError`) sin ejecutar la consulta en la base de datos o sin entregar resultados no auditados.
