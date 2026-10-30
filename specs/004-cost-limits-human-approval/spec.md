# Feature Specification: Control de Costo, Límites Operativos y Flujo de Aprobación Humana

**Feature Branch**: `004-cost-limits-human-approval`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "Control de costo, límites operativos y flujo de aprobación humana. 1) Análisis previo de plan de ejecución: antes de ejecutar una consulta válida, el servidor solicita al adaptador el perfil de riesgo mediante EXPLAIN (FORMAT JSON) en PostgreSQL o SHOWPLAN en SQL Server; según umbrales configurables por motor, bloquea automáticamente consultas con escaneos completos en tablas grandes (full table scans), joins sin condición (productos cartesianos) o filas estimadas excesivas. 2) Límites estrictos y cancelación real: aplica un tope configurable de filas devueltas, límite de consultas por minuto (rate limiting) y tiempo máximo de ejecución; si se alcanza el timeout, dispara la señal de aborto del adaptador para cancelar el proceso directamente dentro del motor de base de datos (request.cancel en SQL Server y pg_cancel_backend en PostgreSQL), no solo cerrando el socket del cliente. 3) Aprobación humana asíncrona sin bloqueo de cliente: cuando una consulta supera el umbral de precaución pero no el de bloqueo absoluto, el tool no congela la conexión esperando indefinidamente; registra la consulta en estado PENDING_APPROVAL con un identificador único y devuelve de inmediato el resumen del riesgo para que un humano autorice la ejecución de forma explícita, impidiendo por diseño que la IA invoque o apruebe su propia solicitud."

## Clarifications

### Session 2026-10-30
- Q: ¿Cómo debe autorizar el operador humano una consulta retenida y cómo obtiene el cliente MCP el resultado final una vez aprobada? → A: Aprobación mediante comando CLI de operador (`db-mcp approve <approvalId>`), guardando el resultado en un almacén temporal seguro para que el cliente MCP lo recupere con una herramienta pasiva de consulta de estado/resultado (`get_query_result(approvalId)`).
- Q: ¿Cuál debe ser el comportamiento exacto del servidor cuando una consulta en ejecución excede el tope configurado de filas devueltas (`maxRowsLimit`)? → A: Truncamiento seguro: el adaptador lee y retorna hasta el tope de `maxRowsLimit` filas, detiene la lectura adicional y marca en la respuesta la bandera `truncated: true` junto con una advertencia visible.
- Q: ¿Cómo debe persistirse el almacén de tickets pendientes (`PENDING_APPROVAL`) y los resultados aprobados durante su período de vigencia (TTL)? → A: Almacén en archivo local estructurado con rotación/purga automática por TTL, asegurando que los tickets y resultados aprobados sobrevivan a reinicios del proceso MCP sin requerir infraestructura externa.
- Q: ¿Cuál debe ser el ámbito de aplicación del control de tasa de consultas por minuto (`rateLimitPerMinute`)? → A: Esquema híbrido de dos niveles: cuota individual configurable por cliente/sesión MCP y límite de seguridad global para toda la instancia del servidor MCP hacia el motor.
- Q: ¿Cómo debe actuar el servidor si la solicitud previa de estimación del plan de ejecución (`EXPLAIN` / `SHOWPLAN`) falla o agota su propio tiempo de espera? → A: Precaución segura (*Fail-Safe*): clasifica automáticamente la consulta en estado `PENDING_APPROVAL` con advertencia de "Plan no verificable", requiriendo autorización explícita de un operador humano antes de proceder.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Análisis Preventivo del Plan de Ejecución y Bloqueo de Consultas Peligrosas (Priority: P1)

Como administrador de bases de datos y responsable de estabilidad de infraestructura, necesito que toda consulta validada sea analizada mediante una estimación de su plan de ejecución antes de tocar los datos reales, para bloquear de inmediato y sin impacto en producción aquellas operaciones patológicas que impliquen escaneos completos en tablas voluminosas, productos cartesianos (joins sin condición) o estimaciones desmedidas de registros procesados.

**Why this priority**: Es la primera línea de contención activa contra denegaciones de servicio (DoS) involuntarias causadas por consultas generadas por agentes de IA. Ejecutar a ciegas una consulta sintácticamente válida pero sin índices o con un join cartesiano puede saturar la CPU, agotar la memoria del motor y degradar todos los sistemas dependientes.

**Independent Test**: Puede probarse enviando consultas deliberadamente ineficientes (ej. `SELECT * FROM transacciones_grandes` sin predicado o `SELECT * FROM a, b` sin cláusula `ON`/`WHERE`) contra bases de datos de prueba con esquemas representativos, verificando que el servidor MCP obtenga el plan estimado, detecte la violación de los umbrales configurados y rechace la ejecución de forma inmediata devolviendo un diagnóstico descriptivo del riesgo y registrando el evento como `BLOCKED_BY_COST` en la auditoría sin haber ejecutado la consulta real.

**Acceptance Scenarios**:

1. **Given** una tabla catalogada como grande (que excede el umbral de registros o páginas configurado) y una consulta que realiza un escaneo secuencial completo (*full table scan* o *table scan*) sobre ella, **When** el servidor MCP solicita la estimación del plan de ejecución previo, **Then** el analizador de riesgo identifica el nodo de escaneo completo sobre la tabla protegida, bloquea la ejecución de la consulta, retorna un error estructurado indicando el tipo de riesgo detectado y emite una entrada de auditoría con estado `BLOCKED_BY_COST`.
2. **Given** una consulta que combina dos o más conjuntos de datos mediante un producto cartesiano (unión de tablas sin predicado de unión o con `CROSS JOIN` accidental), **When** se evalúa el plan de ejecución estimado, **Then** el sistema identifica la ausencia de condición de enlace o la presencia de un operador de unión cartesiana, bloquea la consulta antes de su ejecución y reporta la causa del bloqueo.
3. **Given** una consulta cuya estimación del optimizador del motor proyecta un número de filas o costo computacional que excede el umbral crítico de bloqueo configurable, **When** se evalúa el perfil de riesgo del plan, **Then** el servidor detiene el procesamiento, impide el envío de la consulta real a la base de datos y notifica al cliente que la consulta excede la capacidad operativa máxima permitida.
4. **Given** una consulta eficiente y acotada mediante índices que opera por debajo de los umbrales de riesgo, **When** se realiza la estimación del plan, **Then** el analizador valida que el perfil de riesgo es aceptable y permite que la consulta proceda a la fase de ejecución.

---

### User Story 2 - Aplicación de Límites Operativos Rigurosos y Cancelación Activa en el Motor (Priority: P1)

Como ingeniero de operaciones y disponibilidad, necesito que el servidor MCP imponga límites estrictos sobre la tasa de peticiones, el volumen de filas retornadas y el tiempo máximo de procesamiento por consulta, asegurando que cuando una operación exceda el tiempo límite se cancele de manera efectiva dentro del motor de base de datos y no solo cerrando la conexión cliente, para erradicar procesos huérfanos que consuman recursos en segundo plano.

**Why this priority**: Complementa el Principio II (Defensa en Profundidad) y las restricciones arquitectónicas de la Constitución. Los clientes que cierran sockets abruptamente dejan hilos y bloqueos ejecutándose en los motores de base de datos; garantizar la cancelación real (`request.cancel` en SQL Server y `pg_cancel_backend` en PostgreSQL) protege la salud integral del clúster de base de datos.

**Independent Test**: Puede probarse ejecutando consultas sintéticas de retardo o bloqueo prolongado que sobrepasen el timeout configurado, comprobando mediante telemetría y consultas administrativas en el motor (`sys.dm_exec_requests` en SQL Server y `pg_stat_activity` en PostgreSQL) que el identificador de sesión/proceso sea terminado de inmediato al vencer el temporizador, retornando al cliente un estado de cancelación oportuno y auditando el evento como `CANCELLED_BY_TIMEOUT`. Asimismo, probando ráfagas de consultas para verificar el corte por límite de tasa (*rate limit*) y consultas con grandes volúmenes para comprobar el corte al alcanzar el tope de filas.

**Acceptance Scenarios**:

1. **Given** un límite máximo de tiempo de ejecución de consulta configurado (ej. 5 segundos) y una consulta que excede dicho tiempo en el motor de base de datos, **When** el temporizador interno de control de tiempo expira, **Then** el servidor invoca inmediatamente la señal de cancelación específica del adaptador en el motor (abortando el proceso activo en la base de datos), confirma la detención real del comando, retorna un error de tiempo de espera agotado al cliente y registra la auditoría con estado `CANCELLED_BY_TIMEOUT`.
2. **Given** un límite máximo configurable de filas devueltas (ej. 1,000 filas) y una consulta que intenta retornar 50,000 registros, **When** el adaptador recibe los datos del motor, **Then** el flujo se detiene al alcanzar el tope establecido, retornando exactamente las primeras 1,000 filas y marcando de forma obligatoria la bandera `truncated: true` junto con una advertencia visible en los metadatos de respuesta, evitando desbordamientos de memoria sin abortar la consulta.
3. **Given** una cuota de consultas por minuto configurada en dos niveles (cuota por cliente/sesión individual y techo global para la instancia del servidor hacia el motor), **When** un cliente individual excede su cuota o múltiples clientes concurrentes saturan la cuota global del servidor en la ventana de tiempo activa, **Then** el servidor rechaza inmediatamente en memoria las solicitudes excedentes sin tocar la base de datos, especificando el nivel de límite alcanzado y el tiempo restante para el restablecimiento.
4. **Given** una consulta cancelada en el motor por tiempo de espera, **When** se examina el estado del motor de base de datos tras la señal de aborto, **Then** se constata que la sesión no permanece en estado de ejecución ni retiene bloqueos (*locks*) asociados al comando abortado.

---

### User Story 3 - Aprobación Humana Asíncrona sin Bloqueo de Cliente (Priority: P2)

Como oficial de gobierno de datos y operador de sistemas, necesito que aquellas consultas que superen un umbral de precaución (pero sin llegar al extremo de bloqueo destructivo) pasen a un estado de retención asíncrona `PENDING_APPROVAL`, retornando de inmediato un identificador único y un resumen del riesgo al cliente MCP sin mantener congelada la conexión, permitiendo que un humano autorice o rechace la solicitud a través de un canal administrativo seguro que la IA no pueda invocar ni auto-aprobar.

**Why this priority**: Da cumplimiento estricto al mandato constitucional sobre Aprobación Humana ("Las consultas marcadas como riesgosas... MUST esperar confirmación humana explícita; la IA tiene prohibido auto-aprobarse"). El modelo asíncrono previene bloqueos de transporte y timeouts en clientes MCP como Claude Desktop, IDEs o bots, al tiempo que establece una barrera infranqueable contra la auto-aprobación del agente.

**Independent Test**: Puede probarse sometiendo una consulta con costo intermedio (zona de precaución), comprobando que el tool MCP responda en menos de un segundo con el estado `PENDING_APPROVAL`, el identificador único de aprobación y el desglose de métricas de riesgo. Luego, intentando ejecutar dicha consulta o invocar cualquier comando de aprobación desde el contexto del tool del modelo de IA (verificando que sea rechazado o inexistente para la IA), y finalmente aprobándola mediante una interfaz de operador humano separada (ej. CLI o canal administrativo protegido) para que se ejecute y entregue los resultados al canal autorizado.

**Acceptance Scenarios**:

1. **Given** una consulta cuyo costo o impacto estimado supera el umbral de precaución pero no excede el umbral de bloqueo absoluto, **When** el servidor MCP procesa la solicitud, **Then** el sistema registra la consulta en un almacén temporal seguro con estado `PENDING_APPROVAL`, genera un identificador único de ticket (`approvalId`), registra la auditoría correspondiente y devuelve inmediatamente al cliente MCP una respuesta estructurada con dicho identificador y el desglose del riesgo sin bloquear la conexión de transporte.
2. **Given** una consulta en estado `PENDING_APPROVAL`, **When** un modelo de IA intenta autorizar o forzar la ejecución de la consulta a través de los tools estándar del servidor MCP, **Then** el sistema no ofrece ninguna herramienta accesible por IA para auto-aprobarse y rechaza cualquier intento de ejecución no autorizada, preservando el aislamiento de seguridad por diseño.
3. **Given** una consulta en estado `PENDING_APPROVAL` con un identificador válido, **When** un operador humano autenticado revisa el riesgo y autoriza explícitamente su ejecución ejecutando el comando CLI de operador `db-mcp approve <approvalId>`, **Then** el sistema ejecuta la consulta acotada bajo las restricciones operativas habituales, almacena de forma segura y temporal el conjunto de resultados asociado al ticket, actualiza el estado a `APPROVED` y genera una nueva entrada de auditoría con la referencia de la autorización humana y el estado final `EXECUTED`. Posteriormente, cuando el cliente MCP invoque la herramienta de lectura pasiva `get_query_result(approvalId)`, el sistema entrega el resultado de la consulta.
4. **Given** un ticket en estado `PENDING_APPROVAL` que no recibe confirmación humana dentro del período de vigencia configurado (*TTL* o tiempo de vida, ej. 15 minutos), **When** expira el tiempo límite, **Then** el sistema marca el ticket como expirado, descarta la consulta pendiente y audita la cancelación por vencimiento de aprobación.

---

### Edge Cases

- ¿Qué sucede si el optimizador de base de datos reporta un plan con estadísticas desactualizadas que subestiman o sobreestiman drásticamente el costo real?
  El sistema debe permitir configurar factores de seguridad y umbrales por motor; además, los límites en tiempo real (tope de tiempo de ejecución y tope de filas) actúan como salvaguarda inquebrantable en caso de que una consulta subestimada intente saturar la base de datos durante su ejecución real.
- ¿Qué ocurre si la llamada a la señal de aborto en el motor (`pg_cancel_backend` o `request.cancel`) falla o el motor no responde?
  Si la señal de cancelación interna no logra terminar el proceso tras un intervalo de gracia breve (ej. 2 segundos), el adaptador debe intentar la terminación forzada de la conexión asociada en el motor (`pg_terminate_backend` o cierre forzado de conexión física en el pool) para evitar que la hebra quede consumiendo CPU, registrando un evento de advertencia en auditoría.
- ¿Qué ocurre si un cliente envía ráfagas masivas que superan con creces el límite de tasa (*rate limit*)?
  El middleware de límite de tasa debe operar en memoria con costo despreciable ($O(1)$ por verificación de ventana deslizante o balde de fichas) y responder con código de saturación sin realizar ninguna operación de red ni acceder a la base de datos, evitando que el servidor MCP se degrade por el propio volumen de ráfaga.
- ¿Qué sucede si un solicitante reintenta inmediatamente enviar la misma consulta que acaba de quedar en `PENDING_APPROVAL`?
  El sistema debe detectar consultas idénticas en curso o pendientes de aprobación bajo el mismo contexto de solicitante y retornar el identificador del ticket existente en lugar de duplicar peticiones pendientes en el almacén de aprobaciones.
- ¿Qué ocurre si la solicitud previa de estimación del plan de ejecución (`EXPLAIN` / `SHOWPLAN`) falla, agota su tiempo de espera o genera un formato JSON/XML con nodos no reconocidos?
  El analizador de planes debe aplicar una política de precaución segura (*fail-safe*): si el plan no puede obtenerse (con un timeout predeterminado de 2 segundos para la estimación) o no puede interpretarse con certeza, el sistema clasifica de forma automática la consulta en estado `PENDING_APPROVAL` con el diagnóstico "Plan no verificable", impidiendo la ejecución ciega y requiriendo confirmación humana explícita.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Análisis Previo de Planes de Ejecución y Evaluación de Riesgos

- **FR-001**: El servidor MCP DEBE solicitar de forma obligatoria la estimación del plan de ejecución a través del adaptador correspondiente (`EXPLAIN (FORMAT JSON)` en PostgreSQL y comandos equivalentes de `SHOWPLAN` en SQL Server) para toda consulta `SELECT` válida antes de enviar la consulta para ejecución real.
- **FR-002**: El sistema DEBE proveer un analizador de planes de ejecución capaz de interpretar la estructura del plan generado por cada motor soportado y extraer métricas normalizadas de riesgo, incluyendo:
  - Presencia de escaneos secuenciales completos de tablas (*Seq Scan* o *Table Scan*).
  - Presencia de productos cartesianos o uniones de tablas sin condición de enlace (*Cartesian Join* o *Nested Loops* sin predicado de filtrado).
  - Cantidad total estimada de filas a procesar o devolver (*Estimated Rows*).
  - Costo computacional total estimado por el optimizador del motor (*Total Cost*).
- **FR-003**: El sistema DEBE permitir configurar de manera independiente por motor y por entorno:
  - Lista de tablas grandes o protegidas donde un escaneo completo está estrictamente prohibido.
  - Umbral numérico de filas estimadas por encima del cual la consulta es clasificada como riesgosa o bloqueada.
  - Umbral de costo computacional estimado del optimizador para bloqueo absoluto y para precaución.
  - Prohibición estricta y no negociable de productos cartesianos no intencionados.
- **FR-004**: Si el perfil de riesgo calculado para una consulta supera el umbral de bloqueo absoluto configurado, el sistema DEBE detener el flujo inmediatamente, impedir el envío de la consulta real al motor y emitir un resultado estructurado con estado `BLOCKED_BY_COST`, notificando la causa específica del bloqueo (ej. escaneo completo en tabla grande, producto cartesiano o estimación masiva de filas).
- **FR-005**: Si la solicitud previa de estimación del plan de ejecución (`EXPLAIN` / `SHOWPLAN`) falla, supera su temporizador límite dedicado (con valor predeterminado de 2 segundos) o su formato no puede ser interpretado con certeza, el sistema DEBE aplicar una política de precaución segura (*fail-safe*), absteniéndose de ejecutar la consulta y catalogándola automáticamente en estado `PENDING_APPROVAL` con la advertencia estructurada "Plan no verificable" para decisión humana obligatoria.

#### Límites Operativos Rigurosos y Cancelación Real en Motor

- **FR-006**: El sistema DEBE aplicar un límite máximo configurable de filas devueltas por consulta (`maxRowsLimit`). Si la consulta genera más registros de los permitidos, el adaptador DEBE detener la lectura al alcanzar dicho tope, retornar exactamente las primeras `maxRowsLimit` filas y marcar de forma obligatoria en la respuesta estructurada la bandera booleana `truncated: true` junto con un mensaje de advertencia informando al cliente/agente que el resultado ha sido acotado.
- **FR-007**: El sistema DEBE aplicar un mecanismo de límite de tasa (*rate limiting*) en dos niveles evaluado en memoria: una cuota individual configurable por cliente o identificador de sesión (`rateLimitPerClientPerMinute`, ej. 60 cpm) y un techo de seguridad global para toda la instancia del servidor MCP (`rateLimitGlobalPerMinute`, ej. 300 cpm). Cualquier solicitud que exceda cualquiera de los dos niveles DEBE ser rechazada de inmediato en $O(1)$ sin acceder a la base de datos, notificando qué nivel de cuota fue superado y el tiempo restante en segundos para el restablecimiento.
- **FR-008**: El sistema DEBE establecer un temporizador de tiempo máximo de ejecución de consulta (`executionTimeoutMs`) por cada operación enviada a la base de datos.
- **FR-009**: Al agotarse el temporizador de ejecución sin que la consulta haya finalizado, el sistema DEBE emitir de forma inmediata la señal de cancelación activa soportada por el adaptador en el motor de base de datos (`request.cancel` en SQL Server y `pg_cancel_backend` con el PID de la sesión en PostgreSQL), garantizando que la hebra o proceso sea interrumpido en el servidor de base de datos y no únicamente abandonando el socket local del cliente.
- **FR-010**: Si la consulta es cancelada por temporizador, el sistema DEBE asegurar la liberación de recursos en el pool de conexiones, confirmar la detención del comando y registrar el evento en el log de auditoría con estado `CANCELLED_BY_TIMEOUT` y tiempo de ejecución real transcurrido.

#### Flujo de Aprobación Humana Asíncrona sin Bloqueo de Cliente

- **FR-011**: Cuando una consulta supere el umbral de precaución pero no alcance el umbral de bloqueo absoluto, el servidor MCP DEBE suspender la ejecución inmediata y registrar la solicitud en un almacén persistente en archivo local estructurado (`PENDING_APPROVAL_STORE_PATH`, ej. `.db-mcp/pending_approvals.json`) en estado `PENDING_APPROVAL` con un identificador único de ticket (`approvalId`), asegurando su persistencia ante reinicios del proceso.
- **FR-012**: Al registrar una consulta en `PENDING_APPROVAL`, el tool MCP DEBE responder de forma inmediata al cliente MCP sin mantener la conexión bloqueada en espera, entregando un objeto estructurado que contenga:
  - Estado: `PENDING_APPROVAL`.
  - Identificador único del ticket (`approvalId`).
  - Resumen detallado del riesgo detectado (tipo de operación riesgosa, costo estimado, tablas involucradas y motivo de precaución).
  - Instrucciones explícitas para que un operador humano revise y decida sobre la autorización.
- **FR-013**: Las herramientas (*tools*) expuestas por el servidor MCP hacia el agente o modelo de IA NO DEBEN incluir ninguna función, parámetro o comando que permita a la IA aprobar, desestimar o forzar la ejecución de una consulta en estado `PENDING_APPROVAL`. La capacidad de auto-aprobación queda terminantemente excluida por diseño del contrato del servidor.
- **FR-014**: La autorización o rechazo de una consulta pendiente DEBE llevarse a cabo exclusivamente a través de un comando CLI dedicado para operadores humanos fuera de banda (`db-mcp approve <approvalId>` / `db-mcp reject <approvalId>`). Al aprobarse, el comando ejecuta la consulta y almacena de forma segura su resultado durante el tiempo de vida (TTL) del ticket.
- **FR-014b**: El servidor MCP DEBE exponer una herramienta de consulta pasiva de solo lectura (`get_query_result(approvalId)`) accesible para clientes y agentes MCP, la cual permite verificar el estado actual del ticket (`PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`) y retornar los datos resultantes una vez que la consulta haya sido aprobada por el operador humano, sin capacidad alguna de alterar el estado de aprobación.
- **FR-015**: Cada ticket en estado `PENDING_APPROVAL` DEBE poseer un tiempo de vida máximo configurable (*TTL*, ej. 15 minutos); el almacén local DEBE purgar o marcar automáticamente como expirados los tickets y resultados que sobrepasen dicho TTL, auditando la cancelación por vencimiento.
- **FR-016**: Toda transición de estado de una consulta (registro en `PENDING_APPROVAL`, autorización humana, rechazo humano o expiración por TTL) DEBE generar un registro independiente e inmutable en el sistema de auditoría, compartiendo el mismo identificador de correlación (`correlationId`).

---

### Key Entities

- **QueryPlanRiskProfile**: Estructura de datos generada tras evaluar la salida del plan de ejecución (`EXPLAIN` / `SHOWPLAN`). Contiene el nivel de severidad asignado (`LOW`, `MEDIUM_CAUTION`, `CRITICAL_BLOCK`), costo total numérico estimado, conteo de filas estimadas, lista de tablas sujetas a escaneos completos, presencia de productos cartesianos y desglose de advertencias técnicas.
- **EngineRiskThresholds**: Parámetros de configuración por motor que determinan los límites de decisión: lista de tablas grandes protegidas, límite de costo para precaución y para bloqueo, límite de filas estimadas para precaución y para bloqueo, y bandera de tolerancia cero a productos cartesianos.
- **OperationalLimitsPolicy**: Configuración de restricciones globales de ejecución que comprende: límite de consultas por minuto por cliente/sesión (`rateLimitPerClientPerMinute`), límite global de consultas por minuto de la instancia (`rateLimitGlobalPerMinute`), tiempo límite de ejecución en milisegundos (`executionTimeoutMs`) y límite superior de filas retornables (`maxRowsLimit`).
- **ActiveQueryExecutionHandle**: Objeto de control que asocia una consulta en curso en el motor con su temporizador de aborto, identificador de sesión interna o PID del motor, y la función de cancelación del adaptador (`request.cancel` o `pg_cancel_backend`).
- **PendingApprovalTicket**: Registro de una consulta que requiere confirmación humana. Contiene `approvalId`, `correlationId`, `requesterId`, sentencia SQL sanitizada y parámetros asociados, marca de tiempo de creación, marca de tiempo de expiración (TTL), resumen del perfil de riesgo y estado de resolución (`PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`).
- **ApprovedQueryResultStore**: Almacén temporal acotado por TTL donde se resguardan los resultados de una consulta aprobada y ejecutada mediante el comando del operador humano, permitiendo su lectura segura mediante `get_query_result(approvalId)` antes de su expiración.
- **HumanApprovalAction**: Evento emitido exclusivamente por el comando CLI del operador humano, conteniendo el identificador del ticket (`approvalId`), identidad del operador humano autorizador, decisión (`APPROVE` | `REJECT`), motivo de la decisión y marca de tiempo ISO 8601.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100% de las consultas sintéticamente diseñadas con productos cartesianos o escaneos completos sobre tablas grandes configuradas son detectadas y bloqueadas preventivamente antes de su ejecución real en la base de datos (0 consultas destructivas ejecutadas).
- **SC-002**: En el 100% de los casos donde una consulta excede el tiempo límite de ejecución configurado (`executionTimeoutMs`), el servidor MCP dispara exitosamente la señal de cancelación activa en el motor de base de datos (`pg_cancel_backend` o `request.cancel`), constatándose que el proceso no queda como hilo huérfano en el motor en más del 99% de los eventos medidos.
- **SC-003**: El tiempo de respuesta del servidor MCP al catalogar una consulta en estado `PENDING_APPROVAL` es inferior a 500 milisegundos, retornando de inmediato el ticket de aprobación y el resumen de riesgo al cliente sin retener ni agotar las conexiones de transporte del protocolo.
- **SC-004**: El 0% de los intentos realizados por un agente de IA para auto-aprobar una consulta retenida o invocar herramientas de aprobación tienen éxito (aislamiento total de privilegios por diseño entre herramientas del agente y canales de administración humana).
- **SC-005**: El sistema de límite de tasa (*rate limiting*) evalúa y rechaza solicitudes excedentes en menos de 1 milisegundo en memoria sin generar llamadas ni sobrecarga sobre las bases de datos de destino.
- **SC-006**: El 100% de los eventos de bloqueo por costo (`BLOCKED_BY_COST`), cancelación por timeout (`CANCELLED_BY_TIMEOUT`) y solicitudes retenidas (`PENDING_APPROVAL`) son persistidos en el log de auditoría con sus motivos estructurados e identificadores de correlación correspondientes.

---

## Assumptions

- **Soporte de Planes en Motores**: Se asume que las credenciales de solo lectura configuradas en el servidor MCP para PostgreSQL y SQL Server disponen de permisos suficientes para solicitar planes de ejecución estimados (`EXPLAIN` en PostgreSQL y permisos `SHOWPLAN` en SQL Server) sin requerir privilegios de modificación de esquemas ni datos.
- **Permisos de Cancelación en el Motor**: En PostgreSQL, se asume que el usuario de base de datos puede cancelar sus propias consultas mediante `pg_cancel_backend(pid)` (lo cual está permitido de forma nativa para procesos pertenecientes al mismo rol de conexión). En SQL Server, se asume que el driver nativo (`tedious`/`mssql`) provee y gestiona la invocación de `request.cancel()` sobre la conexión activa.
- **Canal de Aprobación Humana**: Se asume que la interfaz de aprobación humana operará mediante un comando CLI de operador independiente o una API administrativa interna protegida con credenciales operativas, completamente excluida de la lista de `tools` anunciada en el protocolo MCP a los agentes de IA.
- **Almacenamiento de Aprobaciones Pendientes**: Los tickets en estado `PENDING_APPROVAL` y los resultados temporales aprobados se mantendrán en un almacén en archivo estructurado local con escrituras atómicas y purga automática por TTL (15 minutos por defecto), garantizando resiliencia operativa ante reinicios del proceso servidor MCP.
- **Cálculo de Tasa Operativa**: El control de *rate limiting* se computa por ventana de tiempo deslizante en memoria asociada al identificador del solicitante o sesión MCP activa; en caso de reinicio del proceso MCP, los contadores de la ventana se reinician de manera limpia.
