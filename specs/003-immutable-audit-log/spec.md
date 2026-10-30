# Feature Specification: Sistema de Auditoría Estructurada e Inmutable

**Feature Branch**: `003-immutable-audit-log`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "Sistema de auditoría estructurada e inmutable. Cada consulta recibida por el MCP genera una entrada de registro en formato JSON estructurado que captura: identificador de correlación de la petición, identidad o sesión del solicitante, marca de tiempo ISO, motor y base de datos destino, sentencia SQL evaluada, estado final (ejecutada, rechazada por el guard, bloqueada por costo, pendiente de aprobación o cancelada por timeout), motivo detallado en caso de rechazo, tiempo de ejecución en milisegundos y cantidad de filas devueltas. Los valores de parámetros y los resultados nunca se escriben en crudo dentro del log para garantizar que jamás se filtren datos sensibles en los archivos de auditoría."

## Clarifications

### Session 2026-10-30
- Q: ¿Cómo debe configurarse y manejarse el destino de almacenamiento y la rotación del archivo de auditoría? → A: Ruta configurable (`AUDIT_LOG_PATH`) con rotación por fecha (`audit-YYYY-MM-DD.jsonl`) o tamaño (100MB), preservando el encadenamiento de hash entre archivos rotados.
- Q: ¿Cuál debe ser la estrategia para la sanitización de sentencias SQL evaluadas con literales incrustados? → A: Reemplazo estricto de todos los literales (cadenas entre comillas y literales numéricos) por marcadores (`?` o `[REDACTED]`), preservando exclusivamente la estructura sintáctica SQL.
- Q: ¿Cuál debe ser el algoritmo de hashing y la política de clave/semilla para la huella criptográfica encadenada de auditoría? → A: SHA-256 estándar (`SHA-256(previousHash + canonicalJson)`), simple, portable y verificable de forma determinista sin dependencias externas.
- Q: ¿Debe el servidor MCP ofrecer una herramienta o CLI de auditoría integrada para verificar la integridad del log? → A: Comando CLI dedicado (`audit-verify [archivo]`) que lee el log, verifica la secuencia continua y valida los hashes SHA-256 encadenados.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Registro Estructurado de Todo el Ciclo de Vida de Consultas (Priority: P1)

Como auditor de seguridad y cumplimiento normativo, necesito que cada petición de consulta recibida por el servidor MCP genere obligatoriamente una entrada de auditoría en formato JSON estructurado que capture todos los metadatos de trazabilidad y su estado final exacto (`ejecutada`, `rechazada por el guard`, `bloqueada por costo`, `pendiente de aprobación` o `cancelada por timeout`), para contar con visibilidad total y auditable de toda actividad e intento de acceso a las bases de datos.

**Why this priority**: Es el núcleo del Principio V de la Constitución ("Auditoría Estructurada Inmutable"). Sin un registro completo y estandarizado de tanto las consultas exitosas como las bloqueadas o canceladas, es imposible investigar incidentes de seguridad, demostrar cumplimiento o detectar patrones de abuso por parte de modelos de IA o usuarios.

**Independent Test**: Se puede probar de forma independiente procesando cinco solicitudes simuladas que representen cada uno de los cinco estados finales posibles (una consulta `SELECT` exitosa, una rechazada por el guardián AST, una bloqueada por exceder el umbral de costo, una retenida en espera de aprobación humana y una abortada por tiempo de espera agotado), verificando que se generen exactamente cinco entradas JSON válidas con todos los campos obligatorios completos y precisos.

**Acceptance Scenarios**:

1. **Given** una consulta `SELECT` válida enviada por un solicitante identificado hacia un motor y base de datos específicos, **When** la consulta se ejecuta satisfactoriamente devolviendo 42 filas en 18 milisegundos, **Then** el sistema genera una entrada de auditoría en formato JSON con el identificador de correlación único, identidad/sesión del solicitante, marca de tiempo en formato ISO 8601, motor y base de datos destino, sentencia SQL evaluada, estado final `EXECUTED` (ejecutada), motivo de rechazo nulo/vacío, tiempo de ejecución `18` ms y cantidad de filas devueltas `42`.
2. **Given** una consulta maliciosa o inválida (ej. con punto y coma encadenado o comentario de ofuscación), **When** el guardián de seguridad la intercepta y bloquea antes de tocar la base de datos, **Then** el sistema registra una entrada JSON con estado final `REJECTED_BY_GUARD` (rechazada por el guard), el motivo detallado de la infracción (ej. código de regla violada y descripción técnica del rechazo), cantidad de filas devueltas `0` y el tiempo transcurrido en la evaluación en milisegundos.
3. **Given** una consulta cuyo plan de ejecución estimado supera los límites permitidos de recursos, **When** el controlador de costos impide su ejecución, **Then** el sistema genera una entrada JSON con estado final `BLOCKED_BY_COST` (bloqueada por costo), detallando en el motivo de rechazo la métrica o umbral de costo excedido y registrando `0` filas devueltas.
4. **Given** una consulta catalogada como riesgosa que requiere confirmación humana explícita antes de ejecutarse, **When** la consulta queda retenida esperando autorización, **Then** el sistema genera una entrada JSON con estado final `PENDING_APPROVAL` (pendiente de aprobación), detallando la causa por la cual requiere revisión humana y vinculándola mediante el mismo identificador de correlación a su resolución posterior.
5. **Given** una consulta en ejecución que supera el tiempo límite máximo configurado, **When** el sistema cancela la consulta en el motor de base de datos, **Then** el sistema registra una entrada JSON con estado final `CANCELLED_BY_TIMEOUT` (cancelada por timeout), especificando el límite de tiempo superado en el motivo detallado, el tiempo total transcurrido en milisegundos y `0` filas devueltas.

---

### User Story 2 - Protección Estricta contra Filtración de Parámetros y Resultados en Logs (Priority: P1)

Como oficial de privacidad de datos, necesito que los valores de los parámetros de consulta y los datos de las filas devueltas jamás se escriban en crudo dentro de los registros de auditoría (ni siquiera cuando un solicitante intente incrustar literales sensibles directamente en el texto SQL), para garantizar que los archivos de auditoría no se conviertan en un vector de exfiltración de información personal (PII), secretos o datos financieros.

**Why this priority**: Cumple con la prohibición taxativa del Principio V ("Los registros de auditoría MUST NOT exponer datos sensibles ni valores crudos provenientes de las filas consultadas") y refuerza el Principio IV ("Privacidad en Memoria"). Un log de auditoría que almacena parámetros en crudo o resultados de consultas viola las normativas de protección de datos.

**Independent Test**: Se puede probar enviando consultas parametrizadas con datos sensibles (DPI, correos electrónicos, teléfonos, montos salariales) y consultas con literales incrustados en cláusulas `WHERE`, seguidas de la recepción de conjuntos de resultados con datos confidenciales, comprobando mediante inspección automatizada del archivo de auditoría que ningún valor de parámetro ni contenido de celda aparezca en las entradas generadas.

**Acceptance Scenarios**:

1. **Given** una consulta que recibe parámetros tipados con información sensible (ej. `@dpi = '2458912340101'`, `@correo = 'cliente@banco.gt'`, `@salarioMin = 15000`), **When** se genera el registro de auditoría de la petición, **Then** la entrada JSON incluye la estructura de la sentencia SQL con sus marcadores de posición (`@dpi`, `$1`, `?`) o el conteo/nombres de parámetros, pero omite o reemplaza por marcadores redactados (`[REDACTED_PARAM]`) el 100% de los valores reales de los parámetros.
2. **Given** una consulta ejecutada que devuelve filas con datos sensibles o confidenciales de la base de datos, **When** se escribe el evento de auditoría, **Then** el registro almacena exclusivamente la cantidad numérica de filas devueltas (`rowCount`) y jamás incluye nombres de columnas con valores, fragmentos de filas ni muestras del conjunto de resultados.
3. **Given** una consulta donde el solicitante incrustó valores literales directamente dentro del texto SQL evaluado (ej. `SELECT * FROM empleados WHERE dpi = '2458912340101' AND email = 'admin@empresa.com'`), **When** el registrador de auditoría prepara la sentencia SQL evaluada para el log, **Then** los literales de cadena y números sensibles dentro de la sentencia SQL son sanitizados o reemplazados por marcadores de posición (`?` / `'[REDACTED_LITERAL]'`) antes de escribirse en el archivo de auditoría.

---

### User Story 3 - Inmutabilidad y Garantía de Integridad de los Registros de Auditoría (Priority: P2)

Como responsable de seguridad de la información, necesito que las entradas de auditoría sean inmutables desde su creación en memoria y se almacenen en modo exclusivamente de adición (*append-only*) con verificación de integridad, asegurando que ninguna consulta se procese sin dejar rastro y que cualquier alteración, truncamiento o eliminación de registros previos sea detectable.

**Why this priority**: Garantiza el carácter "Inmutable" exigido por el Principio V de la Constitución. Si un proceso defectuoso o un atacante pudiera sobrescribir, editar o suprimir entradas de auditoría previas, o ejecutar consultas cuando el registro de auditoría está inoperativo, el sistema perdería su valor probatorio y forense.

**Independent Test**: Se puede probar verificando que las entradas generadas en memoria no puedan ser mutadas tras su emisión, que el archivo de auditoría solo admita adición de nuevas líneas JSON con encadenamiento de integridad verificable, y que ante un fallo de escritura en el destino de auditoría el sistema aplique una política de fallo seguro (*fail-closed*).

**Acceptance Scenarios**:

1. **Given** un evento de auditoría construido tras evaluar o ejecutar una consulta, **When** el registro es emitido por el componente de auditoría, **Then** el objeto de auditoría es sellado de forma inmutable en memoria (impidiendo modificaciones posteriores a cualquiera de sus propiedades) y se escribe como una línea JSON completa e independiente en flujo de solo adición (*append-only*).
2. **Given** una secuencia de múltiples entradas de auditoría registradas a lo largo de la sesión del servidor, **When** un auditor verifica la integridad del archivo de registro, **Then** cada entrada conserva un orden secuencial verificable y metadatos de integridad (como huella criptográfica encadenada con el registro anterior) que permiten detectar si una línea fue modificada, eliminada o insertada fuera de secuencia.
3. **Given** una condición de error en el almacenamiento donde el sistema de auditoría no puede persistir el registro (ej. permisos denegados en el archivo de destino o disco lleno), **When** el servidor MCP intenta procesar una consulta, **Then** el sistema opera en modo seguro (*fail-closed*), abortando o rechazando la entrega de resultados de la consulta si su auditoría obligatoria no puede garantizarse.

---

### Edge Cases

- ¿Qué sucede si la consulta enviada es tan malformada o masiva que ni siquiera puede parsearse como SQL válido?
  El sistema debe generar igualmente la entrada de auditoría con estado `REJECTED_BY_GUARD`, el motivo detallado del fallo sintáctico, `0` filas devueltas, y una versión truncada y sanitizada de la sentencia evaluada (aplicando un límite máximo de longitud segura y redactando cualquier patrón sensible o literal) para evitar ataques de agotamiento de disco mediante logs gigantes.
- ¿Qué ocurre cuando una consulta pasa inicialmente al estado `PENDING_APPROVAL` y posteriormente es aprobada o rechazada?
  El carácter inmutable del log prohíbe editar la línea original `PENDING_APPROVAL`; en su lugar, el sistema debe escribir una nueva entrada de auditoría independiente vinculada mediante el mismo identificador de correlación de la petición (`correlationId`), reflejando la transición al estado final definitivo (`EXECUTED`, `REJECTED_BY_GUARD` o `CANCELLED_BY_TIMEOUT`).
- ¿Qué sucede si la identidad o sesión del solicitante no viene informada explícitamente en los metadatos del cliente MCP?
  El sistema debe asignar un identificador de sesión anónima o de transporte determinístico (ej. identificador de sesión de conexión local/stdio con marcador explícito `anonymous-session:<id>`) para que el campo de identidad del solicitante nunca quede vacío ni nulo.
- ¿Qué sucede si dos o más consultas concurrentes finalizan en el mismo milisegundo?
  El sistema de escritura de auditoría debe serializar las operaciones de adición de forma atómica por línea para evitar que dos entradas JSON se entremezclen o corrompan el formato estructurado del archivo.
- ¿Qué ocurre si el motor de base de datos falla por un error inesperado de red o desconexión abrupta a mitad de una consulta válida?
  El registro debe capturarse obligatoriamente sin dejar la petición huérfana, registrando el tiempo transcurrido hasta el fallo, `0` filas devueltas y el detalle del error operacional sanitizado (sin exponer cadenas de conexión ni credenciales).

## Requirements *(mandatory)*

### Functional Requirements

#### Estructura y Campos Obligatorios del Registro de Auditoría

- **FR-001**: El sistema DEBE generar al menos una entrada de registro de auditoría en formato JSON estructurado por cada petición de consulta recibida por el servidor MCP, sin excepción.
- **FR-002**: Cada entrada de auditoría DEBE incluir obligatoriamente los siguientes campos estructurados:
  - Identificador único de correlación de la petición (`correlationId`).
  - Identidad o identificador de sesión del solicitante (`requesterId`).
  - Marca de tiempo exacta del evento en formato estándar ISO 8601 en UTC (`timestamp`).
  - Motor de base de datos destino (`engine`, ej. `mssql`, `postgres`) y nombre o identificador de la base de datos destino (`database`).
  - Sentencia SQL evaluada sanitizada (`evaluatedSql`).
  - Estado final estandarizado de la consulta (`status`).
  - Motivo detallado del rechazo, bloqueo o cancelación cuando no se haya ejecutado con éxito (`rejectionReason`).
  - Tiempo de ejecución o evaluación expresado en milisegundos enteros o decimales no negativos (`executionTimeMs`).
  - Cantidad exacta de filas devueltas al finalizar la operación (`rowCount`, siendo `0` para cualquier consulta no ejecutada o fallida).
- **FR-003**: El sistema DEBE restringir el estado final (`status`) a un conjunto cerrado y bien definido que cubra explícitamente:
  - Ejecutada (`EXECUTED`).
  - Rechazada por el guardián de seguridad (`REJECTED_BY_GUARD`).
  - Bloqueada por límite de costo (`BLOCKED_BY_COST`).
  - Pendiente de aprobación humana (`PENDING_APPROVAL`).
  - Cancelada por tiempo de espera agotado (`CANCELLED_BY_TIMEOUT`).
- **FR-004**: Cuando el estado final sea distinto de `EXECUTED`, el campo de motivo detallado (`rejectionReason`) DEBE poblarse obligatoriamente con el código categorizado y la descripción precisa de la causa (ej. regla AST infringida, métrica de costo superada, política que exige aprobación o umbral de timeout alcanzado).

#### Privacidad y Redacción de Parámetros y Resultados en Auditoría

- **FR-005**: El sistema NUNCA DEBE escribir en el registro de auditoría los valores en crudo de los parámetros asociados a la consulta.
- **FR-006**: El sistema NUNCA DEBE escribir en el registro de auditoría el contenido, celdas, valores enmascarados ni muestras de las filas devueltas por la base de datos, limitándose exclusivamente al conteo numérico de filas (`rowCount`).
- **FR-007**: Antes de registrar la sentencia SQL evaluada (`evaluatedSql`), el sistema DEBE sanitizar de forma estricta todos los valores literales (cadenas de texto entre comillas simples o dobles y constantes numéricas en predicados y cláusulas), reemplazándolos de manera uniforme por marcadores anónimos (`?` o `[REDACTED]`), preservando exclusivamente la estructura sintáctica de la consulta (nombres de tablas, columnas, palabras clave, funciones y operadores) para fines de trazabilidad sin filtración de datos.
- **FR-008**: Los motivos de rechazo y metadatos registrados en la auditoría DEBEN estar libres de credenciales, contraseñas, cadenas de conexión y datos sensibles provenientes de la base de datos.

#### Inmutabilidad, Integridad y Persistencia

- **FR-009**: Toda entrada de auditoría DEBE construirse como una estructura inmutable en memoria (congelada contra modificaciones posteriores) antes de ser enviada al canal de persistencia.
- **FR-010**: El almacenamiento de registros de auditoría DEBE operar estrictamente en modo de solo adición (*append-only*) utilizando formato de líneas JSON (JSON Lines / NDJSON, un objeto JSON válido por línea) en una ruta configurable (`AUDIT_LOG_PATH`), careciendo de cualquier método o interfaz en el sistema que permita editar, sobrescribir o eliminar entradas registradas previamente.
- **FR-015**: El sistema DEBE soportar rotación de archivos de auditoría basada en calendario diario (`audit-YYYY-MM-DD.jsonl`) y por umbral de tamaño configurable (con valor predeterminado de 100 MB), garantizando que al rotar un archivo el primer registro del nuevo archivo preserve como `previousHash` la huella de integridad del último registro del archivo predecesor para mantener la cadena de verificación continua.
- **FR-011**: Cada entrada de auditoría DEBE incluir un número de secuencia monotónico y una huella de integridad encadenada calculada mediante SHA-256 (`SHA-256(previousHash + canonicalJson)`), donde `canonicalJson` representa la serialización determinista con claves ordenadas alfabéticamente de los campos del registro excluyendo la huella misma, permitiendo verificar de forma independiente que el archivo no ha sido alterado, truncado ni reordenado. Para el primer registro del sistema o génesis, `previousHash` DEBE inicializarse con una constante determinista (ej. 64 ceros hexadecimales).
- **FR-012**: Cuando una consulta pase por estados intermedios (como `PENDING_APPROVAL`) antes de alcanzar un desenlace definitivo (`EXECUTED`, `REJECTED_BY_GUARD` o `CANCELLED_BY_TIMEOUT`), el sistema DEBE preservar el registro inicial intacto y añadir un nuevo registro subsecuente compartido bajo el mismo identificador de correlación (`correlationId`).
- **FR-013**: El sistema DEBE garantizar escrituras concurrentes seguras en orden secuencial, impidiendo que peticiones simultáneas trunquen o mezclen bytes de distintas líneas JSON en el destino de auditoría.
- **FR-014**: El sistema DEBE aplicar una política de fallo cerrado (*fail-closed*): si el subsistema de auditoría no puede inicializar su destino de escritura o falla al registrar una consulta, el servidor MCP NO DEBE entregar resultados de consulta no auditados al cliente.
- **FR-016**: El sistema DEBE incluir un comando CLI dedicado de verificación de integridad (`audit-verify [archivo]`) ejecutable de manera independiente, capaz de leer secuencialmente el archivo de auditoría, validar la numeración secuencial continua, recalcular los hashes SHA-256 encadenados y reportar un diagnóstico claro con código de salida 0 si la cadena está intacta o un código de error indicando el número exacto de línea y campo alterado ante cualquier inconsistencia.

### Key Entities

- **AuditLogEntry**: Registro individual e inmutable que representa un evento de evaluación o ejecución de consulta. Contiene `sequenceNumber`, `correlationId`, `requesterId`, `timestamp` (ISO 8601), `engine`, `database`, `evaluatedSql` (sanitizado sin literales sensibles), `status` (`EXECUTED` | `REJECTED_BY_GUARD` | `BLOCKED_BY_COST` | `PENDING_APPROVAL` | `CANCELLED_BY_TIMEOUT`), `rejectionReason` (opcional/nulo si fue ejecutada, obligatorio en caso contrario), `executionTimeMs`, `rowCount`, `previousHash` y `entryHash`.
- **AuditQueryOutcome**: Enumeración cerrada de los estados finales posibles de una petición de consulta dentro del flujo del servidor MCP (`EXECUTED`, `REJECTED_BY_GUARD`, `BLOCKED_BY_COST`, `PENDING_APPROVAL`, `CANCELLED_BY_TIMEOUT`).
- **RequesterContext**: Información de trazabilidad sobre el origen de la petición, incluyendo el identificador de correlación único de la solicitud y la identidad del solicitante o identificador de la sesión activa del cliente MCP.
- **SqlSanitizerForAudit**: Componente responsable de transformar el texto de una consulta SQL en una representación segura para auditoría, conservando la estructura de la sentencia (verbos, tablas, columnas, funciones) pero purgando cualquier literal de texto o número potencialmente sensible y asegurando que ningún valor de parámetro sea interpolado.
- **IntegrityChainVerifier**: Utilidad de validación capaz de recorrer una secuencia de entradas `AuditLogEntry` y comprobar que la numeración secuencial sea continua y que cada huella de integridad coincida con el contenido del registro y el eslabón anterior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100% de las peticiones de consulta recibidas por el servidor MCP (tanto exitosas como rechazadas, bloqueadas, pendientes o canceladas) generan su correspondiente entrada de auditoría en formato JSON válido con todos los campos obligatorios presentes (0% de consultas sin registro).
- **SC-002**: El 0% de las entradas de auditoría contienen valores crudos de parámetros de consulta, celdas de resultados o literales sensibles incrustados en el texto SQL al someter el sistema a una batería de pruebas con datos personales (DPI, correos, teléfonos y montos).
- **SC-003**: El 100% de las entradas escritas en el archivo de auditoría pueden ser parseadas individualmente como objetos JSON válidos y superan la verificación de integridad secuencial, detectando el 100% de los intentos simulados de modificación de campos, eliminación de líneas o reordenamiento de registros.
- **SC-004**: La sobrecarga introducida por la sanitización del SQL, el cálculo de integridad y la generación del registro de auditoría es inferior a 5 milisegundos por petición en el percentil 95, sin degradar perceptiblemente el tiempo de respuesta de las consultas.
- **SC-005**: Ante el 100% de los fallos simulados de escritura en el medio de auditoría, el sistema impide que una consulta se complete sin auditoría (*fail-closed*) y notifica el error crítico de infraestructura sin filtrar información sensible.

## Assumptions

- **Integración con el Ecosistema Existente**: El sistema de auditoría recibe los metadatos del motor y base de datos desde la capa de adaptadores (`001-adapters-adversarial-suite`) y los códigos/motivos de rechazo de seguridad desde el guardián sintáctico (`002-mcp-security-guard`), dejando preparados los estados `BLOCKED_BY_COST`, `PENDING_APPROVAL` y `CANCELLED_BY_TIMEOUT` para enlazar de forma transparente con el módulo de control de costos y riesgos (fase 004 de la secuencia constitucional).
- **Formato de Persistencia Estándar**: Las entradas JSON se persisten en formato JSON Lines (NDJSON, una entrada JSON compacta por línea terminada en salto de línea) dentro de archivos de registro dedicados de solo adición o flujos estructurados equivalentes configurados por el administrador.
- **Identidad del Solicitante en MCP**: Dado que el protocolo MCP puede operar sobre transporte estándar (stdio) o sesiones autenticadas, cuando el cliente MCP provea un identificador de usuario/sesión en el contexto o metadatos de la solicitud se registrará dicho valor; si el transporte no provee identidad de usuario explícita, se registrará un identificador único de sesión del proceso/conexión MCP activa.
- **Límite de Tamaño de SQL Evaluado**: Para proteger el almacenamiento de auditoría frente a entradas maliciosas extremadamente largas, el campo `evaluatedSql` registrará la sentencia sanitizada hasta un tope razonable (ej. 16 KB), anexando un indicador explícito `[TRUNCATED]` si la entrada original superaba dicho tamaño.
