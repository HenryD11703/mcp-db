# Quickstart: Validación de Control de Costo, Límites Operativos y Aprobación Humana

**Feature**: `004-cost-limits-human-approval`  
**Date**: 2026-10-30  
**Status**: Ready for Validation  

---

## 1. Prerrequisitos y Configuración de Entorno

### Variables de Entorno y Configuración
```bash
# Límites operativos
export MCP_EXECUTION_TIMEOUT_MS=3000
export MCP_MAX_ROWS_LIMIT=50
export MCP_RATE_LIMIT_CLIENT_CPM=5
export MCP_RATE_LIMIT_GLOBAL_CPM=20

# Ruta del almacén de tickets de aprobación y auditoría
export PENDING_APPROVAL_STORE_PATH=".db-mcp/pending_approvals.json"
export AUDIT_LOG_PATH="audit/audit-test.jsonl"
```

---

## 2. Escenarios de Validación Ejecutable

### Escenario 1: Bloqueo Preventivo de Escaneo Completo en Tabla Grande
**Objetivo**: Verificar que una consulta con `Seq Scan` sobre una tabla grande protegida sea abortada antes de tocar la base de datos sin generar carga.

1. **Consulta Enviada al Tool MCP**:
   ```json
   {
     "sql": "SELECT * FROM transacciones_historicas WHERE notas LIKE '%reembolso%'",
     "engine": "postgres",
     "database": "finanzas"
   }
   ```
2. **Resultado Esperado**:
   - Código de estado: `BLOCKED_BY_COST`.
   - Mensaje: `"Consulta bloqueada preventivamente: se detectó escaneo completo (Seq Scan) en tabla protegida 'transacciones_historicas'."`
   - La base de datos no registra ninguna ejecución real en `pg_stat_activity`.
   - Entrada de auditoría emitida con `status: "BLOCKED_BY_COST"` y `rowCount: 0`.

---

### Escenario 2: Detección y Bloqueo de Producto Cartesiano
**Objetivo**: Proteger el servidor contra joins accidentales sin predicado de enlace.

1. **Consulta Enviada**:
   ```json
   {
     "sql": "SELECT * FROM clientes, facturas",
     "engine": "tsql",
     "database": "ventas"
   }
   ```
2. **Resultado Esperado**:
   - Código de estado: `BLOCKED_BY_COST`.
   - Mensaje: `"Consulta bloqueada preventivamente: se detectó producto cartesiano (unión sin condición WHERE u ON)."`
   - `0` filas devueltas.

---

### Escenario 3: Cancelación Real en Motor por Timeout de Ejecución
**Objetivo**: Confirmar que al vencer el temporizador de ejecución (`executionTimeoutMs`), el motor de base de datos recibe la señal activa de aborto (`request.cancel` o `pg_cancel_backend`) y no deja hebras huérfanas.

1. **Consulta Simulada con Retardo**:
   ```json
   {
     "sql": "SELECT pg_sleep(10)",
     "engine": "postgres",
     "database": "operaciones"
   }
   ```
2. **Resultado Esperado en el Cliente MCP**:
   - A los 3000 ms, la solicitud retorna con error estructurado de timeout.
   - En el servidor PostgreSQL se constata que `pg_cancel_backend` fue invocado sobre el PID de la consulta.
   - La sesión ya no figura en ejecución en `pg_stat_activity`.
   - Registro de auditoría generado con `status: "CANCELLED_BY_TIMEOUT"`, `executionTimeMs: ~3000` y `rowCount: 0`.

---

### Escenario 4: Truncamiento Seguro con `maxRowsLimit`
**Objetivo**: Prevenir desbordamientos de memoria cuando una consulta devuelve un volumen superior al tope configurado (ej. 50 filas).

1. **Consulta Enviada**:
   ```json
   {
     "sql": "SELECT id, descripcion FROM catalogo_productos",
     "engine": "postgres",
     "database": "inventario"
   }
   ```
2. **Resultado Esperado**:
   - Respuesta exitosa conteniendo exactamente `50` filas.
   - Metadatos de respuesta con `truncated: true`.
   - Advertencia visible: `"El conjunto de resultados excedió el límite configurado de 50 filas y fue acotado por política operativa."`

---

### Escenario 5: Rechazo Rápido por Límite de Tasa ($O(1)$ en Memoria)
**Objetivo**: Validar el rate limiting híbrido en dos niveles.

1. **Acción**: Enviar 6 consultas consecutivas en menos de 10 segundos con el mismo cliente (`MCP_RATE_LIMIT_CLIENT_CPM=5`).
2. **Resultado Esperado**:
   - Las primeras 5 consultas son procesadas normalmente.
   - La 6ª consulta es rechazada en `< 1 ms` con error estructurado:
     ```json
     {
       "error": "RATE_LIMIT_EXCEEDED",
       "level": "CLIENT",
       "message": "Se ha superado la cuota de 5 consultas por minuto para este cliente. Reintente en 52 segundos."
     }
     ```
   - No se genera ninguna conexión ni llamada a la base de datos para la petición rechazada.

---

### Escenario 6: Flujo de Aprobación Humana Asíncrono sin Bloqueo de Cliente
**Objetivo**: Validar la retención `PENDING_APPROVAL`, el aislamiento anti-auto-aprobación de la IA, el comando CLI de operador y la herramienta pasiva de consulta de resultados.

1. **Paso 1: Solicitud de Consulta en Zona de Precaución**:
   - La IA invoca `query_database` con una consulta estimada con costo intermedio (ej. 15,000 filas estimadas).
   - Respuesta inmediata en `< 500 ms`:
     ```json
     {
       "status": "PENDING_APPROVAL",
       "approvalId": "appr_7c9e6679-7425-40de-944b-e07fc1f90ae7",
       "riskSummary": {
         "estimatedRows": 15000,
         "estimatedCost": 7500,
         "warnings": ["Filas estimadas superan el umbral de precaución (10,000)"]
       },
       "message": "La consulta requiere autorización de un operador humano. Use el comando CLI para autorizarla."
     }
     ```
2. **Paso 2: Intento de Auto-Aprobación por la IA**:
   - La IA examina las herramientas disponibles; no existe ninguna herramienta `approve_query` o parámetro para forzar la ejecución.
   - Cualquier intento de reenvío con parámetros arbitrarios devuelve el ticket existente o es rechazado.
3. **Paso 3: Autorización por Operador Humano (CLI)**:
   - El operador revisa el ticket en su terminal:
     ```bash
     node dist/bin/db-mcp.js list-pending
     node dist/bin/db-mcp.js approve appr_7c9e6679-7425-40de-944b-e07fc1f90ae7 --reason "Aprobado para reporte fiscal mensual"
     ```
   - El comando CLI ejecuta la consulta y almacena el resultado en el almacén local seguro.
4. **Paso 4: Recuperación Pasiva por el Cliente/Agente**:
   - El cliente MCP invoca la herramienta pasiva:
     ```json
     {
       "tool": "get_query_result",
       "arguments": {
         "approvalId": "appr_7c9e6679-7425-40de-944b-e07fc1f90ae7"
       }
     }
     ```
   - El servidor retorna los datos autorizados debidamente enmascarados y delimitados.
   - Auditoría final registrada como `EXECUTED` con el mismo `correlationId`.
