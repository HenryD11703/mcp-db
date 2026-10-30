# Feature Specification: Orquestador de Consulta Federada Segura entre Servidores Heterogéneos

**Feature Branch**: `006-secure-federated-query`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "Orquestador de consulta federada segura entre servidores distintos sin linked servers. Permite ejecutar una consulta inicial en una base de datos origen (BD A), extraer un conjunto de claves del resultado en memoria y utilizarlas como filtro para ejecutar una segunda consulta en una base de datos destino (BD B, que puede ser del mismo o de distinto motor, como cruzar PostgreSQL con SQL Server). Reglas estrictas del flujo: 1) Ambas consultas pasan de forma independiente por el Guard AST, el analizador de costo y su propio usuario de solo lectura. 2) Las claves extraídas de la BD A se tratan como datos no confiables y se inyectan exclusivamente como parámetros tipados en la consulta de la BD B, nunca concatenadas en el texto SQL (previniendo inyección SQL de segundo orden). 3) Existe un tope estricto y configurable de claves por defecto fijado en 500 (respetando holgadamente el límite de 2100 parámetros de SQL Server). 4) El cruce de claves de la BD A hacia la BD B ocurre en memoria con los valores reales dentro del proceso del MCP antes del enmascarado; una vez unidos los resultados de ambos sistemas, el conjunto final pasa por el enmascarador aplicando pseudonimización determinista por sesión (hash) en las columnas sensibles de cruce, permitiendo a la IA correlacionar qué registros de la BD A coinciden con los de la BD B sin que el dato real salga jamás del servidor MCP. 5) Cada paso genera su propio registro de auditoría vinculado por un mismo ID de operación federada."

## Clarifications

### Session 2026-10-30
- Q: ¿El orquestador federado debe soportar exclusivamente claves de cruce de columna única o también combinaciones de claves compuestas (múltiples columnas)? → A: Exclusivamente columna única por cada base de datos (clave simple).
- Q: ¿Cómo debe responder el orquestador federado si la base de datos origen (BD A) devuelve más claves que el tope configurado (por ejemplo, 800 claves cuando el límite es 500)? → A: Truncar por defecto al tope con advertencia explícita en metadatos y auditoría, admitiendo parámetro opcional para forzar error si se prefiere.
- Q: ¿Cómo debe indicar el llamante en la consulta de BD B el lugar exacto donde se aplicarán las claves parametrizadas provenientes de BD A? → A: Marcador explícito en la plantilla SQL (ej. `WHERE col_destino IN (:keys)`), sustituido por parámetros tipados antes del Guard AST.
- Q: ¿Cómo deben resolverse las colisiones de nombres de columna cuando tanto la consulta de BD A como la de BD B proyectan campos con el mismo nombre (por ejemplo, `fecha`, `estado` o `id`)? → A: Respetar alias SQL definidos; ante colisiones no resueltas, prefijar automáticamente columnas de BD B con `target_<columna>`.
- Q: ¿Qué convención de formato visual debe aplicarse a los valores pseudonimizados de las columnas sensibles de cruce en la respuesta final? → A: Prefijo explícito `pseudo_` seguido de 16 caracteres hexadecimales (ej. `pseudo_a1b2c3d4e5f60718`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consulta Federada Cruzada Segura entre Motores Heterogéneos (Priority: P1)

Como analista de datos o asistente de inteligencia artificial, necesito ejecutar una consulta combinada entre dos servidores de bases de datos independientes y potencialmente heterogéneos (por ejemplo, cruzar datos de PostgreSQL con SQL Server) sin depender de enlaces de base de datos (*linked servers* ni `OPENQUERY`), extrayendo en memoria las claves del resultado de la base de datos origen (BD A) y utilizándolas como filtro parametrizado en la base de datos destino (BD B), para obtener una vista analítica integrada sin comprometer la seguridad ni la autonomía de los entornos.

**Why this priority**: Es la funcionalidad central y el valor esencial del requerimiento. En arquitecturas modernas y sistemas legados empresariales, los datos operativos y analíticos suelen residir en distintos motores de bases de datos. Los mecanismos tradicionales de enlace de servidores (*linked servers*, dblink) generan brechas graves de seguridad, dependencia de infraestructura compleja y riesgos de escalamiento de privilegios. Realizar la orquestación segura desde el proceso MCP desacopla los servidores y garantiza control total.

**Independent Test**: Puede probarse de manera aislada configurando dos motores de bases de datos (un PostgreSQL como BD A y un SQL Server como BD B), ejecutando una consulta federada que solicite una lista de identificadores en BD A (por ejemplo, clientes activos de una región) y busque sus transacciones o contratos en BD B. Se comprueba que ambas consultas se ejecutan mediante sus adaptadores correspondientes, que las claves de BD A se inyectan como parámetros en BD B, y que el servidor devuelve el conjunto consolidado de datos en memoria.

**Acceptance Scenarios**:

1. **Given** dos servidores de bases de datos independientes registrados en el servidor MCP (BD A de tipo PostgreSQL y BD B de tipo SQL Server), **When** se solicita una consulta federada con una consulta de lectura para BD A y una consulta parametrizada para BD B, **Then** el orquestador ejecuta la consulta en BD A, extrae las claves resultantes en memoria, ejecuta la consulta en BD B utilizando dichas claves como filtro y retorna los resultados consolidados.
2. **Given** una consulta inicial en BD A que genera un conjunto de identificadores (numéricos, alfanuméricos o UUID), **When** se prepara la ejecución en BD B, **Then** las claves se inyectan estrictamente como parámetros tipados independientes en el dialecto nativo del motor destino (`$1, $2, ...` en PostgreSQL o `@p1, @p2, ...` en SQL Server) sin realizar ninguna concatenación de cadenas en el cuerpo de la sentencia SQL.
3. **Given** dos tablas en distintos motores con claves de cruce compatibles, **When** se unen los datos resultantes dentro del proceso del servidor MCP, **Then** el orquestador aplica la operación de cruce en memoria (soportando cruces por defecto de tipo `LEFT` o alternativamente `INNER`) preservando la integridad de las columnas proyectadas por cada consulta.
4. **Given** una solicitud federada dirigida a dos bases de datos del mismo motor (por ejemplo, dos instancias distintas de PostgreSQL o dos servidores independientes de SQL Server), **When** se ejecuta el orquestador, **Then** el flujo se completa con la misma rigurosidad, aislamiento de sesiones y garantías de seguridad que en escenarios con motores distintos.

---

### User Story 2 - Defensas Independientes de Solo Lectura, Guard AST y Control de Costo (Priority: P1)

Como oficial de seguridad y administrador de bases de datos, necesito que cada una de las consultas involucradas en el flujo federado (tanto la consulta de BD A como la de BD B) sea evaluada de forma independiente por el Guard AST, el analizador de costo de plan de ejecución y ejecutada bajo su propio usuario de solo lectura verificado, para garantizar que ninguna rama de la federación intente operaciones de escritura, ejecute sentencias maliciosas ni sature los recursos de los servidores de datos.

**Why this priority**: La federación entre servidores no debe permitir que una consulta maliciosa o excesivamente costosa se cuele aprovechando el flujo orquestado. Cada base de datos posee su propio contexto de seguridad, catálogo y límites de capacidad. Mantener la verificación de AST, límites de costo y usuarios de solo lectura en cada paso de forma independiente es un mandato inquebrantable de la Constitución (Principios I y II: Solo Lectura y Defensa en Profundidad).

**Independent Test**: Puede probarse enviando una solicitud federada donde la consulta de BD A sea válida pero la consulta de BD B contenga sentencias no permitidas (por ejemplo, comandos de modificación de datos, comentarios inline/bloque, o CTEs con mutación) o exceda los umbrales de costo computacional; se verifica que el orquestador rechaza de inmediato la consulta infractora antes de su ejecución en BD B y suspende la operación informando la causa precisa del rechazo.

**Acceptance Scenarios**:

1. **Given** una consulta legítima en BD A y una consulta en BD B que incluye intentos de mutación (ej. `UPDATE`, `DELETE`, `SELECT INTO`, llamadas a procedimientos almacenados) o comentarios inline (`--`) o de bloque (`/* */`), **When** el Guard AST procesa la consulta de BD B, **Then** la consulta es rechazada categóricamente sin llegar a tocar el motor de BD B, abortando la federación con un error de seguridad explícito.
2. **Given** una consulta en BD B cuya estimación de costo de plan de ejecución excede los umbrales máximos tolerados sin confirmación humana, **When** el analizador de costo evalúa la consulta destino parametrizada, **Then** la operación federada se detiene antes de ejecutarse en el motor y solicita autorización humana explícita según las políticas de riesgo configuradas.
3. **Given** credenciales de conexión independientes para BD A y BD B, **When** el servidor inicializa y procesa las conexiones federadas, **Then** cada motor es validado mediante comprobación previa (*preflight check*) garantizando que el usuario configurado posea exclusivamente privilegios de solo lectura, rechazando la ejecución si se detectan permisos de escritura en cualquiera de los dos servidores.

---

### User Story 3 - Mitigación contra Inyección SQL de Segundo Orden y Tope Estricto de Parámetros (Priority: P1)

Como arquitecto de seguridad informática, necesito que los valores extraídos de la BD A sean tratados como datos hostiles y no confiables, asegurando que se inyecten exclusivamente como parámetros tipados en la BD B y respetando un límite superior infranqueable de claves (fijado por defecto en 500), para prevenir inyecciones SQL de segundo orden y evitar desbordar los límites del motor destino (en particular el límite de 2100 parámetros de SQL Server).

**Why this priority**: En una consulta federada, los datos devueltos por un servidor externo pueden contener caracteres especiales o fragmentos de código malicioso inyectados previamente en la BD A (ataque de segundo orden). Si estos valores fueran interpolados directamente en el texto SQL de la BD B, vulnerarían la seguridad del motor secundario. Adicionalmente, inyectar listas desmedidas de parámetros puede degradar el rendimiento o generar fallas por límites del motor (`max_parameters` = 2100 en SQL Server).

**Independent Test**: Puede probarse sembrando registros en BD A que contengan cadenas de inyección SQL (ej. `' OR '1'='1`, `'; DROP TABLE...`, comillas dobles, comillas simples y caracteres nulos) como claves de cruce; se verifica que al ejecutar la consulta en BD B, los valores viajan estrictamente como valores de parámetros tipados en el protocolo de red y son evaluados como literales por el motor, sin alterar la estructura del comando SQL. Asimismo, se prueba con una consulta de BD A que devuelva más de 500 filas, verificando que se aplique el tope estricto de 500 parámetros sin desbordamiento.

**Acceptance Scenarios**:

1. **Given** un resultado en BD A que contiene valores maliciosos con comillas, caracteres de escape o sintaxis SQL en las columnas de clave, **When** el orquestador extrae las claves y prepara la consulta para BD B, **Then** los valores son tratados como datos no confiables y vinculados exclusivamente como parámetros tipados, garantizando que el motor secundario los interprete estrictamente como datos literales.
2. **Given** una consulta en BD A que devuelve 1,500 registros de claves, **When** se evalúa el conjunto de claves para BD B bajo la configuración predeterminada de tope (500 claves), **Then** el orquestador trunca el conjunto de claves a los primeros 500 elementos únicos no nulos, emite una advertencia formal de truncamiento en los metadatos de la respuesta y en la auditoría, y ejecuta la consulta en BD B sin sobrepasar el límite seguro de parámetros.
3. **Given** un parámetro de configuración que ajusta el tope de claves a un valor específico inferior (por ejemplo, 100 claves), **When** se procesa la consulta federada, **Then** el orquestador respeta rigurosamente el tope personalizado configurado.
4. **Given** un resultado de BD A que arroja claves duplicadas o valores nulos, **When** el orquestador procesa las claves en memoria antes de la inyección, **Then** elimina los valores duplicados y descarta los nulos, optimizando el uso de parámetros en la consulta de BD B.

---

### User Story 4 - Privacidad en Memoria y Pseudonimización Determinista por Sesión (Priority: P2)

Como oficial de privacidad de datos (DPO) o auditor de cumplimiento, requiero que el cruce de datos entre BD A y BD B ocurra en memoria con los valores reales exclusivamente dentro del proceso del MCP, y que el conjunto final entregado al cliente/IA aplique una pseudonimización determinista por sesión (hash criptográfico con clave efímera de sesión) sobre las columnas sensibles de cruce, para que el modelo pueda correlacionar qué registros coinciden entre ambos sistemas sin que el dato crudo sensible abandone jamás el servidor MCP.

**Why this priority**: Cumple con el Principio IV de la Constitución (Privacidad en Memoria). Las claves de cruce suelen ser identificadores personales de negocio (números de documento de identidad como DPI, números de pasaporte, correos electrónicos, números de teléfono o identificadores de cuenta bancaria). La IA necesita entender qué registro de BD A corresponde a qué registro de BD B, pero no necesita conocer el valor real desanonimizado. La pseudonimización determinista por sesión ofrece correlación analítica sin fuga de datos.

**Independent Test**: Puede probarse ejecutando una consulta federada donde la clave de cruce es un identificador sensible (ej. DPI o correo electrónico). Se verifica que en la memoria interna del servidor MCP el join se efectúe exitosamente con los valores reales, pero en la salida serializada entregada al cliente MCP o modelo de IA los valores reales de dichas columnas son reemplazados por un hash determinista consistente (mismo hash para registros coincidentes de BD A y BD B), y que en una sesión posterior con una nueva clave efímera los hashes generados sean completamente diferentes para los mismos datos.

**Acceptance Scenarios**:

1. **Given** dos registros (uno en BD A y otro en BD B) que comparten la misma clave de cruce real (ej. número de identificación personal `1234567890`), **When** se realiza el cruce y se aplica la fase de enmascaramiento final, **Then** la respuesta entregada al cliente MCP muestra un identificador pseudonimizado idéntico para ambos registros (ej. `hash_a9f1b...`), permitiendo a la IA correlacionar la relación sin exponer el número real.
2. **Given** la terminación de una sesión MCP y el inicio de una nueva sesión con un nuevo salt efímero, **When** se realiza la misma consulta federada sobre los mismos datos de prueba, **Then** el identificador pseudonimizado es diferente al de la sesión anterior, impidiendo la trazabilidad histórica de datos sensibles o la construcción de tablas de diccionario fuera de la sesión activa.
3. **Given** columnas adicionales marcadas como sensibles en BD A o BD B (ej. saldos monetarios, teléfonos, nombres), **When** se unifican los datos resultantes, **Then** el enmascarador aplica sus reglas de enmascaramiento estándar a dichas columnas además de la pseudonimización en las claves de cruce antes de emitir la respuesta.

---

### User Story 5 - Trazabilidad y Auditoría Estructurada Inmutable Vinculada (Priority: P2)

Como auditor de seguridad y cumplimiento normativo, necesito que cada una de las fases del flujo federado (inicio de orquestación, validación y ejecución en BD A, extracción de claves, validación y ejecución en BD B, cruce en memoria y enmascarado final) genere su propio registro estructurado de auditoría inmutable, todos vinculados por un identificador unificado de operación federada (`federation_id`), para garantizar una trazabilidad forense integral sin exponer valores reales sensibles en los registros.

**Why this priority**: Cumple con el Principio V de la Constitución (Auditoría Estructurada Inmutable). Una consulta federada abarca múltiples operaciones independientes en servidores distintos. Si ocurriese un incidente de seguridad, una degradación de rendimiento o un rechazo por políticas de seguridad, es indispensable contar con una cadena de custodia forense correlacionada por un único identificador que permita reconstruir exactamente qué sucedió en cada paso sin violar la privacidad.

**Independent Test**: Puede probarse ejecutando consultas federadas exitosas y consultas federadas rechazadas (por ejemplo por violación de costo en BD B), inspeccionando el archivo o almacén inmutable de auditoría para verificar que todas las fases generen entradas estructuradas que compartan el mismo `federation_id`, identificando los adaptadores utilizados, los tiempos de ejecución, la cantidad de filas obtenidas y el estado de la operación, sin registrar claves crudas ni contenido sensible.

**Acceptance Scenarios**:

1. **Given** el inicio de una consulta federada recibida por el servidor MCP, **When** se acepta la solicitud para su procesamiento, **Then** se genera un identificador único de operación federada (`federation_id` UUID v4) que se asocia a todas las fases del ciclo de vida de la transacción.
2. **Given** la ejecución de la consulta en BD A y la subsecuente ejecución en BD B, **When** cada motor finaliza su procesamiento, **Then** se emite un registro de auditoría independiente para cada consulta incluyendo: `federation_id`, identificación del servidor/adaptador, hash del SQL ejecutado, tiempo de respuesta, número de filas devueltas y estado de ejecución.
3. **Given** la extracción y filtrado de claves en memoria, **When** se determina el lote de parámetros para BD B, **Then** se emite un registro de auditoría del paso de extracción que detalla el conteo total de claves extraídas, claves deduplicadas, claves nulas omitidas y si se aplicó truncamiento por tope, sin incluir los valores textuales de las claves en el registro.
4. **Given** cualquier rechazo durante el flujo (por ejemplo, rechazo por Guard AST en BD B o cancelación por tiempo de espera), **When** se aborta la operación, **Then** se registra el evento de auditoría con la causa exacta del fallo vinculado al `federation_id`, asegurando que no queden pasos huérfanos sin registrar.

---

### Edge Cases

- **La consulta en BD A devuelve 0 filas (conjunto de claves vacío)**: El orquestador detecta que no existen claves para filtrar en BD B. En lugar de ejecutar una consulta innecesaria en BD B (como `WHERE id IN ()` que provocaría error sintáctico o costo inútil), omite la consulta en BD B, devuelve un resultado vacío estructurado, y registra en auditoría la finalización del flujo por origen vacío.
- **La consulta en BD A devuelve claves con valores nulos (`NULL`)**: El extractor de claves filtra automáticamente los valores nulos para evitar construir cláusulas `IN` con elementos nulos que degradan la optimización del plan de ejecución en BD B.
- **La consulta en BD A devuelve claves duplicadas masivas**: El extractor deduplica en memoria los valores antes de armar la lista de parámetros tipados para BD B, aprovechando al máximo la ventana del tope de 500 parámetros.
- **Tipos de datos de claves incompatibles entre BD A y BD B**: Si los identificadores en BD A son de tipo alfanumérico (`VARCHAR`) y la columna destino en BD B espera enteros (`BIGINT`), o viceversa, el orquestador valida la coercibilidad básica antes de la ejecución o maneja el error de tipado del motor secundario de forma grácil sin exponer volcados de memoria.
- **Falla o caída de conexión con BD B tras haber completado BD A**: El orquestador libera inmediatamente los datos y claves de BD A retenidos en la memoria del proceso, cancela transacciones pendientes si las hubiere, emite el evento de auditoría con estado de error de conexión en BD B vinculado al `federation_id`, y retorna un mensaje de error limpio al cliente.
- **Cancelación o interrupción de la operación por el cliente durante la espera de BD B**: Si el cliente MCP o la IA aborta la solicitud mientras la consulta en BD B se encuentra en ejecución, el orquestador envía la señal de cancelación real al motor de BD B (cancelando la consulta activa en el servidor de base de datos) y audita la cancelación.
- **Volumen de claves extraídas que supera el tope configurado**: Cuando BD A produce más de 500 claves (o el límite establecido), el orquestador no falla abruptamente: trunca el conjunto de claves a las primeras 500 según el orden retornado, ejecuta la consulta en BD B para ese subconjunto, e inserta una advertencia explícita en los metadatos de respuesta (`truncated_keys: true`, `total_available: N`, `processed: 500`) y en la auditoría.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Coordinación y Orquestación Federada en Memoria

- **FR-001**: El sistema MUST exponer una herramienta MCP (`execute_federated_query`) que permita coordinar y ejecutar consultas combinadas entre dos bases de datos independientes registradas en el servidor MCP (BD A como origen y BD B como destino).
- **FR-002**: El orquestador MUST operar de forma totalmente autónoma desde el espacio de memoria del proceso del servidor MCP, quedando terminantemente prohibido el uso o generación de sentencias con enlaces de motor (*linked servers*, `OPENQUERY`, dblink u extensiones de servidores foráneos).
- **FR-003**: El sistema MUST interactuar con las bases de datos origen y destino exclusivamente a través de la abstracción `DatabaseAdapter`, soportando escenarios homogéneos (ambos servidores del mismo motor) y escenarios heterogéneos (cruces entre motores distintos, iniciando con PostgreSQL y SQL Server).
- **FR-004**: El orquestador MUST recibir como parámetros de entrada la especificación de la consulta en BD A, el nombre de la columna de clave simple a extraer en BD A (columna única), la especificación de la plantilla de consulta en BD B conteniendo el marcador explícito `IN (:keys)`, la columna de unión simple correspondiente en BD B (columna única) y el tipo de cruce en memoria deseado (`LEFT` o `INNER`, con valor predeterminado `LEFT`). Las claves compuestas de múltiples columnas quedan explícitamente fuera de alcance en esta versión.
- **FR-005**: Si la consulta en BD A devuelve cero filas, el orquestador MUST omitir la ejecución de la consulta en BD B, retornando un resultado consolidado vacío y registrando en la auditoría el salto de ejecución por conjunto vacío.
- **FR-006**: El cruce de registros entre BD A y BD B MUST ejecutarse en memoria dentro del proceso MCP utilizando los valores reales antes de la fase de enmascaramiento y pseudonimización. Al consolidar las columnas de ambas bases de datos, el orquestador MUST respetar los alias explícitos definidos en cada consulta (`AS nombre_alias`); en caso de existir colisiones de nombres no resueltas por alias entre columnas de BD A y BD B, el orquestador MUST prefijar automáticamente las columnas colisionantes de BD B con `target_<nombre_columna>`, impidiendo la sobreescritura o pérdida silenciosa de datos.

#### Doble Validación de Seguridad: Guard AST, Costo y Solo Lectura

- **FR-007**: Ambas consultas (la consulta para BD A y la consulta para BD B con su marcador `:keys` expandido a parámetros tipados) MUST ser analizadas y validadas de forma estrictamente independiente por el Guard AST antes de ser ejecutadas en sus respectivos motores.
- **FR-008**: El Guard AST MUST garantizar que tanto la consulta de BD A como la consulta de BD B sean exclusivamente sentencias `SELECT` de solo lectura, rechazando comentarios inline (`--`), comentarios de bloque (`/* */`), sentencias encadenadas con punto y coma (`;`), CTEs con mutación de datos (`INSERT`, `UPDATE`, `DELETE`), cláusulas `SELECT INTO` y llamadas a procedimientos almacenados.
- **FR-009**: Cada consulta federada MUST ser analizada independientemente por el analizador de costo de plan de ejecución de su respectivo adaptador antes de su ejecución, verificando que no exceda los límites configurados de costo computacional, tiempo estimado y tasa de consultas.
- **FR-010**: Si la consulta en BD A o la consulta en BD B es catalogada como riesgosa o sobrepasa los umbrales de costo permitidos, el orquestador MUST suspender la ejecución y requerir confirmación humana explícita, impidiendo que la IA se auto-apruebe la consulta.
- **FR-011**: La ejecución en BD A y en BD B MUST realizarse utilizando usuarios de base de datos dedicados con privilegios de solo lectura independientes en cada motor, verificados obligatoriamente mediante comprobación previa (*preflight check*).

#### Tratamiento de Claves como Datos No Confiables e Inyección Parametrizada

- **FR-012**: Las claves extraídas de la consulta en BD A MUST tratarse estrictamente como datos no confiables y hostiles dentro de la memoria del orquestador.
- **FR-013**: El orquestador MUST sustituir el marcador `:keys` en la plantilla de BD B por la lista de marcadores de parámetros correspondiente al dialecto del motor destino (`$1, $2, ...` en PostgreSQL o `@p1, @p2, ...` en SQL Server), vinculando las claves extraídas de BD A EXCLUSIVAMENTE como parámetros tipados en el protocolo nativo. Queda terminantemente prohibida cualquier concatenación o interpolación dinámica de datos en el texto SQL, mitigando de forma concluyente cualquier vector de inyección SQL de segundo orden.
- **FR-014**: El orquestador MUST aplicar un filtro de deduplicación y eliminación de valores nulos sobre las claves extraídas de BD A antes de construir el conjunto de parámetros tipados para BD B.
- **FR-015**: El sistema MUST imponer un tope estricto y configurable de claves para la inyección en BD B, fijado por defecto en 500 claves (respetando con holgura el límite técnico de 2100 parámetros de SQL Server).
- **FR-016**: Si el número de claves únicas no nulas extraídas de BD A excede el tope configurado, el orquestador MUST aplicar por defecto una estrategia de truncamiento seguro, procesando únicamente las primeras claves hasta alcanzar el tope, adjuntando advertencias explícitas en los metadatos de respuesta (`is_truncated: true`, `total_keys_found`, `keys_processed`) y en la auditoría. Opcionalmente, la herramienta MUST admitir el parámetro `overflow_action` (`'truncate'` o `'fail'`, por defecto `'truncate'`); cuando se establezca en `'fail'`, el orquestador MUST abortar la operación con un error estructurado `KEY_LIMIT_EXCEEDED` sin ejecutar la consulta en BD B.

#### Privacidad en Memoria y Pseudonimización Determinista por Sesión

- **FR-017**: Una vez unidos los resultados de BD A y BD B en memoria con sus valores reales, el conjunto final de datos MUST pasar por la capa de enmascaramiento antes de ser serializado y entregado al cliente MCP o modelo de IA.
- **FR-018**: El enmascarador MUST aplicar pseudonimización determinista por sesión en las columnas sensibles de cruce mediante HMAC-SHA256 alimentado con el salt efímero de sesión, sustituyendo los valores reales por pseudónimos alfanuméricos compactos con el formato canónico `pseudo_<16_hex>` (prefijo `pseudo_` seguido de los primeros 16 caracteres hexadecimales del resumen).
- **FR-019**: La pseudonimización determinista MUST garantizar que dos valores idénticos de clave en BD A y BD B generen exactamente el mismo valor de pseudónimo dentro de la misma sesión, permitiendo al cliente o modelo de IA correlacionar los registros coincidentes sin que el dato sensible real salga jamás del servidor MCP.
- **FR-020**: El salt efímero de sesión MUST generarse aleatoriamente con entropía criptográfica al inicializar la sesión del servidor MCP, mantenerse exclusivamente en memoria volátil y renovarse en cada nueva sesión, impidiendo la deducción de identidades o ataques de diccionario entre sesiones independientes.
- **FR-021**: Toda columna sensible adicional presente en las consultas de BD A o BD B (ej. datos de contacto, saldos, nombres) MUST ser enmascarada conforme a las reglas configuradas del enmascarador de privacidad antes de entregar la respuesta al cliente.

#### Auditoría Estructurada Inmutable Vinculada

- **FR-022**: Toda operación de consulta federada MUST generar un identificador único de operación (`federation_id` de tipo UUID v4) al momento de ser recibida por el orquestador.
- **FR-023**: Cada fase del flujo federado (inicio de orquestación, ejecución en BD A, extracción de claves, ejecución en BD B, cruce y enmascarado final, o cualquier rechazo intermedio) MUST emitir su propio evento de auditoría estructurado e inmutable.
- **FR-024**: Todos los eventos de auditoría correspondientes a una misma operación federada MUST incluir obligatoriamente el `federation_id` como campo de correlación transversal.
- **FR-025**: Los registros de auditoría MUST NOT exponer bajo ninguna circunstancia valores reales crudos de las claves de cruce, parámetros sensibles o datos procedentes de las filas consultadas.

---

### Key Entities

- **FederatedOperation**: Representa la entidad de coordinación global de una consulta federada. Contiene:
  - `federation_id`: Identificador único transversal (UUID v4).
  - `timestamp_started`: Fecha y hora de recepción de la solicitud.
  - `timestamp_completed`: Fecha y hora de finalización del flujo completo.
  - `source_db_id`: Identificador de la base de datos origen (BD A).
  - `target_db_id`: Identificador de la base de datos destino (BD B).
  - `join_type`: Tipo de unión en memoria solicitada (`LEFT` o `INNER`).
  - `status`: Estado de la operación (`PENDING`, `EXECUTING_SOURCE`, `EXTRACTING_KEYS`, `EXECUTING_TARGET`, `JOINING`, `MASKING`, `COMPLETED`, `REJECTED`, `FAILED`).
  - `key_limit_applied`: Tope numérico de claves aplicado durante la ejecución.

- **FederatedStepAudit**: Evento estructurado e inmutable emitido en cada hito del flujo federado. Contiene:
  - `federation_id`: Identificador de correlación con la operación global.
  - `step_name`: Nombre de la fase (`ORCHESTRATION_INIT`, `SOURCE_QUERY_GUARD`, `SOURCE_QUERY_EXEC`, `KEY_EXTRACTION`, `TARGET_QUERY_GUARD`, `TARGET_QUERY_EXEC`, `MEMORY_JOIN`, `RESULT_MASKING`, `OPERATION_FAILED`).
  - `timestamp`: Marca temporal de precisión del evento.
  - `adapter_type`: Tipo de adaptador involucrado (`postgres`, `sqlserver`, o `orchestrator`).
  - `sql_hash`: Hash unidireccional de la sentencia SQL evaluada (sin valores reales).
  - `duration_ms`: Tiempo de ejecución invertido en la fase.
  - `row_count`: Cantidad de filas recuperadas o procesadas en la fase.
  - `keys_extracted_count`: Número de claves extraídas (en la fase de extracción).
  - `keys_truncated`: Bandera booleana que indica si se aplicó truncamiento por tope.
  - `status`: Resultado de la fase (`SUCCESS`, `REJECTED`, `ERROR`).
  - `rejection_reason`: Motivo detallado si la fase fue rechazada o falló.

- **FederatedKeySet**: Estructura volátil en memoria encargada de almacenar y gestionar las claves extraídas de BD A antes de la inyección en BD B. Contiene:
  - `key_column_name`: Nombre de la columna de extracción.
  - `total_raw_keys`: Total de valores de clave recolectados inicialmente.
  - `unique_keys`: Lista en memoria de claves únicas no nulas tratadas como datos no confiables.
  - `null_keys_discarded`: Cantidad de valores nulos filtrados.
  - `is_truncated`: Indicador de si el conjunto superó el tope permitido.

- **SessionPseudonymContext**: Contexto criptográfico de privacidad volátil vinculado a la sesión MCP activa. Contiene:
  - `session_id`: Identificador de la sesión MCP activa.
  - `ephemeral_salt`: Clave secreta efímera en memoria generada por el servidor para la sesión.
  - `pseudonym_cache`: Tabla temporal de resolución en memoria para garantizar consistencia y rapidez en la pseudonimización determinista de valores repetidos durante la sesión.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100% de las consultas federadas entre servidores se coordinan y resuelven íntegramente en la memoria del proceso del servidor MCP, con 0% de uso de *linked servers*, `OPENQUERY` o extensiones de enlaces foráneos entre motores.
- **SC-002**: El 100% de las claves extraídas de la base de datos origen se transmiten a la base de datos destino estrictamente como parámetros tipados nativos; 0 incidencias de concatenación de texto SQL o inyección de segundo orden registradas en la batería de pruebas adversarias.
- **SC-003**: 0% de exposición de valores reales sensibles en las columnas designadas de cruce hacia el cliente MCP o modelo de IA; 100% de consistencia determinista en la correlación por pseudónimos dentro de una misma sesión (registros con claves reales iguales producen idéntico pseudónimo con formato normalizado `pseudo_<16_hex>`).
- **SC-004**: En el 100% de los casos en que la consulta en BD A produce una cantidad de claves superior al tope configurado (por defecto 500), el orquestador trunca de forma segura a 500 parámetros, previene cualquier desbordamiento de parámetros en BD B y adjunta la advertencia correspondiente de truncamiento.
- **SC-005**: El 100% de los eventos de auditoría emitidos durante las diversas fases de una misma operación federada comparten de forma verificable el mismo identificador transversal `federation_id`.
- **SC-006**: La sobrecarga computacional propia del orquestador (extracción de claves, deduplicación, cruce en memoria y pseudonimización determinista de hasta 500 registros) no excede los 150 milisegundos por encima de los tiempos de ejecución de las dos bases de datos.
- **SC-007**: El 100% de los intentos de consultar motores sin privilegios de solo lectura comprobados en arranque (*preflight check*) o con sentencias rechazadas por el Guard AST son bloqueados antes de ejecutarse en el motor secundario.

---

## Assumptions

- **Configuración previa de adaptadores**: Ambas bases de datos (BD A y BD B) están previamente registradas y configuradas en el servidor MCP con sus respectivas credenciales de solo lectura, esquemas y adaptadores operativos (`DatabaseAdapter`).
- **Compatibilidad semántica de claves de cruce**: Las columnas de cruce elegidas entre BD A y BD B corresponden a columnas individuales (claves simples) que representan dominios de datos compatibles o convertibles lógicamente (por ejemplo, identificadores de cliente alfanuméricos o numéricos que admiten comparación directa). Las claves compuestas de múltiples columnas quedan fuera del alcance de esta versión.
- **Tipo de unión predeterminado**: Si el usuario o modelo no especifica el tipo de cruce en memoria, el orquestador aplica una unión por la izquierda (`LEFT` join) tomando como base los resultados de BD A, asegurando que no se pierdan los registros originales de origen cuando no haya coincidencia en el destino.
- **Comportamiento ante exceso de tope de claves**: Cuando BD A retorna más claves del tope permitido (500 por defecto), la política operativa predeterminada es truncar el conjunto de claves al límite establecido y continuar la operación emitiendo una advertencia explícita en la respuesta y en la auditoría, priorizando la resiliencia operativa y la protección contra desbordamientos.
- **Ciclo de vida del salt efímero**: El salt criptográfico para la pseudonimización determinista por sesión se genera y almacena exclusivamente en la memoria RAM del proceso del servidor MCP durante su tiempo de vida, destruyéndose al cerrar el servidor o la sesión, sin persistencia en disco ni transmisión a clientes.
- **Soporte inicial de motores**: El soporte inicial para federación cubre de forma prioritaria PostgreSQL y SQL Server, manteniéndose desacoplado a través del contrato `DatabaseAdapter` para permitir la incorporación futura de otros motores relacionales.
