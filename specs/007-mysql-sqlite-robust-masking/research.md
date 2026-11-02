# Phase 0 Research: Conectores MySQL/MariaDB, SQLite y Enmascaramiento Robusto de Variaciones Sensibles

**Feature**: `007-mysql-sqlite-robust-masking`
**Date**: 2026-11-02
**Status**: Completed

---

## 1. Conectividad y Adaptadores de Base de Datos

### Decisión 1: Conector y Driver para MySQL y MariaDB
- **Decisión**: Utilizar `mysql2/promise` como driver subyacente para el `MySqlAdapter`.
- **Racional**:
  - `mysql2` es el estándar en el ecosistema Node.js para MySQL (5.7, 8.0, 8.4) y MariaDB (10.x, 11.x).
  - Soporta promesas nativas (async/await), sentencias preparadas con parámetros tipados binarios (evitando inyecciones SQL), y expone el `threadId` de la conexión activa.
  - Permite configurar fácilmente `sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'` en la inicialización de la conexión.
  - Ofrece compatibilidad con el analizador sintáctico `node-sql-parser` (dialectos `'mysql'` y `'mariadb'`).
- **Alternativas descartadas**:
  - `mysql` (antiguo): Descartado por no tener soporte nativo moderno de promesas ni mantenimiento activo para métodos de autenticación recientes (`caching_sha2_password`).
  - `mariadb`: Descartado para evitar duplicar dependencias de drivers independientes; `mysql2` maneja el protocolo de cable común para ambos motores con alta eficiencia.

### Decisión 2: Conector y Driver para SQLite
- **Decisión**: Utilizar `better-sqlite3` con modo de apertura estricto de solo lectura (`{ readonly: true, fileMustExist: true }`).
- **Racional**:
  - Es el motor de SQLite más rápido, robusto y testeado en Node.js, ejecutado de forma síncrona en C++ sin el overhead de hilos de red.
  - El flag `readonly: true` activa `SQLITE_OPEN_READONLY` a nivel del motor en C, garantizando que el propio motor SQLite rechace cualquier operación de mutación antes de que toque disco.
  - Expone el método nativo `db.interrupt()` que aborta inmediatamente cualquier consulta en ejecución en caso de timeout o cancelación.
  - Valida que el archivo exista en disco (`fileMustExist: true`), impidiendo la creación accidental de archivos vacíos ante rutas incorrectas.
- **Alternativas descartadas**:
  - `node:sqlite` (Node.js 22 built-in): Descartado porque la especificación del proyecto admite `node >= 20.0.0` y `node:sqlite` sigue marcado como experimental en Node 22+.
  - `sqlite3` (callback-based): Descartado por arquitectura asíncrona heredada y menor rendimiento comparado con `better-sqlite3`.
  - `sql.js` (WASM): Descartado por requerir cargar toda la base de datos en memoria WebAssembly, ineficiente para archivos medianos o grandes en disco.

---

## 2. Cancelación Real y Control de Recursos (Principio II)

### Decisión 3: Estrategia de Cancelación Real en MySQL / MariaDB con Límite ≤ 500 ms
- **Decisión**: Arquitectura híbrida de cancelación:
  1. **Directiva nativa de timeout**: Al ejecutar la consulta, el adaptador inyecta el hint de optimizador `/*+ MAX_EXECUTION_TIME(timeoutMs) */` en MySQL 8+ o configura `SET STATEMENT max_statement_time = (timeoutMs/1000) FOR SELECT ...` en MariaDB.
  2. **Watchdog reactivo con canal auxiliar de control**: Un pool o conexión auxiliar de control almacena el mapeo `connection.threadId`. Si el `AbortSignal` del cliente o el temporizador del servidor MCP expira antes de recibir la respuesta, el canal de control emite de inmediato `KILL QUERY <threadId>`.
- **Racional**:
  - Cumple estrictamente con el mandato constitucional de "Cancelación Real en el Motor": la consulta no continúa corriendo en segundo plano saturando CPU ni manteniendo bloqueos de lectura.
  - Garantiza que la finalización de la consulta en el motor se complete en ≤ 500 ms tras expirar el timeout, liberando los recursos de inmediato.
- **Alternativas descartadas**:
  - Solo desconectar el socket del cliente: Violación directa del Principio II de la Constitución (el servidor continuaría procesando la consulta huérfana).

---

## 3. Arquitectura del Motor de Detección Léxica y Enmascaramiento

### Decisión 4: Pipeline de Segmentación Morfológica y Clasificación Binaria
- **Decisión**: Implementar un pipeline determinista de 5 capas con evaluación de caja negra contra `corpus/column-name-sensitivity-corpus.json`:
  - **Capa 0 (Normalización Canónica)**:
    - Conversión a minúsculas, eliminación de espacios en extremos.
    - Tokenización por delimitadores (`_`, `-`, espacios) y transiciones camelCase/PascalCase mediante `(?<=[a-z0-9])(?=[A-Z])`.
    - Colapso de secuencias de letras aisladas (`n_i_t` → `nit`).
  - **Capa 1 (Diccionario Seguro de Palabras Benignas - Filtro Anti-Falsos Positivos)**:
    - Verificación inmediata contra `SafeVocabularyDictionary`: si un token o término completo coincide con palabras legítimas (`unit`, `unit_price`, `units`, `monitor`, `benito`, `definition`, `nitrate`, `ignite`, `granite`, `thumbnail`, `chainmail`, `cocktail`, `celebrity_id`, `salient_feature`, `salad_type`), se clasifica de forma concluyente como `none` (no sensible, 0 % falsos positivos garantizado, nunca entra a la zona de fail-safe).
  - **Capa 2 (Segmentación de Concatenaciones sin Separador y Catálogo de Prefijos)**:
    - Uso del `UnifiedPrefixCatalog`: prefijos organizacionales (`emp`, `gal`, `cli`, `prov`, `usr`, `cust`, `tit`, `cta`, `dep`, `suc`, `doc`), prefijos técnicos (`t1`, `col`, `v`, `tbl`) y abreviaturas (`no`, `num`, `nro`, `id`, `tax`), extensible vía `MASKING_CUSTOM_PREFIXES`.
    - Para cadenas continuas (ej. `empnit`, `galempnit`, `clinit`, `nitempleado`, `nitno`):
      - Si comienza con uno o más prefijos conocidos y el resto es una raíz sensible conocida (`nit`, `dpi`, `email`, `tel`, `sueldo`, `monto`) → Clasificar deterministamente como sensible (los términos de salario/sueldo se mapean a la categoría canónica `amount`).
      - Si comienza con una raíz sensible (`nit`) y el resto es un sufijo común (`empleado`, `cliente`, `empresa`, `titular`, `no`, `num`) → Clasificar deterministamente como sensible.
  - **Capa 3 (Segunda Línea de Defensa: Patrón de Contenido Celda a Celda con Checksum)**:
    - Para columnas que no alcanzaron coincidencia por nombre (p. ej. alias opacos `SELECT empnit AS codigo_ref` o expresiones `CONCAT(empnit, '')`), se evalúan los valores de las celdas contra los patrones de formato (`formatMaskedNit`, DPI, email, teléfono, monto).
    - Para `nit`, se exige formato estructurado con guion obligatorio (`\b\d{2,8}-[0-9kK]\b`) o verificación mediante algoritmo Módulo 11 de la SAT guatemalteca para longitudes de 6 a 10 dígitos, previniendo falsos positivos sobre años (ej. 2024), códigos postales o enteros generales.
    - **Regla inquebrantable**: La señal de contenido NUNCA puede anular ni des-enmascarar una columna que ya fue clasificada como sensible por su nombre.
  - **Capa 4 (Frontera Estricta de Decisión y Política Fail-Safe)**:
    - `none`: Términos del `SafeVocabularyDictionary` o columnas sin indicios sensibles.
    - `deterministic`: Coincidencia léxica o de prefijo/sufijo verificada.
    - `low_confidence_fail_safe`: Exclusivo para nombres no presentes en el diccionario seguro que presenten indicios morfológicos ambiguos, enmascarando preventivamente en memoria y registrando en `audit.jsonl` un evento `low_confidence_match` sin exponer datos crudos.
- **Racional**:
  - Elimina la necesidad de heurísticas probabilísticas o aproximadas (fuzzy matching no acotado) que provocaban falsos positivos en palabras cortas como `unit` frente a `nit`.
  - Asegura un comportamiento 100 % verificable: 100 % de casos sensibles enmascarados y 0 % de falsos positivos en el corpus oficial.

---

## 4. Gestión de Privacidad y Sesión

### Decisión 5: Ciclo de Vida de Sesión y HMAC-SHA256 para Pseudonimización
- **Decisión**:
  - `SessionContext` administra un salt criptográfico efímero de 32 bytes (`crypto.randomBytes(32)`), generado en memoria en el arranque del proceso del servidor MCP.
  - La pseudonimización de identificadores (NIT, DPI, etc.) se calcula como `pseudo_<tipo>_<hex16>` mediante HMAC-SHA256 sobre el valor normalizado.
  - El salt reside únicamente en la memoria RAM del proceso; nunca se persiste en disco ni se incluye en logs.
  - Dentro de la misma sesión, el mapeo es determinista para permitir cruces federados y correlación de registros por la IA. Al reiniciarse el servidor MCP, un nuevo salt hace que todos los hashes cambien, previniendo trazabilidad a largo plazo o ataques de tablas rainbow.

---

## 5. Introspección y Consistencia Transversal

### Decisión 6: Exclusión Categórica de Datos Crudos en Metadatos de Introspección
- **Decisión**:
  - En las herramientas MCP `describe_table` e `introspect_schema`, cada columna analizada es procesada por el `LexicalColumnAnalyzer`.
  - Si la columna es identificada como sensible:
    - Se agrega en los metadatos: `sensitive_type: "nit"` (o la categoría correspondiente) y `is_masked: true`.
    - Se suprimen categóricamente las muestras de valores reales (`sample_values: []`).
- **Racional**:
  - Permite a la IA comprender la semántica del campo en bases legadas con nombres abreviados (`galempnit`) sin filtrar información sensible a través de la herramienta de descripción del catálogo.
