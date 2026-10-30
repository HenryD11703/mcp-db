# Feature Specification: Herramientas de Comprensión y Descubrimiento para Bases de Datos Legacy

**Feature Branch**: `005-legacy-db-understanding`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "Herramientas de comprensión y descubrimiento para bases de datos legacy. 1) Exploración e inferencia de esquema: expone herramientas para que la IA explore catálogos de tablas, columnas y tipos de datos sin necesidad de leer filas completas; incluye un motor heurístico que infiere relaciones probables entre tablas aun cuando no existan llaves foráneas declaradas en el motor, basándose en coincidencia de patrones de nombres de columnas, tipos de datos compatibles y muestreo estadístico seguro de metadatos. 2) Glosario de negocio versionable: permite cargar y consultar un archivo declarativo (YAML o JSON) versionado en Git donde analistas y desarrolladores documentan el significado de tablas crípticas, columnas abreviadas y códigos de dominio (por ejemplo, EST_3 = cliente moroso), inyectando este contexto automáticamente cuando la IA inspecciona o consulta dichas tablas."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Exploración Segura de Catálogos y Metadatos de Esquema (Priority: P1)

Como agente de inteligencia artificial o analista de datos, necesito explorar la estructura integral de una base de datos legacy (tablas, vistas, columnas, tipos de datos, nulabilidad y restricciones existentes) consultando exclusivamente los catálogos del sistema sin leer filas completas de datos de usuario, para comprender la topología del modelo relacional de forma eficiente, rápida y sin riesgo de filtración ni sobrecarga operativa.

**Why this priority**: Es el cimiento esencial de cualquier flujo de descubrimiento. En bases de datos legacy con cientos o miles de tablas y esquemas complejos, intentar deducir el esquema ejecutando `SELECT *` o leyendo registros no solo viola los principios de seguridad y privacidad en memoria, sino que degrada el rendimiento del motor y expone datos sensibles al contexto del modelo.

**Independent Test**: Puede probarse de manera aislada invocando las herramientas MCP de inspección de esquema (`list_tables`, `describe_table`) sobre instancias de SQL Server y PostgreSQL, verificando que la respuesta entregue la lista completa de tablas y la definición técnica de columnas (nombres, tipos nativos, precisión, nulabilidad, llaves primarias declaradas) extrayendo la información exclusivamente de vistas de catálogo (`INFORMATION_SCHEMA` y catálogos nativos del motor), sin disparar consultas de selección sobre las tablas de usuario ni emitir lecturas de filas de datos.

**Acceptance Scenarios**:

1. **Given** un catálogo con esquemas múltiples y tablas de usuario, **When** el agente invoca la herramienta de listado de tablas (`list_tables`) con o sin filtro de esquema, **Then** el servidor retorna la colección de nombres de tablas y vistas clasificadas por esquema, su tipo de objeto y el conteo aproximado de registros proveniente de estadísticas del catálogo, sin haber ejecutado sentencias de lectura sobre las tablas.
2. **Given** una tabla específica con diversas columnas y tipos de datos, **When** el agente solicita su estructura (`describe_table`), **Then** el servidor devuelve la especificación formal de todas las columnas (nombre, tipo de dato base, si admite nulos, posición ordinal, si forma parte de la clave primaria o de índices existentes), sin transferir contenido de registros de negocio.
3. **Given** una base de datos legacy con nombres de objetos que contienen caracteres reservados, espacios o mayúsculas/minúsculas mixtas, **When** se ejecuta la exploración de metadatos, **Then** los identificadores son resueltos de forma canónica y escapados según el dialecto del motor, previniendo errores de resolución o interpretaciones ambiguas.
4. **Given** un intento de explorar objetos protegidos o tablas del sistema interno del motor, **When** se procesa la solicitud de catálogo, **Then** el servidor filtra los objetos de administración interna restringidos, retornando únicamente los esquemas y tablas autorizados para el rol de usuario de solo lectura.

---

### User Story 2 - Motor Heurístico de Inferencia de Relaciones y Llaves Foráneas Virtuales (Priority: P1)

Como ingeniero de datos o agente de IA que diseña consultas analíticas, necesito que el sistema detecte e infiera automáticamente relaciones probables y claves foráneas implícitas entre tablas que carecen de restricciones formales de integridad referencial en el motor, analizando patrones de nomenclatura de columnas, compatibilidad de tipos de datos y realizando un muestreo estadístico seguro de metadatos, para formular consultas con joins correctos y precisos sin requerir intervención manual constante.

**Why this priority**: En sistemas legados es común que los desarrolladores históricos omitieran la creación de llaves foráneas formales (`FOREIGN KEY`) en el motor por motivos de desempeño o negligencia arquitectónica. Sin un motor heurístico de inferencia, la IA desconoce cómo vincular tablas crípticas o genera cruces incorrectos (e.g. joins cartesianos o enlaces por campos incompatibles).

**Independent Test**: Puede probarse configurando un esquema de prueba deliberadamente desprovisto de claves foráneas declaradas pero con convenciones típicas de nomenclatura (e.g., `pedidos.id_cliente` y `clientes.id`, o `fac_encabezado.cod_cli` y `mae_clientes.cod_cli`), invocando la herramienta de inferencia de relaciones (`infer_table_relationships`), y verificando que el motor produzca hipótesis de unión detallando: tabla origen, columna origen, tabla destino, columna destino, nivel de confianza (High, Medium, Low), puntaje numérico (0.0 a 1.0) y la justificación algorítmica de la coincidencia (patrón léxico, compatibilidad tipada y consistencia estadística de cardinalidad).

**Acceptance Scenarios**:

1. **Given** dos tablas sin FK formal donde la tabla dependiente posee una columna coincidente léxicamente con la clave primaria o identidad de la tabla principal (ej. `ordenes.cliente_id` y `clientes.id`), **When** se ejecuta el análisis heurístico de relaciones, **Then** el motor identifica la relación probable, valida la compatibilidad estricta de sus tipos de datos (e.g. `INTEGER` con `INTEGER`) y asigna una ponderación de confianza alta con su respectivo desglose explicativo.
2. **Given** dos tablas con nombres de columnas potencialmente análogos pero con tipos de datos manifiestamente incompatibles (ej. `facturas.fecha_pago` de tipo `DATE` y `calendario.codigo` de tipo `VARCHAR(10)`), **When** se evalúa la heurística, **Then** el motor descarta la relación o le asigna penalización severa impidiendo que se sugiera un enlace inválido.
3. **Given** una hipótesis de relación con similitud moderada en nomenclatura, **When** se aplica la validación estadística de cardinalidad, **Then** el servidor ejecuta comprobaciones de metadatos y muestreo no bloqueante (e.g. verificación de unicidad en la tabla principal y no-nulabilidad representativa) para ratificar si los valores de la columna hija están contenidos en el dominio de la columna candidata padre, ajustando el puntaje de confianza final sin generar un escaneo secuencial masivo en tablas grandes.
4. **Given** un umbral mínimo de confianza configurable (ej. 0.70), **When** se devuelven las relaciones inferidas, **Then** solo se entregan aquellas hipótesis cuyo puntaje supere dicho umbral, agrupando las sugerencias por orden de relevancia para evitar saturar el contexto de la IA con conjeturas débiles.

---

### User Story 3 - Glosario de Negocio Versionable en Git e Inyección Automática de Contexto (Priority: P2)

Como analista funcional, arquitecto de software o agente de IA, necesito cargar y mantener un glosario de términos de negocio estructurado en formato declarativo (YAML o JSON) versionado en el repositorio Git del proyecto, y que dicho contexto de negocio (significado de tablas crípticas, columnas abreviadas y catálogos de códigos de dominio) se inyecte de manera automática y transparente cada vez que la IA inspecciona metadatos o prepara una consulta, para garantizar una interpretación certera de datos heredados sin ambigüedades.

**Why this priority**: Los nombres de tablas y columnas en bases de datos legacy suelen ser herméticos, abreviados o responder a jerga obsoleta (e.g., tabla `TB_CLI_MSTR_01`, columna `IND_EST_REC`, código `EST_3 = cliente moroso`). El conocimiento de negocio reside tradicionalmente en la memoria de los desarrolladores; tenerlo centralizado en Git enriquece a la IA en tiempo de ejecución, eliminando errores de interpretación de estados y códigos de negocio.

**Independent Test**: Puede probarse creando un archivo `glossary.yaml` en el repositorio con anotaciones semánticas para tablas crípticas, columnas y enumeraciones de dominio. Al invocar las herramientas de exploración (`describe_table`, `search_glossary` o la inspección heurística), se verifica que el servidor combine la metadata física con las definiciones de negocio correspondientes, encapsuladas en delimitadores estructurales seguros, y que los cambios en el archivo del glosario se reflejen de inmediato sin necesidad de recompilar la aplicación.

**Acceptance Scenarios**:

1. **Given** un archivo de glosario válido (`glossary.yaml` o `glossary.json`) ubicado en el repositorio con documentación de tablas, columnas y códigos de estado (e.g., `TBL_CTA_CTE` = "Cuentas Corrientes Bancarias", `EST_CTA` con valores `01=Activa`, `02=Bloqueada`, `03=Cancelada`), **When** la IA invoca `describe_table` sobre `TBL_CTA_CTE`, **Then** la respuesta contiene tanto los tipos de datos técnicos como las descripciones humanas y el catálogo de códigos inyectado de forma estructurada.
2. **Given** una consulta o exploración donde la IA solicita buscar términos conceptuales (ej. "dónde están las deudas o morosidad de clientes"), **When** se invoca la herramienta de consulta de glosario (`search_glossary`), **Then** el sistema localiza las entidades y columnas asociadas a dichos conceptos de negocio mediante búsqueda semántica/léxica en el glosario versionado, devolviendo los nombres de tabla y columna físicos correspondientes.
3. **Given** un archivo de glosario con sintaxis YAML/JSON corrupta o errores de esquema declarativo, **When** el servidor carga o recarga el archivo, **Then** reporta un error de validación claro indicando la línea y causa de falla, manteniendo en memoria la última versión válida operativa sin interrumpir el funcionamiento general del servidor.
4. **Given** texto o valores en el glosario introducidos por usuarios que contengan instrucciones en lenguaje natural o caracteres sospechosos, **When** se inyectan en la respuesta hacia el cliente MCP, **Then** todo el contenido se envuelve en delimitadores estructurales de datos no confiables (Principio III: Cero Confianza en los Datos), impidiendo ataques de *prompt injection* indirecto.

---

### Edge Cases

- **Catálogos con decenas de miles de columnas u objetos**: Bases de datos legacy masivas con esquemas hipertrofiados o esquemas ERP (ej. SAP / Dynamics) con miles de tablas. El servidor debe admitir filtros por patrón (glob / regex) y paginación en `list_tables` para no desbordar el contexto ni agotar la memoria.
- **Identificadores comunes y homónimos débiles**: Nombres de columna hiper-frecuentes como `id`, `codigo`, `status`, `fecha`, `tipo`, `descripcion` presentes en decenas de tablas no relacionadas. El motor heurístico debe descartar uniones automáticas entre columnas genéricas si no van acompañadas de coincidencia de prefijo, sufijo o contexto de entidad padre (e.g. no relacionar `pedidos.status` con `productos.status` como si fuera una clave foránea).
- **Discrepancia entre el glosario y el esquema físico real**: Tablas o columnas descritas en el archivo de glosario que fueron renombradas o eliminadas físicamente en la base de datos (o viceversa). El servidor debe marcar una advertencia de sincronización (`stale_glossary_reference`) sin abortar la operación.
- **Esquemas compuestos o dependencias multi-esquema**: Relaciones entre tablas situadas en distintos esquemas de la misma base de datos (ej. `ventas.facturas` y `seguridad.usuarios`). El motor heurístico y el catálogo deben preservar la calificación completa de nombres (`esquema.tabla`).
- **Muestreo seguro en tablas masivas sin estadísticas actualizadas**: Cuando el motor carece de estadísticas recientes de catálogo y se requiere comprobación estadística de valores, el motor debe usar límites estrictos (`LIMIT` pequeño con muestreo rápido o `TABLESAMPLE` según soporte del motor) con un tiempo de espera riguroso (timeout de 1 segundo), abortando la fase estadística si excede el límite y degradando grácilmente el nivel de confianza sin bloquear la consulta.

## Requirements *(mandatory)*

### Functional Requirements

#### Exploración de Catálogo y Metadatos de Esquema

- **FR-001**: El sistema MUST exponer una herramienta MCP (`list_tables`) para listar tablas y vistas disponibles en la base de datos, permitiendo filtrar opcionalmente por nombre de esquema o patrón de búsqueda, sin ejecutar consultas sobre tablas de negocio.
- **FR-002**: El sistema MUST obtener el conteo estimado de filas y tamaño de cada tabla a partir de las estadísticas y metadatos del catálogo del motor (e.g., `sys.dm_db_partition_stats` / `sys.tables` en SQL Server y `pg_class.reltuples` en PostgreSQL), sin ejecutar operaciones de recuento completo (`COUNT(*)`).
- **FR-003**: El sistema MUST exponer una herramienta MCP (`describe_table`) que devuelva la definición técnica detallada de una tabla o vista especificada: nombres de columnas, tipos de datos nativos, longitud/precisión, condición de nulabilidad, valores por defecto, pertenencia a clave primaria e índices existentes.
- **FR-004**: Toda la información de catálogo y esquema MUST consultarse exclusivamente a través de la abstracción de `DatabaseAdapter`, delegando a las implementaciones específicas de SQL Server y PostgreSQL la lectura de sus respectivas vistas y tablas de sistema.
- **FR-005**: La exploración de esquema MUST ejecutarse bajo las credenciales de solo lectura del servidor y registrar cada operación en el log estructurado de auditoría inmutable bajo la categoría `CATALOG_DISCOVERY`.

#### Motor Heurístico de Inferencia de Relaciones

- **FR-006**: El sistema MUST incorporar un motor heurístico de inferencia de relaciones que analice pares de tablas para descubrir relaciones padre-hijo (claves foráneas implícitas) no declaradas formalmente en el motor.
- **FR-007**: El motor heurístico MUST implementar una fase de análisis léxico y de patrones de nomenclatura, detectando convenciones frecuentes como:
  - `<singular_tabla_padre>_<clave_padre>` (ej. `cliente_id`, `usuario_id`).
  - `<clave_padre>_<singular_tabla_padre>` (ej. `id_cliente`, `cod_articulo`).
  - Abreviaturas y prefijos comunes en sistemas heredados (ej. `idcli` ↔ `cliente.id`, `fk_usr` ↔ `usuario.usr_id`).
- **FR-008**: El motor heurístico MUST validar la compatibilidad de tipos de datos entre las columnas candidatas (e.g., coincidencia de familias numéricas enteras, alfanuméricas de longitud comparable o UUIDs), descartando o penalizando de manera concluyente pares de tipos incompatibles.
- **FR-009**: El sistema MUST disponer de una verificación estadística segura de cardinalidad opcional y acotada, que consulte índices, catálogos estadísticos del motor o muestras mínimas y no bloqueantes de valores para verificar la hipótesis de que los valores de la columna hija pertenecen al universo de la clave candidata padre.
- **FR-010**: El motor MUST calcular un puntaje de confianza normalizado entre `0.0` y `1.0` (clasificado en niveles: `HIGH` $\ge 0.85$, `MEDIUM` $\ge 0.65$, `LOW` $< 0.65$), acompañando cada inferencia de un desglose explicativo de factores (similitud léxica, correspondencia de tipos, evidencia estadística).
- **FR-011**: El sistema MUST exponer una herramienta MCP (`infer_table_relationships`) que permita obtener las relaciones inferidas para una tabla específica o para un conjunto acotado de tablas, filtrando resultados por un umbral de confianza mínimo configurable.

#### Glosario de Negocio Versionable en Git

- **FR-012**: El sistema MUST soportar la definición de un glosario de negocio declarativo en un archivo estructurado (formato YAML o JSON) almacenado y versionado en el repositorio Git del proyecto (ruta predeterminada: `docs/glossary.yaml` o configurable por variable de entorno).
- **FR-013**: El esquema del glosario de negocio MUST permitir documentar a nivel de entidad (tabla/vista) y atributo (columna):
  - Descripción conceptual en lenguaje natural del propósito de la tabla.
  - Descripción semántica y significado de nombres de columnas abreviados o crípticos.
  - Diccionario de valores de dominio o códigos de enumeración (e.g. `EST_01: Activo`, `EST_02: Suspendido`, `EST_03: Moroso`).
  - Sinónimos o términos de negocio alternativos para facilitar búsquedas.
- **FR-014**: El sistema MUST validar la estructura sintáctica del archivo de glosario al inicializarse y recargarlo automáticamente ante modificaciones en el sistema de archivos (o vía comando de recarga), notificando errores de sintaxis sin detener el servicio MCP.
- **FR-015**: El sistema MUST inyectar automáticamente el contexto de negocio aplicable cuando la IA invoque `describe_table` o herramientas de exploración de esquema, enriqueciendo las columnas y tablas coincidentes con sus descripciones humanas y códigos de estado.
- **FR-016**: El sistema MUST exponer una herramienta MCP (`search_glossary`) para que la IA y los usuarios puedan consultar el glosario por conceptos o palabras clave de negocio, recuperando las tablas, columnas y códigos físicos asociados.
- **FR-017**: Todo dato, descripción o valor proveniente del glosario o del muestreo de metadatos MUST ser delimitado estructuralmente como datos no confiables antes de su serialización al cliente MCP (Principio III: Cero Confianza en los Datos).

### Key Entities *(include if feature involves data)*

- **TableMetadata**: Representación técnica de un objeto relacional (tabla o vista), incluyendo esquema, nombre físico, tipo de objeto, estimación aproximada de filas según estadísticas del catálogo y metadatos de almacenamiento.
- **ColumnMetadata**: Especificación técnica de una columna física: nombre, posición ordinal, tipo de dato nativo del motor, tamaño máximo, precisión, escala, si admite nulos, si forma parte de la clave primaria y si posee índices o restricciones.
- **InferredRelationship**: Hipótesis de vínculo referencial entre dos tablas, conteniendo tabla origen/columna origen (hija/clave foránea virtual), tabla destino/columna destino (padre/clave candidata), puntaje numérico de confianza (`0.0` a `1.0`), nivel cualitativo (`HIGH`, `MEDIUM`, `LOW`) y matriz de razones justificativas (patrón léxico, compatibilidad tipada, soporte estadístico).
- **BusinessGlossary**: Estructura declarativa en memoria cargada desde YAML/JSON versionado en Git, conteniendo el catálogo de entidades de negocio, descripciones de tablas, mapeo semántico de columnas crípticas y diccionarios de códigos de dominio.
- **DomainCodeMapping**: Diccionario de pares código-valor (ej. clave `EST_3`, valor `Cliente Moroso - Con saldo vencido > 90 días`) asociado a una columna específica.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: La herramienta `list_tables` lista el catálogo completo de hasta 500 tablas en menos de 1.5 segundos, extrayendo el 100% de la metadata estructural de vistas del sistema y estadísticas del catálogo sin transferir filas de datos de usuario.
- **SC-002**: La herramienta `describe_table` retorna la definición estructural completa y enriquecida con el glosario de negocio en menos de 100 milisegundos por tabla.
- **SC-003**: El motor heurístico infiere con precisión al menos el 85% de las relaciones implícitas reales documentadas en la suite de esquemas legacy de prueba, manteniendo una tasa de falsos positivos por debajo del 10% para inferencias clasificadas en nivel `HIGH` o `MEDIUM`.
- **SC-004**: El 100% de las descripciones del glosario de negocio y valores de metadatos muestreados se entregan al cliente MCP encapsulados en delimitadores estructurales seguros, neutralizando vectores de inyección de prompts indirectos.
- **SC-005**: Las actualizaciones realizadas en el archivo declarativo del glosario (`glossary.yaml` / `glossary.json`) son detectadas y asimiladas en memoria en menos de 500 milisegundos tras el guardado en disco, sin requerir reinicio del servidor MCP.
- **SC-006**: Toda consulta de exploración y muestreo heurístico se ejecuta bajo privilegios estrictos de solo lectura y queda registrada con trazabilidad completa en la auditoría inmutable estructurada.

## Assumptions

- **Compatibilidad de Catálogos**: Se asume que las credenciales de base de datos configuradas para el servidor MCP poseen permisos de lectura (`VIEW DEFINITION` / `SELECT` en esquemas del sistema y `INFORMATION_SCHEMA`) en SQL Server y PostgreSQL.
- **Formato del Glosario**: El glosario de negocio residirá por defecto en un archivo YAML en la ruta del repositorio (`docs/glossary.yaml` o `.specify/glossary.yaml`), existiendo fallback a formato JSON (`docs/glossary.json`) si se prefiere.
- **Estrategia de Muestreo Heurístico No Invasiva**: Para evitar impacto en tablas gigantescas, el muestreo estadístico del motor heurístico priorizará siempre las estadísticas del motor (densidad de índices y conteo de valores nulos/distintos en catálogos del sistema); de requerirse muestreo directo de valores para verificar intersección de dominio, este se limitará estrictamente a una muestra de tamaño fijo (máximo 100 filas o `TABLESAMPLE` equivalente) con un timeout de ejecución no superior a 1 segundo.
- **Persistencia en Git**: La edición del glosario se realiza mediante el flujo estándar de desarrollo en Git (commits, pull requests, revisiones de código), garantizando trazabilidad y auditoría de cambios del negocio mediante el historial de Git.
