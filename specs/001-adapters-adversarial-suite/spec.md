# Feature Specification: Base Arquitectónica de Adaptadores y Suite Adversaria de Seguridad

**Feature Branch**: `001-adapters-adversarial-suite`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "Base arquitectónica de adaptadores y suite adversaria de seguridad. El servidor MCP consulta bases de datos relacionales desacoplando el núcleo de los motores específicos mediante un contrato estricto (DatabaseAdapter) que abstrae cuatro operaciones: verificación de permisos de solo lectura del usuario de conexión, análisis de plan de ejecución normalizado a un perfil de riesgo común (banderas de full scan, join sin condición, filas y costo estimado), ejecución de consultas parametrizadas con cancelación nativa en el motor mediante señal de aborto, e introspección de esquema. SQL Server (T-SQL) y PostgreSQL son los dos adaptadores iniciales y deben superar exactamente la misma suite de pruebas. Incluye un corpus adversario en formato estructurado que se ejecuta en integración continua (CI) en cada cambio y sirve para evaluar parsers de SQL candidatos; ningún ataque conocido puede pasar. El corpus inicial debe cubrir como mínimo estos 10 vectores: 1) consultas encadenadas con punto y coma (stacked queries), 2) creación de tablas encubierta con SELECT INTO, 3) ofuscación mediante comentarios de bloque e inline (-- y /* */), 4) CTEs con escritura en PostgreSQL (WITH ... DELETE/UPDATE RETURNING), 5) llamadas a funciones administrativas o de lectura de archivos en PostgreSQL (pg_terminate_backend, pg_read_file), 6) bloqueo explícito de filas (SELECT ... FOR UPDATE), 7) evasión hacia servidores vinculados en SQL Server mediante OPENQUERY, OPENROWSET o nombres de cuatro partes, 8) ejecución de procedimientos en T-SQL sin punto y coma (SELECT 1 EXEC ...), 9) denegación de servicio con WAITFOR DELAY encadenado, y 10) alteración de sesión o comandos internos con SET y DBCC."

## Clarifications

### Session 2026-10-30

- Q: ¿Cómo debe tratar el validador de seguridad las consultas que contienen comentarios SQL (`--` o `/* */`) fuera de literales de texto? (FR-011) → A: Rechazo estricto: Bloquear inmediatamente toda consulta que contenga comentarios inline (`--`) o de bloque (`/* */`) fuera de cadenas de texto literales.
- Q: ¿Cómo debe representarse el campo `estimatedCost` dentro del perfil de riesgo común (`NormalizedRiskProfile`) dado que SQL Server y PostgreSQL calculan costos en unidades internas distintas? (FR-005) → A: Valor nativo del optimizador: `estimatedCost` devuelve el número exacto reportado por el plan de ejecución del motor (`number >= 0`), y los umbrales máximos se configuran por cada conexión/motor.
- Q: ¿Cómo debe realizar cada adaptador la verificación de permisos de solo lectura (*preflight check*) al iniciar la conexión con la base de datos? (FR-003) → A: Inspección de permisos efectivos en catálogo + sesión de solo lectura: Consultar en los metadatos del motor los privilegios efectivos del usuario (incluyendo herencia de roles y esquema `public`/`guest`) y configurar la sesión en modo solo lectura cuando el motor lo soporte.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Validación Continua contra el Corpus Adversario de Seguridad (Priority: P1)

Como mantenedor de seguridad y auditor, necesito un corpus estructurado de ataques SQL que se ejecute automáticamente ante cada cambio del sistema y permita evaluar objetivamente cualquier analizador sintáctico de SQL candidato y cada adaptador de motor, para garantizar que ningún ataque conocido pueda evadir la política de solo lectura ni comprometer los servidores de producción.

**Why this priority**: De acuerdo con la Constitución del proyecto (Principio VI), ninguna funcionalidad ni elección de analizador sintáctico puede darse por válida sin antes definir y superar el corpus adversario. Es la base que protege todo el ciclo de vida del producto.

**Independent Test**: Se puede probar de forma independiente cargando el archivo estructurado del corpus adversario y ejecutándolo contra el evaluador de seguridad para verificar que el 100% de los casos de ataque (en los 10 vectores obligatorios) resulten bloqueados con una categoría de rechazo explícita, mientras que un conjunto de control de consultas `SELECT` legítimas sea permitido.

**Acceptance Scenarios**:

1. **Given** el corpus adversario estructurado con casos para SQL Server (T-SQL) y PostgreSQL, **When** se ejecuta la suite de validación en el flujo de integración continua (CI), **Then** el 100% de las consultas de los 10 vectores de ataque son rechazadas antes de llegar a ejecutarse como consultas de datos y el reporte detalla el resultado por vector y dialecto.
2. **Given** dos o más analizadores sintácticos de SQL candidatos bajo evaluación, **When** se someten al mismo corpus adversario estructurado, **Then** el sistema produce una matriz comparativa de aciertos y fallos por cada uno de los 10 vectores de ataque que permite seleccionar el analizador con cero falsos negativos.
3. **Given** una consulta maliciosa que utiliza ofuscación por comentarios (`--` o `/* */`), ejecución en T-SQL sin punto y coma (`SELECT 1 EXEC ...`) o CTEs con escritura (`WITH ... DELETE/UPDATE ... RETURNING`), **When** es evaluada por la suite de seguridad, **Then** es detectada y rechazada sin excepción.

---

### User Story 2 - Operación Unificada en SQL Server y PostgreSQL mediante Contrato de Adaptador (Priority: P1)

Como administrador de bases de datos (DBA), necesito que el servidor interactúe con SQL Server (T-SQL) y PostgreSQL a través de un contrato único y estricto (`DatabaseAdapter`) que abstraiga la verificación de permisos de solo lectura, el análisis normalizado del plan de ejecución, la ejecución parametrizada con cancelación real en el motor y la introspección de esquema, para asegurar que ambos motores ofrezcan idénticas garantías operativas y de seguridad.

**Why this priority**: SQL Server y PostgreSQL son los dos motores iniciales requeridos para operar sobre bases de datos empresariales y legacy. Sin este contrato y sus dos adaptadores iniciales verificados bajo la misma suite de pruebas, el servidor no puede conectarse de forma segura a ningún entorno real.

**Independent Test**: Se puede probar ejecutando exactamente la misma batería de pruebas de contrato y seguridad contra el adaptador de SQL Server y contra el adaptador de PostgreSQL, comprobando que ambos responden con las estructuras normalizadas esperadas en las cuatro operaciones del contrato.

**Acceptance Scenarios**:

1. **Given** una cuenta de base de datos en SQL Server o PostgreSQL que posee algún permiso de modificación (`INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `CREATE` o ejecución de procedimientos con efectos secundarios), **When** el adaptador ejecuta la operación de verificación de permisos de solo lectura en el arranque, **Then** la verificación falla e impide que el servidor inicie operaciones con esa conexión.
2. **Given** una consulta `SELECT` válida en SQL Server o PostgreSQL, **When** se solicita el análisis del plan de ejecución al adaptador sin ejecutar la consulta, **Then** el adaptador devuelve un perfil de riesgo común y normalizado que indica explícitamente si existe escaneo completo de tabla (*full scan*), *join* sin condición (producto cartesiano), el número de filas estimadas y el costo estimado.
3. **Given** una consulta parametrizada en ejecución en SQL Server o PostgreSQL, **When** se emite una señal de aborto por exceso de tiempo o cancelación, **Then** el adaptador solicita la cancelación nativa de la consulta directamente en el motor de base de datos, liberando los recursos del servidor de inmediato.
4. **Given** una base de datos conectada en SQL Server o PostgreSQL, **When** se invoca la operación de introspección de esquema del adaptador, **Then** el adaptador retorna el catálogo normalizado de tablas, vistas, columnas, tipos de datos, nulabilidad y llaves primarias/foráneas declaradas sin leer filas completas de las tablas.

---

### User Story 3 - Extensibilidad para Nuevos Motores sin Modificar el Núcleo (Priority: P2)

Como contribuidor del proyecto, quiero agregar soporte para un nuevo motor de base de datos relacional implementando únicamente el contrato `DatabaseAdapter` y validándolo contra la suite compartida de pruebas de contrato y seguridad, para extender el alcance del servidor sin modificar ni poner en riesgo el núcleo de seguridad.

**Why this priority**: Garantiza el principio de desacoplamiento por contrato (Principio VII de la Constitución) y permite que el proyecto crezca mediante contribuciones manteniendo inalteradas las garantías del núcleo (Historia 11).

**Independent Test**: Se puede probar registrando un adaptador simulado o de un tercer motor que cumpla el contrato `DatabaseAdapter` y verificando que el núcleo del servidor ejecute las cuatro operaciones y la suite adversaria sin requerir ningún cambio ni condicional específico de motor dentro del núcleo.

**Acceptance Scenarios**:

1. **Given** el núcleo del servidor y la definición del contrato `DatabaseAdapter`, **When** se inspecciona o ejecuta el flujo central de validación y consulta con un nuevo adaptador conforme al contrato, **Then** el núcleo opera íntegramente a través de las cuatro operaciones abstractas sin referencias directas al motor subyacente.
2. **Given** un nuevo adaptador implementado por un contribuidor, **When** se registra en el arnés de pruebas del proyecto, **Then** hereda y debe superar automáticamente la suite completa de pruebas de contrato y el corpus adversario aplicable antes de ser aceptado.

---

### Edge Cases

- ¿Qué sucede cuando una consulta contiene literales de texto legítimos que incluyen secuencias similares a comentarios o palabras reservadas (por ejemplo, `WHERE descripcion = 'Texto con -- guiones y SELECT INTO'`)? El sistema debe distinguir entre la estructura léxica/sintáctica de la consulta y el contenido de un literal o parámetro, rechazando de forma estricta cualquier comentario real fuera de literales pero permitiendo predicados válidos cuyos literales o parámetros contengan esos caracteres.
- ¿Qué sucede si la señal de aborto se dispara justo antes de que la consulta sea enviada al motor o inmediatamente después de que el motor terminó de responder? El adaptador debe manejar la condición de carrera de forma limpia sin dejar conexiones huérfanas, bloqueadas o en estado inconsistente en el pool.
- ¿Qué sucede cuando el usuario de base de datos tiene permisos de solo lectura a nivel de rol directo, pero hereda permisos de escritura a través de un grupo, rol público (`public` / `db_datawriter`) o esquema secundario? La verificación de permisos de solo lectura debe inspeccionar los permisos efectivos reales de la sesión conectada en todo el catálogo accesible, no solo las asignaciones directas del usuario.
- ¿Qué sucede cuando el motor de base de datos no puede generar un plan de ejecución estimado (por ejemplo, por referencias a objetos inexistentes o sintaxis inválida para ese motor)? El adaptador debe capturar el error de planificación, no ejecutar la consulta y reportar un fallo controlado sin exponer credenciales ni detalles sensibles de la infraestructura.
- ¿Qué sucede con vectores específicos de un dialecto (como `WAITFOR DELAY` o nombres de cuatro partes en T-SQL, o `WITH ... DELETE RETURNING` en PostgreSQL) cuando se evalúan en modo agnóstico o en el dialecto opuesto? Ningún ataque del corpus puede ser clasificado como consulta segura en ningún modo: o bien es rechazado por la regla de seguridad del vector o bien es rechazado por invalidez sintáctica estricta.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema MUST definir un contrato estricto de adaptador de base de datos (`DatabaseAdapter`) como única frontera de comunicación entre el núcleo del servidor y cualquier motor de base de datos relacional.
- **FR-002**: El núcleo del sistema MUST NOT contener lógica condicional, consultas de catálogo ni manejo de errores acoplados directamente a un motor específico; toda interacción MUST fluir por las cuatro operaciones del contrato `DatabaseAdapter`.
- **FR-003**: El contrato `DatabaseAdapter` MUST abstraer una operación de **verificación de permisos de solo lectura** (*preflight check*) que inspeccione en los catálogos del motor los privilegios efectivos del usuario de conexión (incluyendo permisos heredados por roles, grupos o esquemas compartidos como `public`/`guest`), configure la sesión en modo solo lectura cuando el motor lo soporte, y rechace sin realizar pruebas destructivas cualquier conexión que posea permisos de escritura, alteración de esquema, administración o ejecución de rutinas con efectos secundarios.
- **FR-004**: El contrato `DatabaseAdapter` MUST abstraer una operación de **análisis de plan de ejecución** que obtenga la estimación del optimizador del motor sin ejecutar la consulta de datos y la transforme en un **perfil de riesgo común normalizado** (`NormalizedRiskProfile`).
- **FR-005**: El perfil de riesgo común normalizado (`NormalizedRiskProfile`) MUST incluir como mínimo: bandera booleana de escaneo completo de tabla (`hasFullScan`), bandera booleana de *join* sin condición o producto cartesiano (`hasUnconditionalJoin`), cantidad de filas estimadas (`estimatedRows`) y el costo numérico nativo reportado por el optimizador del motor (`estimatedCost`, número `>= 0` evaluable frente a umbrales configurables por conexión/motor).
- **FR-006**: El contrato `DatabaseAdapter` MUST abstraer una operación de **ejecución de consultas parametrizadas** que reciba el texto SQL validado, una colección de parámetros estrictamente tipados (nunca interpolados en el texto SQL) y una señal de aborto (`AbortSignal`), garantizando que la activación de dicha señal dispare la cancelación nativa de la consulta en ejecución dentro del motor de base de datos.
- **FR-007**: El contrato `DatabaseAdapter` MUST abstraer una operación de **introspección de esquema** que recupere de los metadatos del catálogo la estructura de tablas, vistas, columnas (nombre, tipo de dato, nulabilidad) y relaciones declaradas (llaves primarias y foráneas) en un formato común normalizado, sin realizar lecturas de filas completas de las tablas de usuario.
- **FR-008**: El sistema MUST proveer dos implementaciones iniciales completas del contrato `DatabaseAdapter`: una para **SQL Server (T-SQL)** y otra para **PostgreSQL**.
- **FR-009**: Tanto el adaptador de SQL Server como el adaptador de PostgreSQL MUST ejecutarse y validarse contra una única suite compartida de pruebas de contrato y seguridad, exigiendo el cumplimiento del 100% de las aserciones para ambos motores.
- **FR-010**: El repositorio MUST incluir un **corpus adversario de seguridad** almacenado en un formato estructurado legible por máquina y versionable, donde cada caso de prueba especifique al menos: identificador único, vector de ataque (1 al 10), dialecto objetivo (`tsql`, `postgres` o `common`), consulta SQL maliciosa, resultado esperado (`REJECT`) y razón o categoría de rechazo esperada.
- **FR-011**: El corpus adversario estructurado MUST cubrir como mínimo los siguientes **10 vectores de ataque obligatorios**:
  1. Consultas encadenadas con punto y coma (*stacked queries*).
  2. Creación de tablas encubierta mediante `SELECT INTO`.
  3. Presencia u ofuscación mediante comentarios inline (`--`) y de bloque (`/* */`) fuera de literales de texto (rechazo estricto de cualquier comentario).
  4. Expresiones de tabla comunes (CTEs) con escritura en PostgreSQL (`WITH ... DELETE/UPDATE/INSERT ... RETURNING`).
  5. Llamadas a funciones administrativas o de lectura/escritura de archivos en PostgreSQL (tales como `pg_terminate_backend`, `pg_cancel_backend`, `pg_read_file`, `pg_ls_dir`, `lo_import`, `lo_export`).
  6. Bloqueo explícito de filas o tablas (tales como `SELECT ... FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE` o hints de bloqueo equivalentes).
  7. Evasión hacia servidores vinculados o fuentes remotas en SQL Server mediante `OPENQUERY`, `OPENROWSET`, `OPENDATASOURCE` o nombres de objetos de cuatro partes (`servidor.base.esquema.tabla`).
  8. Ejecución de procedimientos en T-SQL sin punto y coma (por ejemplo, `SELECT 1 EXEC sp_...` o `EXEC` implícito).
  9. Denegación de servicio mediante instrucciones de retardo encadenadas o embebidas (tales como `WAITFOR DELAY`, `WAITFOR TIME` o `pg_sleep`).
  10. Alteración de estado de sesión o ejecución de comandos internos del motor mediante sentencias `SET` (ej. `SET ROWCOUNT`, `SET TRANSACTION ISOLATION LEVEL`) y `DBCC`.
- **FR-012**: El sistema MUST incluir un corredor automatizado del corpus adversario que se ejecute obligatoriamente en integración continua (CI) en cada cambio y falle la construcción si cualquier ataque del corpus pasa sin ser bloqueado o si cualquier consulta `SELECT` legítima de control es rechazada erróneamente.
- **FR-013**: El corredor del corpus adversario MUST permitir evaluar analizadores sintácticos (parsers) de SQL candidatos contra la totalidad del corpus, generando un reporte verificable y visible en el repositorio con la cobertura de bloqueo por cada uno de los 10 vectores para respaldar la selección del parser con datos objetivos.

### Key Entities *(include if feature involves data)*

- **`DatabaseAdapter` (Contrato de Adaptador)**: Interfaz formal que define las cuatro operaciones obligatorias que todo motor relacional soportado debe implementar: verificación de solo lectura, análisis de plan de ejecución, ejecución parametrizada cancelable e introspección de esquema.
- **`NormalizedRiskProfile` (Perfil de Riesgo Normalizado)**: Estructura de datos común e independiente del motor que resume el plan de ejecución estimado mediante indicadores booleanos de escaneo completo (`hasFullScan`), unión sin condición (`hasUnconditionalJoin`), cantidad de filas estimadas (`estimatedRows`) y valor numérico nativo de costo del optimizador del motor (`estimatedCost`).
- **`ParameterizedQuery` (Consulta Parametrizada)**: Representación de una sentencia `SELECT` validada junto con sus parámetros tipados separados del texto SQL y su señal de cancelación asociada.
- **`SchemaCatalog` (Catálogo de Esquema Normalizado)**: Representación agnóstica del motor que describe las tablas, vistas, columnas, tipos de datos y llaves primarias/foráneas descubiertas mediante introspección de metadatos.
- **`AdversarialTestCase` (Caso de Prueba Adversario)**: Registro estructurado dentro del corpus de ataques que contiene el identificador del caso, el vector de ataque (1 a 10), el dialecto aplicable, el payload SQL malicioso y el criterio de rechazo esperado.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El **100% de los ataques** incluidos en el corpus adversario estructurado (cubriendo al menos los 10 vectores obligatorios con múltiples variantes por vector) son bloqueados antes de ejecutar cualquier consulta de datos en las pruebas automatizadas de integración continua (CI).
- **SC-002**: El **100% de las consultas `SELECT` legítimas** de la batería de control (incluyendo filtros parametrizados, agregaciones, subconsultas de solo lectura y CTEs puramente de lectura) son aceptadas sin falsos positivos en ambos dialectos (SQL Server y PostgreSQL).
- **SC-003**: Ante una señal de aborto emitida durante una consulta de larga duración en SQL Server o PostgreSQL, la consulta activa se cancela de forma efectiva dentro del motor de base de datos en **menos de 1 segundo** desde que se dispara la señal.
- **SC-004**: El 100% de las pruebas de la suite compartida de contrato pasan de manera idéntica tanto en el adaptador de SQL Server como en el adaptador de PostgreSQL.
- **SC-005**: Un contribuidor puede incorporar un tercer adaptador de motor de prueba e integrarlo a la suite de validación con **0 líneas de código modificadas** en los módulos del núcleo del servidor.

## Assumptions

- Los entornos de prueba e integración continua cuentan con instancias efímeras o contenedores aislados de SQL Server y PostgreSQL (o dobles de prueba de protocolo para pruebas unitarias rápidas más contenedores reales para pruebas de integración de contrato) donde se pueden verificar tanto cuentas con permisos de solo lectura como cuentas con permisos de escritura para comprobar el rechazo en el *preflight check*.
- Para el vector 3 (comentarios inline y de bloque), toda consulta que contenga comentarios `--` o `/* ... */` fuera de literales de texto será rechazada de forma estricta antes de pasar al motor de base de datos.
- El corpus adversario inicial contendrá al menos 3 variantes representativas por cada uno de los 10 vectores obligatorios (mínimo 30 casos adversarios iniciales más casos de control legítimos), almacenados en un archivo estructurado versionado en el repositorio.
