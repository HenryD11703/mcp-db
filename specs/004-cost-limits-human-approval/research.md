# Research: Control de Costo, Límites Operativos y Flujo de Aprobación Humana

**Feature**: `004-cost-limits-human-approval`  
**Date**: 2026-10-30  
**Status**: Completed  

---

## 1. Análisis de Planes de Ejecución y Detección de Riesgos

### Contexto y Problema
Antes de ejecutar consultas `SELECT` válidas, el servidor MCP debe solicitar al motor relacional la estimación de su plan de ejecución para evaluar el riesgo de sobrecarga o denegación de servicio (DoS) involuntario. Se requiere detectar:
1. Escaneos completos (*Seq Scan* en PostgreSQL, *Table Scan* / *Index Scan* no acotado en SQL Server) sobre tablas catalogadas como grandes o protegidas.
2. Productos cartesianos (*Cartesian Join* o uniones sin predicado de enlace).
3. Filas estimadas excesivas o costo computacional del optimizador que supere los umbrales configurados.

### Decisión Técnica: Evaluación Normalizada Multi-Motor y Política Fail-Safe
- **PostgreSQL**: Se invoca `EXPLAIN (FORMAT JSON) <query>` con los parámetros tipados. Se recorre recursivamente el árbol del plan inspeccionando `Node Type`, `Relation Name`, `Plan Rows` y `Total Cost`.
- **SQL Server**: Se utiliza `SET SHOWPLAN_XML ON` (o la consulta del plan estimado vía `sys.dm_exec_query_plan`) para inspeccionar operadores de escaneo (`TableScan`, `IndexScan`), uniones sin predicado (`NestedLoops` o `HashMatch` sin condición de join) y atributos de costo/filas (`StatementSubTreeCost`, `StatementEstRows`).
- **Mapeo de Severidad de Riesgo**:
  - `LOW`: Filas estimadas y costo dentro del umbral normal, sin escaneos en tablas protegidas ni productos cartesianos. Proceder con ejecución directa.
  - `MEDIUM_CAUTION`: Costo o filas por encima del umbral de precaución, escaneos en tablas intermedias, o plan de ejecución no verificable (por timeout de 2s o formato desconocido). Transicionar a `PENDING_APPROVAL`.
  - `CRITICAL_BLOCK`: Escaneo completo en tablas protegidas configuradas, producto cartesiano explícito, o costo/filas por encima del umbral máximo de bloqueo absoluto. Bloqueo inmediato con `BLOCKED_BY_COST`.
- **Política Fail-Safe (Plan No Verificable)**:
  - Temporizador dedicado de 2 segundos para la obtención del plan. Si el motor demora más de 2 segundos en calcular el plan, falla por sintaxis o produce un formato no interpretable, se clasifica automáticamente como `MEDIUM_CAUTION` (`PENDING_APPROVAL` con etiqueta `"Plan no verificable"`), impidiendo cualquier ejecución ciega en base de datos.

### Alternativas Descartadas
- *Ejecutar a ciegas con solo timeout*: Inseguro. Una consulta cartesiana puede saturar los buffers y bloquear tablas en segundos antes de que venza el timeout.
- *Análisis puramente heurístico de sintaxis SQL*: Frágil. El parser SQL no conoce los índices existentes en la base de datos ni el volumen real de las tablas; solo el optimizador del motor conoce el plan de ejecución real.
- *Fail-Closed ante plan no verificable*: Rechazaría consultas válidas ante lentitud transitoria en los catálogos del motor. La política de precaución (`PENDING_APPROVAL`) ofrece el equilibrio óptimo entre seguridad inquebrantable y disponibilidad.

---

## 2. Límites Operativos: Rate Limiting Híbrido de Dos Niveles

### Contexto y Problema
Múltiples clientes MCP (agentes autónomos, IDEs, Claude Desktop) pueden enviar consultas simultáneamente o generar bucles de llamadas que saturen el pool de conexiones o el motor de base de datos.

### Decisión Técnica: Ventana Deslizante en Memoria de Dos Niveles
- **Nivel 1 (Por Cliente/Sesión)**: `rateLimitPerClientPerMinute` (predeterminado: 60 consultas/minuto por `requesterId` o identificador de transporte de sesión). Impide que un agente en bucle acapare los recursos.
- **Nivel 2 (Global de la Instancia MCP)**: `rateLimitGlobalPerMinute` (predeterminado: 300 consultas/minuto agregadas). Protege el pool total de conexiones de la base de datos contra concurrencia masiva.
- **Algoritmo**: Ventana deslizante en memoria basada en timestamps o balde de fichas determinista.
  - Costo computacional $O(1)$ por verificación.
  - Cero dependencias externas (sin Redis ni bases de datos auxiliares).
  - En caso de superación de cuota, rechazo instantáneo en menos de 1 ms informando el nivel alcanzado y los segundos restantes para la recarga.

### Alternativas Descartadas
- *Rate limiting exclusivamente global*: Permitiría que un solo cliente mal diseñado agote la cuota de todos los demás usuarios legítimos.
- *Rate limiting exclusivamente por cliente*: No protegería el servidor si 20 agentes envían ráfagas simultáneas dentro de sus límites individuales pero superando la capacidad del motor relacional.

---

## 3. Cancelación Real en el Motor de Base de Datos y Timeout de Ejecución

### Contexto y Problema
Cuando una consulta excede el tiempo límite de ejecución (`executionTimeoutMs`, ej. 5 segundos), simplemente cerrar el socket del cliente o abortar la promesa en Node.js deja la consulta ejecutándose en segundo plano en el motor relacional consumiendo CPU, memoria y reteniendo bloqueos (*locks*).

### Decisión Técnica: AbortController y Señal Nativa en Motor
- **Mecanismo de Temporización**: Cada consulta en ejecución crea un `AbortController` local asociado a su temporizador de timeout.
- **Señal en PostgreSQL**:
  - Al recibir la señal de aborto, el adaptador obtiene el Process ID (`backendPid`) de la conexión activa y ejecuta `SELECT pg_cancel_backend($1)` a través de un canal administrativo o conexión de control dedicada.
  - Si tras 2 segundos el backend no confirma la cancelación, se invoca `SELECT pg_terminate_backend($1)` para forzar la liberación de recursos.
- **Señal en SQL Server**:
  - Al dispararse el evento `abort`, el adaptador invoca directamente `request.cancel()` en el objeto `Request` de la librería `mssql` / `tedious`.
  - El driver envía el paquete de atención (*attention packet*) al motor SQL Server, cancelando de inmediato la ejecución del lote.
- **Auditoría y Estado**: Se garantiza la emisión de la entrada de auditoría inmutable con estado `CANCELLED_BY_TIMEOUT` y el tiempo transcurrido exacto.

### Alternativas Descartadas
- *Abandono pasivo del socket (client disconnect only)*: Deja procesos huérfanos (*runaway queries*) en la base de datos, violando el principio constitucional de Control de Costo y Cancelación Real.

---

## 4. Truncamiento Seguro de Filas (`maxRowsLimit`)

### Contexto y Problema
Una consulta que retorna cientos de miles de filas puede colapsar la memoria del proceso Node.js, saturar el canal de transporte MCP o desbordar la ventana de contexto del LLM.

### Decisión Técnica: Corte Temprano con Bandera `truncated: true`
- El parámetro `maxRowsLimit` (predeterminado: 1,000 filas) se propaga al adaptador de base de datos.
- El adaptador lee hasta `maxRowsLimit` filas mediante streaming o buffers acotados; al alcanzar el tope, detiene la lectura adicional y descarta cualquier excedente.
- La respuesta estructurada devuelve las filas recolectadas, anexando obligatoriamente los metadatos:
  ```json
  {
    "rowCount": 1000,
    "truncated": true,
    "warning": "El conjunto de resultados excedió el límite configurado de 1000 filas y fue acotado por política operativa."
  }
  ```

---

## 5. Almacén Persistente de Aprobaciones y Flujo Asíncrono de Aprobación Humana

### Contexto y Problema
Cuando una consulta cae en la zona de precaución (`MEDIUM_CAUTION`), no debe bloquear la conexión MCP (lo que provocaría timeouts en clientes como Claude Desktop) ni debe ser auto-aprobada por la IA. Debe admitir una confirmación humana explícita y asíncrona.

### Decisión Técnica: Almacén Local Estructurado con TTL y Herramienta Pasiva
1. **Registro en `PENDING_APPROVAL`**:
   - Se genera un identificador criptográfico único (`approvalId`, ej. `appr_uuidv4`).
   - Se registra el ticket en un almacén en archivo local JSON estructurado (`PENDING_APPROVAL_STORE_PATH`, predeterminado `.db-mcp/pending_approvals.json`) con escritura atómica (`write-temp-and-rename`).
   - El ticket incluye: `approvalId`, `correlationId`, `requesterId`, SQL sanitizado, parámetros, perfil de riesgo, marca de tiempo y `expiresAt` (TTL de 15 minutos).
   - El servidor MCP responde de inmediato al cliente con el ticket y el resumen del riesgo en `< 500 ms`.
2. **Canal de Aprobación Humana Fuera de Banda (CLI de Operador)**:
   - Se provee el comando CLI `db-mcp approve <approvalId>` y `db-mcp reject <approvalId>`.
   - Este comando es totalmente externo y no está expuesto en la lista de tools MCP anunciada a los modelos de IA.
   - Al aprobarse, el comando ejecuta la consulta en la base de datos bajo las restricciones operativas habituales y persiste temporalmente el resultado en `ApprovedQueryResultStore` durante el TTL restante.
3. **Recuperación Pasiva de Resultados (`get_query_result`)**:
   - Se expone una herramienta MCP pasiva de solo lectura: `get_query_result({ approvalId: string })`.
   - La herramienta verifica el estado (`PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`).
   - Si está en `APPROVED`, retorna el conjunto de filas resultante de forma segura (con enmascaramiento y delimitadores zero-trust habituales).
   - La herramienta carece de cualquier parámetro o lógica para alterar el estado de aprobación.
4. **Purga Automática por TTL**:
   - Tanto los tickets pendientes como los resultados aprobados se descartan automáticamente tras 15 minutos, auditando la expiración como cancelación por vencimiento.
