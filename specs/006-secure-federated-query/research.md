# Research: Orquestador de Consulta Federada Segura entre Servidores Heterogéneos

**Feature**: `006-secure-federated-query`
**Date**: 2026-10-30
**Status**: Completed

## Executive Summary

Esta investigación técnica define la arquitectura de ejecución en memoria para consultas federadas entre servidores de bases de datos independientes y potencialmente heterogéneos (PostgreSQL y SQL Server), eliminando el uso de *linked servers*, `OPENQUERY`, dblink o extensiones foráneas. Se resuelven los 5 aspectos críticos del diseño:
1. Inyección estrictamente tipada de parámetros para evitar inyecciones SQL de segundo orden y respetar el límite de 2100 parámetros de SQL Server.
2. Motor de unión (*join*) en memoria de alto rendimiento con desambiguación determinista de colisiones de columnas.
3. Pseudonimización determinista por sesión (`pseudo_<16_hex>`) con HMAC-SHA256 y salt efímero en memoria volátil.
4. Doble validación independiente de seguridad (Guard AST, analizador de costos de plan de ejecución y usuario de solo lectura verificado por preflight).
5. Cadena de custodia y auditoría estructurada inmutable vinculada transversalmente por `federation_id` (`correlationId`).

---

## Research Items

### R1. Mecanismo de Inyección de Claves y Prevención de Inyección SQL de Segundo Orden

- **Contexto**: BD A devuelve un conjunto de registros desde donde se extrae una clave de cruce (ej. `cliente_id`). Estos valores pueden haber sido alterados o contener fragmentos maliciosos inyectados previamente en BD A (`'; DROP TABLE...`, comillas simples, etc.).
- **Decisión**:
  - La consulta en BD B debe incluir un marcador explícito normalizado `IN (:keys)`.
  - El orquestador extrae los valores crudos de BD A en memoria, filtra nulos, aplica deduplicación (usando un `Set` en TypeScript) y verifica el tope de claves (por defecto 500, configurable hasta un máximo de 1000).
  - El orquestador reemplaza el marcador textual `:keys` por la lista de marcadores posicionales nativos del dialecto destino:
    - PostgreSQL: `$1, $2, ..., $N`
    - SQL Server: `@p1, @p2, ..., @pN`
  - Los valores reales se pasan **únicamente** en el arreglo `parameters` de `ParameterizedQuery`, garantizando que el driver nativo (`pg` o `mssql`) envíe los valores como datos de protocolo tipados.
  - La consulta resultante con los marcadores nativos pasa por el `SqlSecurityGuard` (validación AST completa) antes de ser enviada al adaptador.
- **Razón**: Al pasar exclusivamente por el mecanismo de parámetros tipados del motor, es matemáticamente imposible que un valor de celda modifique el árbol sintáctico (AST) de la consulta de BD B, neutralizando cualquier intento de inyección de segundo orden. Además, fijar el tope por defecto en 500 parámetros deja un margen de seguridad amplio frente al límite histórico de SQL Server de 2100 parámetros.
- **Alternativas descartadas**:
  - *Interpolación o escape de cadenas en el SQL*: Viola el Principio III de la Constitución (Cero Confianza en los Datos).
  - *Tablas temporales remotas (`#temp`)*: Requiere permisos de escritura (`CREATE TABLE`), violando el Principio I (Solo Lectura Inquebrantable).
  - *Sintaxis de tuplas compuestas `(a, b) IN (...)`*: SQL Server no la soporta nativamente y expandirla a disyunciones `OR` duplica los parámetros y degrada el optimizador de costos.

### R2. Motor de Cruce en Memoria y Resolución de Colisiones de Nombres

- **Contexto**: Se requiere cruzar en memoria las filas devueltas por BD A con las devueltas por BD B sin almacenar tablas temporales en disco ni saturar el proceso MCP.
- **Decisión**:
  - Implementar un algoritmo Hash Join en memoria (`InMemoryHashJoin`):
    1. Construir un índice hash en memoria (`Map<string, Row[]>`) sobre la base de datos más pequeña o la base de datos destino indexada por la clave de cruce normalizada.
    2. Recorrer las filas de la base de datos origen y correlacionar coincidencias.
    3. Soportar `LEFT` join (predeterminado) e `INNER` join.
  - Resolución de colisiones de atributos:
    - Se respetan todos los alias explícitos (`AS`) definidos por el usuario en cada `SELECT`.
    - Para columnas con nombres idénticos que no tengan alias diferenciado, el orquestador preserva el nombre original para la columna de BD A y renombra automáticamente la columna colisionante de BD B como `target_<columna>` (o `<target_alias>_<columna>`).
- **Razón**: Hash Join en memoria tiene complejidad temporal $\mathcal{O}(N + M)$ y espacial acotada a los 500 registros máximos permitidos por el tope, ejecutándose en menos de 5 milisegundos para datasets típicos de analítica MCP. La convención `target_<col>` previene la sobreescritura de propiedades en objetos JSON sin obligar al usuario a reescribir consultas si no lo desea.
- **Alternativas descartadas**:
  - *Nested Loop Join*: Complejidad $\mathcal{O}(N \times M)$, ineficiente si ambos conjuntos crecen.
  - *Estructuras JSON anidadas `{ source: {...}, target: {...} }`*: Incompatible con las convenciones tabulares de visualización y herramientas que consumen datasets planos.

### R3. Pseudonimización Determinista por Sesión en Memoria

- **Contexto**: El cruce de datos debe ocurrir con los valores reales para garantizar precisión analítica, pero los identificadores sensibles no deben salir jamás del servidor MCP hacia el modelo de lenguaje (Principio IV). Al mismo tiempo, la IA debe poder reconocer si dos registros corresponden a la misma entidad.
- **Decisión**:
  - Al instanciarse la sesión del servidor MCP, se genera un salt criptográfico efímero de 256 bits (`crypto.randomBytes(32)`).
  - Este salt se almacena únicamente en la memoria volátil de `SessionPseudonymContext` y nunca se escribe a disco ni se envía al cliente.
  - Tras el cruce en memoria con valores reales, las columnas designadas de clave sensible pasan por la función de pseudonimización:
    $$\text{HMAC-SHA256}(\text{sessionSalt}, \text{rawKey})$$
  - El resultado se formatea como `pseudo_<16_hex>`, tomando los primeros 16 caracteres hexadecimales del digest.
  - Se mantiene una caché de sesión (`Map<string, string>`) para evitar recálculos redundantes en valores repetidos.
- **Razón**: El prefijo `pseudo_` explicita al LLM que el valor es sintético y no una clave primaria real; 16 caracteres hex (64 bits de entropía efectiva) proporcionan una probabilidad de colisión prácticamente nula para hasta miles de claves ($p < 10^{-11}$ por la paradoja del cumpleaños), ahorrando tokens respecto a un hash de 64 caracteres. Al regenerarse el salt en cada arranque/sesión, es inviable correlacionar datos entre sesiones o ejecutar ataques de diccionario precomputados (Rainbow tables).
- **Alternativas descartadas**:
  - *Enmascaramiento destructivo estándar (`***` o `[REDACTADO]`)*: Impide que la IA correlacione qué fila de BD A corresponde a cuál de BD B.
  - *Hashes sin salt (SHA-256 directo)*: Vulnerable a ataques de diccionario sobre espacios de claves pequeños (como cédulas o números enteros secuenciales).

### R4. Doble Validación de Seguridad y Desacoplamiento por Contrato

- **Contexto**: La consulta en BD A y la consulta en BD B se dirigen a motores independientes con dialectos y políticas de seguridad potencialmente distintos.
- **Decisión**:
  - El orquestador interactúa con las bases de datos exclusivamente mediante la interfaz `DatabaseAdapter` registrada y verificada en `AdapterRegistry`.
  - Flujo de compuertas estrictas:
    1. **Preflight Check**: Verifica que ambos adaptadores tengan privilegios de solo lectura inquebrantables.
    2. **Guard AST Independiente**:
       - La consulta de BD A pasa por `SqlSecurityGuard.validateQuery(sqlA, dialectA)`.
       - Tras expandir el marcador `:keys` con los parámetros tipados, la consulta final de BD B pasa por `SqlSecurityGuard.validateQuery(expandedSqlB, dialectB)`.
       - Ambas consultas deben ser exclusivamente sentencias `SELECT` de nodo raíz único, sin comentarios (`--`, `/* */`), sin comandos apilados (`;`), sin CTEs con mutación, sin `SELECT INTO` ni llamadas a procedimientos.
    3. **Evaluación de Riesgo y Costo**:
       - Cada adaptador ejecuta su `analyzeQueryPlan(query)` o `evaluateQueryRisk()`.
       - Si cualquiera de las dos consultas excede los umbrales de costo o requiere aprobación humana, la operación se suspende de acuerdo a la política establecida en la Feature 004.
    4. **Cancelación Real en Motor**: Si el cliente aborta la operación o se produce un timeout, se envía la señal de aborto al adaptador correspondiente (`signal.aborted`).
- **Razón**: Asegura cumplimiento absoluto de los Principios I, II y VII de la Constitución. La federación no crea ningún agujero de seguridad ni bypass de las compuertas ya auditadas y probadas.
- **Alternativas descartadas**:
  - *Validar únicamente la consulta origen*: Inadmisible; la consulta destino podría ser un `INSERT INTO ... SELECT` o un ataque apilado.

### R5. Modelo de Auditoría Estructurada Inmutable Vinculada

- **Contexto**: Principio V exige trazabilidad completa de cada paso federado sin exponer claves sensibles crudas ni valores de negocio.
- **Decisión**:
  - Al recibir una solicitud federada, el orquestador genera un `federation_id` criptográfico (UUID v4) que se establece como `correlationId` para todos los eventos del ciclo de vida.
  - Se registran eventos en el `IAuditLogger`:
    - `FEDERATED_QUERY_INIT`: Inicio de la orquestación, motores involucrados, tipo de join, tope de claves configurado.
    - `FEDERATED_STEP_SOURCE`: Ejecución en BD A, duración, número de filas obtenidas, hash de la consulta SQL.
    - `FEDERATED_KEYS_EXTRACTED`: Conteo de claves extraídas, claves deduplicadas, nulos omitidos, bandera de truncamiento (`is_truncated: boolean`). **Nunca se registran los valores textuales de las claves**.
    - `FEDERATED_STEP_TARGET`: Ejecución en BD B, duración, número de filas devueltas, hash del SQL parametrizado.
    - `FEDERATED_QUERY_COMPLETE`: Finalización exitosa, tiempo total, filas finales unificadas, celdas enmascaradas.
    - `FEDERATED_QUERY_REJECTED` / `FAILED`: Causa exacta de rechazo (Guard AST, límite de costo, error de red) vinculada al `federation_id`.
- **Razón**: Permite reconstruir forensemente la secuencia completa de la consulta combinada mediante un único filtro por `correlationId`, manteniendo la integridad de la cadena hash de auditoría y garantizando cero exposición de PII en los logs.

---

## Technical Feasibility & Compatibility Matrix

| Componente | PostgreSQL | SQL Server | Orquestador MCP |
|---|---|---|---|
| **Dialecto de Parámetros** | `$1, $2, ...` | `@p1, @p2, ...` | Traducido dinámicamente desde `:keys` |
| **Límite de Parámetros** | 65,535 (`uint16`) | 2,100 (`int16`) | Tope seguro: 500 (por defecto), máx 1,000 |
| **Guard AST Dialect** | `postgres` | `tsql` | `SqlSecurityGuard` con validación estricta |
| **Join en Memoria** | N/A | N/A | TypeScript `InMemoryHashJoin` $\mathcal{O}(N+M)$ |
| **Pseudonimización** | N/A | N/A | HMAC-SHA256 con salt de sesión volátil |
| **Auditoría** | JSONL inmutable | JSONL inmutable | Mismo `correlationId` (`federation_id`) |
