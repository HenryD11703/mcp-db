# Feature Specification: Conectores MySQL/MariaDB, SQLite y Enmascaramiento Robusto de Variaciones de Columnas Sensibles

**Feature Branch**: `007-mysql-sqlite-robust-masking`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "El usuario desea tambien conectar mysql/mariadb y sqlite por que tambien maneja todo este tipo de cosas, desea asegurarse que ninguno de sus datos se filtra con toda la variacion de columnas para enmascarar por ejemplo, nit, que pueda enmascarar nitempleado, empnit, galempnit, emp_nit, y todas las variacioens verificar realmente todas las formas que esta puede ser nombrada y que sea robusta para tampoco confundirse y evitar que se filtren los datos"

## Clarifications

### Session 2026-11-02
- Q: ¿Qué formato visual o nivel de anonimización debe aplicarse por defecto cuando se detecte un valor de NIT en columnas como `nit`, `empnit`, `galempnit`, `emp_nit`, etc.? → A: Enmascaramiento parcial preservando el guion y el dígito verificador (ej. `*******-4` o `******-K`), con opciones configurables para redacción total (`[NIT ENMASCARADO]`) o pseudonimización determinista por sesión (`pseudo_nit_<hex16>`).
- Q: ¿Cómo se define formalmente una "sesión" para la pseudonimización determinista? → A: Una sesión corresponde al ciclo de vida del proceso en ejecución del servidor MCP, respaldada por una semilla criptográfica efímera (salt generado aleatoriamente en memoria en el arranque). Dentro de la misma sesión, el hash es determinista (mismo NIT produce idéntico pseudónimo); al reiniciar el proceso se regenera el salt, imposibilitando la correlación histórica.
- Q: ¿Cómo debe restringir el servidor MCP qué archivos `.db`/`.sqlite` locales tiene permitido abrir y consultar? → A: Lista blanca explícita de rutas y directorios configurados (mediante variable de entorno o archivo de configuración), con comprobación de permisos de solo lectura a nivel del sistema operativo y apertura forzada en modo estricto de solo lectura (`mode=ro`), rechazando bases de datos efímeras en memoria (`:memory:`).
- Q: ¿Cómo debe proceder el analizador ante nombres continuos sin separadores (ej. `galempnit`, `empnit`, `nitempleado`) para evitar falsos positivos y falsos negativos? → A: Descomposición léxica y segmentación morfológica determinista que recorta prefijos conocidos y sufijos de entidad/rol, aislando el token sensible (`nit`) y descartando palabras completas del diccionario seguro (`unit`, `nitrate`, `ignite`, `granite`).
- Q: ¿Cuál es el catálogo unificado de prefijos reconocidos por el sistema? → A: Catálogo unificado que integra prefijos organizacionales/de entidad (`emp`, `gal`, `cli`, `prov`, `usr`, `cust`, `tit`, `cta`, `dep`, `suc`, `doc`), prefijos técnicos/de alias (`t1`, `col`, `v`, `tbl`) y abreviaturas de identificación (`no`, `num`, `nro`, `id`, `tax`), ampliable en tiempo de ejecución mediante la variable de entorno `MASKING_CUSTOM_PREFIXES`.
- Q: ¿Debe el motor de privacidad aplicar inspección del formato de los datos (patrón de contenido) como segunda línea de defensa cuando una consulta utilice un alias opaco o expresiones que alteren el nombre de la columna? → A: Activar inspección de patrón de contenido en memoria como salvaguarda secundaria celda a celda ante columnas con nombres o alias no coincidentes o calculadas (`CONCAT`, `UPPER`, `SUBSTRING`). La inspección de contenido nunca podrá anular ni des-enmascarar una columna clasificada como sensible por su nombre.
- Q: ¿Cómo debe proceder el sistema ante columnas ambiguas o de baja confianza que no coincidan de forma determinista? → A: Política de seguridad por defecto (fail-safe): enmascarar preventivamente los valores en memoria y emitir una entrada estructurada en `audit.jsonl` con etiqueta `low_confidence_match` indicando la columna y la señal evaluada para supervisión humana, sin filtrar jamás datos crudos.
- Q: ¿Cómo debe implementar el adaptador de MySQL/MariaDB la cancelación efectiva de consultas y cuál es su límite temporal máximo? → A: Estrategia híbrida: directiva nativa de tiempo de ejecución (`MAX_EXECUTION_TIME` / `max_statement_time`) respaldada por emisión activa de `KILL QUERY <thread_id>` mediante una conexión auxiliar de control. La cancelación efectiva en el motor debe culminar en un tiempo no mayor a 500 milisegundos tras expirar el timeout configurado.
- Q: ¿Deben las herramientas de introspección de esquemas enriquecer los metadatos de columnas compuestas (como `galempnit`) con la categoría sensible inferida? → A: Enriquecer metadatos en `describe_table` e `introspect_schema` con `sensitive_type` (ej. `"nit"`) e `is_masked: true`, excluyendo totalmente muestras de datos crudos (`sample_values`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Conectividad Segura y Consultas de Solo Lectura en MySQL y MariaDB (Priority: P1)

Como analista o asistente de IA, necesito conectar instancias de bases de datos MySQL y MariaDB para consultar datos operativos y analíticos bajo un esquema estricto de solo lectura, con validación sintáctica de seguridad y verificación de privilegios mínimos en el arranque, garantizando que el sistema jamás ejecute modificaciones ni filtre credenciales.

**Why this priority**: MySQL y MariaDB son motores relacionales ampliamente extendidos en el ecosistema empresarial. Integrarlos bajo las garantías constitucionales de solo lectura inquebrantable (Principio I) y defensa en profundidad (Principio II) amplía la cobertura del servidor sin comprometer la seguridad.

**Independent Test**: Puede probarse de forma aislada configurando una conexión hacia una base de datos MySQL/MariaDB con usuario de solo lectura, ejecutando consultas analíticas de selección (`SELECT`) y verificando que sentencias con intenciones de escritura, encadenamiento o procedimientos almacenados sean bloqueadas de inmediato.

**Acceptance Scenarios**:

1. **Given** una base de datos MySQL o MariaDB configurada con un usuario con permisos exclusivos de lectura, **When** el servidor inicia y evalúa la conexión, **Then** la comprobación previa (*preflight check*) confirma la ausencia de privilegios de escritura (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, etc.) y permite habilitar el adaptador.
2. **Given** una conexión activa a MySQL o MariaDB, **When** un usuario o modelo de IA envía una consulta `SELECT` legítima, **Then** el sistema valida la consulta mediante análisis sintáctico (AST), fuerza en la sesión `sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'`, la ejecuta de forma no destructiva y devuelve los registros protegidos.
3. **Given** una consulta que contiene intentos de mutación, comentarios inline/bloque, sentencias múltiples encadenadas con punto y coma (`;`), o funciones administrativas, **When** el sistema la procesa, **Then** la consulta es rechazada categóricamente antes de enviarse al motor de base de datos.
4. **Given** una consulta en MySQL o MariaDB que excede el tiempo límite (`timeoutMs`), **When** se alcanza el vencimiento, **Then** el adaptador activa `KILL QUERY <thread_id>` vía canal de control y la cancelación efectiva en el motor culmina en menos de 500 ms liberando recursos.

---

### User Story 2 - Conectividad de Solo Lectura y Aislamiento para SQLite (Priority: P1)

Como usuario o analista, necesito conectar archivos de bases de datos locales SQLite (bases operativas locales, respaldos, réplicas analíticas o catálogos empotrados) para realizar consultas analíticas, asegurando que el acceso sea puramente no destructivo, verificado a nivel de permisos del sistema de archivos y parámetros de conexión.

**Why this priority**: SQLite es el motor estándar para bases de datos embebidas, archivos de respaldo y aplicaciones portables. Su naturaleza basada en archivos exige controles estrictos para garantizar que ninguna operación altere el archivo fuente ni ejecute funciones no seguras.

**Independent Test**: Puede probarse apuntando a un archivo `.sqlite`/`.db`, ejecutando consultas de solo lectura y verificando que intentos de escritura (o intentos de abrir archivos sin permisos adecuados) fallen sin modificar el archivo ni sus metadatos.

**Acceptance Scenarios**:

1. **Given** un archivo de base de datos SQLite persistente en disco (`.db`, `.sqlite`, `.sqlite3`) listado en la lista blanca de rutas autorizadas, **When** el servidor inicializa la conexión, **Then** la conexión se establece forzando modo de solo lectura estricto (`mode=ro`) tanto en la URI de conexión como en la comprobación de permisos de archivo del sistema operativo.
2. **Given** un intento de conexión hacia una base de datos efímera en memoria (`:memory:`) o una ruta fuera de la lista blanca, **When** el servidor evalúa la solicitud, **Then** la conexión es denegada en el preflight check con un error de seguridad explícito.
3. **Given** un intento de ejecutar comandos destructivos o de escape (`ATTACH DATABASE`, `VACUUM INTO`, `PRAGMA writable_schema`, `CREATE`, `DROP`, `INSERT`), **When** el sistema valida la sentencia, **Then** la rechaza inmediatamente en el Guard AST sin tocar el archivo de base de datos.

---

### User Story 3 - Detección Robusta y Segmentación Morfológica de Columnas Sensibles (Priority: P1)

Como oficial de seguridad y privacidad de datos, necesito que el motor de enmascaramiento identifique automáticamente cualquier columna que contenga identificadores sensibles (como NIT, identificaciones fiscales, DPI, teléfonos, correos o montos) sin importar cómo haya sido nombrada por desarrolladores o sistemas legados, resolviendo casos delimitados (`emp_nit`, `gal_emp_nit`), camelCase (`empNit`, `nitCliente`), concatenaciones continuas sin separador (`empnit`, `galempnit`, `clinit`, `nitempleado`, `nitno`) y abreviaturas técnicas, garantizando que el dato sensible jamás se filtre hacia el modelo o cliente externo.

**Why this priority**: En sistemas reales y legados, las columnas frecuentemente carecen de delimitadores o combinan prefijos empresariales con raíces sensibles (ej. `galempnit` = "gal" + "emp" + "nit"). Si el enmascarador no efectúa una segmentación morfológica adecuada que recorte prefijos y sufijos hacia el token raíz, se produce una fuga crítica de PII (Principio IV: Privacidad en Memoria).

**Independent Test**: Puede probarse ejecutando la suite de evaluación contra `corpus/column-name-sensitivity-corpus.json`; se verifica que el 100 % de los casos marcados como `sensible` sean interceptados y enmascarados, y que ante concatenaciones continuas como `empnit`, `galempnit`, `nitempleado`, `clinit` y `nitno`, el dato crudo sea reemplazado según la regla de enmascaramiento configurada.

**Acceptance Scenarios**:

1. **Given** una consulta que proyecta una columna en minúsculas sin delimitadores que une un prefijo y la raíz sensible (ej. `empnit`, `clinit`, `provnit`), **When** el analizador morfológico la procesa, **Then** recorta el prefijo del catálogo unificado, identifica el token raíz `nit` y aplica el enmascaramiento correspondiente.
2. **Given** una consulta con concatenación continua de múltiples prefijos empresariales y raíz sensible (ej. `galempnit`), **When** se evalúa la columna, **Then** el analizador descompone secuencialmente los prefijos (`gal`, `emp`), aísla el token `nit` y clasifica la columna como sensible con `dataType: "nit"`.
3. **Given** una columna con la raíz sensible al inicio seguida de un sufijo de entidad o rol sin separador (ej. `nitempleado`, `nitcliente`, `nitno`), **When** el analizador evalúa la cadena, **Then** reconoce el token inicial `nit` seguido del sufijo conocido y clasifica la columna como sensible.
4. **Given** un valor de NIT guatemalteco proyectado (formato con o sin guion y dígito verificador), **When** se aplica el enmascaramiento por defecto, **Then** se preserva el guion y el dígito verificador (`*******-4` o `******-K`), impidiendo la exposición del número completo.
5. **Given** una configuración de privacidad con modo de redacción total o pseudonimización determinista por sesión, **When** se procesa la columna sensible, **Then** se emite respectivamente `[NIT ENMASCARADO]` o `pseudo_nit_<hex16>` con el salt de la sesión activa.

---

### User Story 4 - Discriminación Léxica y Prevención Absoluta de Falsos Positivos (Priority: P2)

Como analista de negocios o ingeniero de datos, necesito que el mecanismo de detección de columnas sensibles sea preciso y no confunda términos comerciales o técnicos benignos que contengan casualmente subsecuencias de letras similares (evitando enmascarar `unit`, `unit_price`, `units_in_stock`, `infinite`, `nitrate`, `ignite`, `granite`, `monitor`, `initial`, `benito`, `definition`), de modo que las consultas no pierdan información analítica legítima por falsas alarmas.

**Why this priority**: Un enmascaramiento por subcadenas o coincidencia difusa no acotada sobre palabras cortas ("nit", "cel", "sal") destruye información empresarial indispensable como precios unitarios (`unit_price`) o estados de inventario. La discriminación determinista mediante diccionario seguro garantiza 0 % de falsos positivos en columnas legítimas.

**Independent Test**: Puede probarse evaluando todas las columnas marcadas como `no_sensible` en `corpus/column-name-sensitivity-corpus.json`; se verifica que el 0 % de estos casos sea clasificado erróneamente como sensible y sus valores numéricos o de texto legítimos se presenten sin alteración.

**Acceptance Scenarios**:

1. **Given** columnas con la palabra raíz completa "unit" (`unit`, `unit_price`, `unitId`, `units_in_stock`), **When** el analizador léxico las evalúa contra el diccionario seguro, **Then** descarta la activación de la regla de `nit` al identificar que "unit" es una palabra base completa y no un compuesto de `nit`.
2. **Given** columnas del vocabulario general con subsecuencias similares (`nitrate`, `ignite`, `infinite`, `granite`, `monitor`, `monitor_status`, `benito`, `manito`, `definition`), **When** se procesa la consulta, **Then** el sistema confirma que no corresponden a categorías sensibles y entrega los valores íntegros.
3. **Given** una columna ambigua no presente en el diccionario de palabras seguras ni clasificada deterministamente, **When** el sistema aplica la política de resolución, **Then** enmascara preventivamente en memoria los datos y genera un registro de auditoría con la etiqueta `low_confidence_match`, priorizando la protección sin exponer datos crudos.
4. **Given** una columna clasificada como sensible por su nombre, **When** se analizan las muestras de celdas, **Then** la señal de contenido NUNCA podrá anular ni des-enmascarar la columna (principio de seguridad por defecto).

---

### User Story 5 - Enmascaramiento Uniforme en Consultas Directas, Federadas, Introspección y Auditoría (Priority: P2)

Como oficial de cumplimiento normativo, requiero que la protección contra fugas de datos sensibles opere de forma completamente uniforme y transversal: consultas directas a cualquier motor (PostgreSQL, SQL Server, MySQL, MariaDB, SQLite), consultas federadas entre servidores heterogéneos, herramientas de introspección de esquemas y registros de auditoría estructurados.

**Why this priority**: La privacidad de datos se quiebra si una columna sensible se enmascara en `query_database` pero se expone en un cruce federado, en una muestra de metadatos de `describe_table`, en un mensaje de error o en `audit.jsonl` (Principios IV y V).

**Independent Test**: Puede probarse ejecutando consultas directas, cruces federados bidireccionales (SQLite ↔ MySQL), solicitudes de metadatos de esquema y consultas con alias opacos o funciones calculadas; se verifica que en todas las superficies de salida y registros de auditoría no exista filtración de datos crudos.

**Acceptance Scenarios**:

1. **Given** una consulta federada en cualquier dirección (SQLite como origen BD A y MySQL como destino BD B, o viceversa) que utiliza una columna sensible (como `nit` o `empnit`) para correlacionar registros, **When** se procesa el cruce en memoria, **Then** la unión interna se realiza con los datos íntegros dentro del proceso MCP, pero la salida serializada al cliente entrega los valores enmascarados o pseudonimizados de manera uniforme.
2. **Given** cualquier ejecución de consulta en SQLite, MySQL o MariaDB registrada en la auditoría estructurada (`audit.jsonl`), **When** se almacena el evento, **Then** el registro de auditoría omite cualquier valor crudo de datos sensibles e incluye la lista de nombres de columnas protegidas (`masked_columns`).
3. **Given** una consulta con alias opacos o expresiones de transformación (`SELECT empnit AS codigo_ref`, `SELECT UPPER(empnit)`, `SELECT CONCAT(empnit, '')`), **When** el analizador de nombres no detecta el término sensible, **Then** la inspección de patrón de contenido en memoria intercepta los valores celda a celda y los enmascara exitosamente.
4. **Given** una invocación a `describe_table` o `introspect_schema` sobre una tabla con columnas sensibles (`empnit`, `galempnit`, `email`, `dpi`), **When** el servidor responde los metadatos, **Then** etiqueta cada columna con su tipo sensible inferido (`sensitive_type: "nit"`) e `is_masked: true`, excluyendo categóricamente cualquier valor de muestra real (`sample_values`).
5. **Given** un error sintáctico, de ejecución o de timeout emitido por el motor de base de datos, **When** se serializa el mensaje de error hacia el cliente, **Then** el sistema sanitiza el texto impidiendo que valores de celdas o datos sensibles aparezcan en la traza.

---

### Edge Cases

- **Prefijos técnicos y sufijos numéricos (`t1_nit_emp`, `col_emp_nit_01`, `x_nit`)**: El tokenizador descarta prefijos de alias de tabla (`t1`, `col`, `v`, `tbl`) y sufijos numéricos (`_01`, `_1`), aislando la raíz `emp` y `nit` para su clasificación sensible.
- **Configuración de `sql_mode` en MySQL/MariaDB**: El adaptador fuerza en el handshake de conexión `sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'`, previniendo truncamientos silenciosos o comportamientos permisivos inseguros.
- **Archivos protegidos, enlaces simbólicos o rutas de red en SQLite**: El adaptador valida en el preflight check que la ruta resuelta canónicamente pertenezca a la lista blanca autorizada y posea permisos de lectura del sistema operativo; si es un enlace simbólico que apunta fuera de la lista blanca o no tiene permisos de lectura, la conexión se rechaza.
- **Columnas calculadas y alias opacos (`SELECT empnit AS codigo_aleatorio`, `CONCAT(empnit, '')`)**: La inspección de patrón de contenido celda a celda actúa como red de seguridad complementaria obligatoria para enmascarar valores que coincidan con la estructura de un dato sensible.
- **Dirección SQLite ↔ MySQL en consultas federadas**: Soportada de manera totalmente simétrica en ambas direcciones (SQLite → MySQL o MySQL → SQLite), extrayendo claves en memoria e inyectándolas como parámetros tipados independientes (`?`) en el motor destino sin concatenar cadenas.
- **Bases de datos en memoria en SQLite (`:memory:`)**: Rechazadas categóricamente en el preflight gate por violar la política de archivos persistentes en disco auditables.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema DEBE proporcionar conectividad y ejecución de consultas de solo lectura hacia bases de datos MySQL y MariaDB respetando el contrato unificado `DatabaseAdapter`.
- **FR-002**: El sistema DEBE validar mediante comprobación previa (*preflight check*) en el arranque de la conexión a MySQL/MariaDB que el usuario configurado carezca de privilegios de mutación y administración en el catálogo del motor (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `GRANT`, `SUPER`).
- **FR-003**: El sistema DEBE proporcionar conectividad y ejecución de consultas de solo lectura hacia bases de datos SQLite garantizando apertura en modo de lectura estricto (`mode=ro`) y validación de permisos en el almacenamiento de archivos persistentes en disco.
- **FR-004**: El sistema DEBE someter toda consulta dirigida a MySQL, MariaDB o SQLite a validación previa mediante el Guard AST de seguridad, rechazando cualquier sentencia que no sea exclusivamente un `SELECT` libre de efectos secundarios y comentarios.
- **FR-005**: Dado el corpus de evaluación `corpus/column-name-sensitivity-corpus.json`, el sistema DEBE clasificar y enmascarar el 100 % de los casos etiquetados como `sensible` y el 0 % de los casos etiquetados como `no_sensible` (0 % de falsos positivos en columnas legítimas de negocio).
- **FR-006**: El sistema DEBE reconocer el tipo de dato sensible `nit` (Número de Identificación Tributaria / Tax ID) integrándolo formalmente en `SensitiveDataType`, identificando variaciones en snake_case, camelCase, abreviaturas y combinaciones compuestas. El tipo de dato `amount` se mantiene como la categoría canónica para montos, sueldos y salarios.
- **FR-007**: El sistema DEBE incorporar filtros de desambiguación léxica y vocabulario seguro (*stop-words*) para evitar falsos positivos en columnas legítimas que contengan subsecuencias de letras similares dentro de palabras raíz (impidiendo que `unit`, `unit_price`, `units_in_stock`, `infinite`, `nitrate`, `ignite`, `granite`, `monitor`, `benito`, `manito`, `definition` sean marcadas como NIT).
- **FR-008**: El sistema DEBE transformar en memoria todos los valores provenientes de columnas identificadas como sensibles antes de la serialización hacia el cliente o modelo de IA, aplicando la estrategia de enmascaramiento correspondiente.
- **FR-009**: El sistema DEBE asegurar consistencia absoluta de enmascaramiento: los resultados de `query_database`, las consultas federadas (`execute_federated_query`), los registros de auditoría inmutable (`audit.jsonl`) y las respuestas de error omitirán cualquier dato sensible sin enmascarar.
- **FR-010**: El sistema DEBE aplicar por defecto para identificadores fiscales (como NIT) un formato de enmascaramiento parcial que preserve el guion y el dígito verificador (ej. `*******-4` o `******-K`), admitiendo configuración hacia redacción total (`[NIT ENMASCARADO]`) o pseudonimización determinista por sesión (`pseudo_nit_<hex16>`). La **sesión** se define formalmente como el ciclo de vida del proceso MCP activo, gobernado por un salt criptográfico efímero generado en memoria en el arranque.
- **FR-011**: El sistema DEBE restringir el acceso a bases de datos SQLite exclusivamente a archivos físicos persistentes en disco (`.db`, `.sqlite`, `.sqlite3`) definidos en una lista blanca explícita de configuración, rechazando bases de datos efímeras en memoria (`:memory:`), validando permisos del sistema de archivos y forzando la apertura en modo de solo lectura (`mode=ro`).
- **FR-012**: Dado el subconjunto de variaciones sin delimitador y concatenadas en `corpus/column-name-sensitivity-corpus.json` (incluyendo `empnit`, `galempnit`, `nitempleado`, `clinit`, `nitno`, `idnumber`, `correoe`), el sistema DEBE segmentar morfológicamente y enmascarar el 100 % de los casos `sensible`, asegurando simultáneamente que el 0 % de los casos `no_sensible` con subcadenas coincidentes (`unit`, `unit_price`, `monitor`, `benito`, `manito`, `dpid`, `thumbnail`, `chainmail`, `cocktail`, `celebrity_id`, `salient_feature`, `salad_type`) sean enmascarados.
- **FR-013**: El sistema DEBE implementar inspección de patrón de contenido como segunda línea de defensa en memoria para columnas con alias opacos o expresiones (`SELECT empnit AS cod`, `CONCAT(empnit, '')`). Para identificadores NIT, la evaluación exige formato con guion estructurado (`\b\d{2,8}-[0-9kK]\b`) o validación del dígito verificador mediante el algoritmo Módulo 11 de la SAT guatemalteca para longitudes de 6 a 10 dígitos, impidiendo falsos positivos sobre enteros generales como años (ej. 2024), códigos postales o identificadores numéricos ordinarios. La señal de contenido NUNCA podrá anular ni des-enmascarar una columna previamente clasificada como sensible por su nombre.
- **FR-014**: El sistema DEBE operar con un catálogo unificado de prefijos corporativos y técnicos precargados que integre: prefijos organizacionales/de entidad (`emp`, `gal`, `cli`, `prov`, `usr`, `cust`, `tit`, `cta`, `dep`, `suc`, `doc`), prefijos técnicos/de alias (`t1`, `col`, `v`, `tbl`) y abreviaturas de identificación (`no`, `num`, `nro`, `id`, `tax`), permitiendo incorporar prefijos empresariales adicionales en tiempo de ejecución mediante la variable de entorno `MASKING_CUSTOM_PREFIXES`.
- **FR-015**: El sistema DEBE garantizar la cancelación real en el motor para MySQL y MariaDB ante agotamiento del tiempo límite configurado (`timeoutMs`), combinando directivas nativas de tiempo de ejecución de sesión/sentencia con la emisión reactiva de `KILL QUERY <thread_id>` a través de un canal de control auxiliar, completando la cancelación efectiva en el motor en un lapso no mayor a **500 milisegundos** posteriores al vencimiento.
- **FR-016**: El sistema DEBE enriquecer las respuestas de introspección de esquemas y descripción de tablas (`describe_table`, `introspect_schema`) con la categoría sensible inferida (`sensitive_type`) y la confirmación de enmascaramiento activo (`is_masked: true`) para cada columna identificada (ej. `sensitive_type: "nit"` en `galempnit`), omitiendo categóricamente cualquier valor o muestra de datos crudos (`sample_values`).
- **FR-017**: El sistema DEBE aplicar una frontera de decisión determinista y estricta entre estados de confianza:
  1. Si un nombre o raíz coincide con el `SafeVocabularyDictionary`, el estado DEBE ser irrevocablemente `none` (0 % de falsos positivos garantizado, nunca entra a fail-safe).
  2. Si coincide con raíces sensibles y reglas del catálogo unificado, el estado DEBE ser `deterministic`.
  3. El estado `low_confidence_fail_safe` se reserva exclusivamente para columnas no catalogadas en el diccionario seguro que presenten indicios léxicos ambiguos de datos sensibles, enmascarando preventivamente en memoria y emitiendo una entrada estructurada en `audit.jsonl` con etiqueta `low_confidence_match` para supervisión humana, sin exponer datos crudos.

### Key Entities *(include if feature involves data)*

- **DatabaseAdapter (MySQL / MariaDB / SQLite)**: Abstracción de conexión y ejecución de solo lectura que implementa el contrato general de base de datos para los nuevos motores soportados, manejando tipos de datos nativos, cotizaciones de identificadores, forzado de `sql_mode` estricto y comprobaciones de privilegios de solo lectura.
- **LexicalColumnAnalyzer**: Componente responsable de normalizar y tokenizar nombres de columna (delimitadores, camelCase, concatenaciones continuas sin separador), recortar prefijos del catálogo unificado y sufijos contextuales, y evaluar la presencia determinista de raíces sensibles.
- **UnifiedPrefixCatalog**: Catálogo consolidado de prefijos organizacionales (`emp`, `gal`, `cli`, `prov`, `usr`, `cust`, `tit`, `cta`, `dep`, `suc`, `doc`), prefijos técnicos (`t1`, `col`, `v`, `tbl`) y abreviaturas (`no`, `num`, `nro`, `id`, `tax`), extensible dinámicamente vía `MASKING_CUSTOM_PREFIXES`.
- **SafeVocabularyDictionary (Anti-False-Positive Filter)**: Catálogo de términos comunes y raíces léxicas conocidas que previene la activación accidental de reglas sensibles ante palabras legítimas compuestas por letras similares (`unit`, `nitrate`, `ignite`, `granite`, `monitor`, etc.).
- **SessionContext**: Entorno efímero de ejecución del servidor MCP que administra la semilla criptográfica (salt generado aleatoriamente en memoria en el arranque) para garantizar pseudonimización determinista durante la vida del proceso e invalidación entre reinicios.
- **MaskingRule / SensitiveCategory**: Definición de regla de privacidad que asocia una categoría sensible (incluyendo `nit`, `dpi`, `email`, `phone`, `amount`) con estrategias de enmascaramiento (`partial`, `redact`, `session_pseudonym`, `mask_amount`) y patrones de coincidencia léxica y de contenido.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Evaluado contra el corpus completo `corpus/column-name-sensitivity-corpus.json`, el 100 % de los casos etiquetados como `sensible` son detectados y enmascarados exitosamente sin escape de datos crudos.
- **SC-002**: Evaluado contra el corpus completo `corpus/column-name-sensitivity-corpus.json`, se obtiene un 0 % de falsos positivos en los casos etiquetados como `no_sensible` (las columnas legítimas como `unit_price`, `monitor`, `benito`, `definition` conservan sus datos intactos).
- **SC-003**: 100% de las pruebas del corpus de seguridad adversaria (inyecciones SQL, sentencias múltiples, comentarios destructivos, modificaciones de esquema) son bloqueadas en MySQL, MariaDB y SQLite antes de la ejecución.
- **SC-004**: Los adaptadores de MySQL, MariaDB y SQLite son capaces de inicializarse, validar sus permisos en el *preflight check* y ejecutar consultas válidas en menos de 50 milisegundos de sobrecarga sobre la latencia de red/disco.
- **SC-005**: 0 registros en el archivo de auditoría (`audit.jsonl`) exponen valores crudos de columnas clasificadas como sensibles durante las operaciones directas o federadas con todos los motores soportados.
- **SC-006**: 100% de los valores sensibles devueltos bajo columnas con alias ofuscados o expresiones no reconocidas (`CONCAT`, `UPPER`, `SUBSTRING`) son interceptados y enmascarados mediante la inspección de patrón de contenido sin fuga de información cruda.
- **SC-007**: La cancelación real de consultas de larga duración en MySQL y MariaDB (`timeoutMs`) se completa en el motor en un tiempo no mayor a 500 milisegundos posteriores a la expiración del temporizador.
- **SC-008**: 0 valores de muestra crudos (`sample_values`) son expuestos en las respuestas de introspección de esquemas (`describe_table`, `introspect_schema`) para columnas identificadas como sensibles.

## Assumptions

- Para MySQL y MariaDB, el entorno de base de datos permite la creación de un usuario con privilegios restringidos exclusivamente a `SELECT` en las tablas o esquemas requeridos, y acceso a un hilo de control para emitir `KILL QUERY` en caso de cancelación.
- Para SQLite, el motor se ejecuta en modo estricto de solo lectura (`mode=ro`) sobre archivos persistentes en disco ubicados en rutas validadas contra la lista blanca autorizada.
- Las variaciones de nombres de columnas como `galempnit` provienen de convenciones empresariales hispanohablantes o mixtas (donde "gal" es un prefijo de empresa/sistema, "emp" es empleado y "nit" es el número de identificación tributaria).
- El enmascaramiento se realiza en memoria en el servidor MCP inmediatamente después de recibir las filas del motor y antes de procesar la respuesta final al cliente, conforme al Principio IV de la Constitución.
