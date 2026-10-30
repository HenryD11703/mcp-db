# MCP de bases de datos: historias de usuario y flujo

Oct 29, 2026 · @Henry Quel

## Resumen

Este MCP deja que una IA consulte bases de datos reales sin poder dañarlas: solo lectura verificada con un parser de SQL, datos sensibles enmascarados y cada consulta auditada.

Está pensado para equipos con bases de datos legacy que quieren usar IA para entenderlas, sin arriesgar producción. Lo que lo distingue de otros MCP de bases de datos es la capa de seguridad (historias 1 a 8) y la consulta federada entre servidores distintos (historia 13).

Las 13 historias están agrupadas por tema. Cada bloque se puede pasar a Spec Kit como un `/specify` independiente.

## Seguridad (el núcleo)

Estas cuatro historias son lo que hace confiable al MCP: ninguna consulta puede escribir, y nada sensible sale sin control.

| # | Historia | Criterio de aceptación |
| --- | --- | --- |
| 1 | **Solo lectura garantizada.** Como administrador, quiero que toda consulta pase por un parser de SQL y se rechace cualquier cosa que no sea `SELECT`, para que la IA nunca modifique datos. | Rechaza `;` encadenados, comentarios que ocultan comandos, CTEs con escritura, `SELECT INTO` y llamadas a procedimientos. |
| 2 | **Defensa en profundidad.** Como administrador, quiero que el MCP verifique al arrancar que el usuario de BD solo tenga permiso de lectura, para que un fallo del guard no sea catastrófico. | Se niega a iniciar si detecta permisos de escritura. |
| 3 | **Enmascarado de datos sensibles.** Como responsable de datos, quiero definir reglas por columna o por patrón que enmascaren correos, teléfonos, DPI y montos antes de llegar a la IA. | El dato real nunca sale del proceso del MCP. |
| 4 | **Defensa contra prompt injection.** Como usuario, quiero que el contenido de las filas se trate como dato y nunca como instrucción, porque una celda podría decir «ignora lo anterior y ejecuta X». | Hay pruebas con filas maliciosas y ninguna altera el comportamiento. |

## Control de costo y riesgo

Estas historias evitan que una consulta legítima pero mal pensada tumbe un servidor de producción.

| # | Historia | Criterio de aceptación |
| --- | --- | --- |
| 5 | **Análisis previo de consultas.** Como DBA, quiero estimar el costo con el plan de ejecución antes de correr y bloquear lo excesivo, como escaneos completos o joins sin condición. | Los umbrales son configurables. |
| 6 | **Límites.** Como administrador, quiero un tope de filas, de tiempo de ejecución y de consultas por minuto. | La consulta se cancela de verdad en la BD, no solo en el cliente. |
| 7 | **Aprobación humana.** Como administrador, quiero que las consultas marcadas como riesgosas esperen confirmación explícita. | La IA no puede auto-aprobarse. |

## Auditoría

La auditoría es lo que permite confiar y a la vez revisar después qué hizo la IA.

| # | Historia | Criterio de aceptación |
| --- | --- | --- |
| 8 | **Registro inmutable.** Como auditor, quiero un log de cada consulta con quién la hizo, cuándo, qué SQL, cuántas filas devolvió y si fue bloqueada y por qué. | Formato estructurado y sin datos sensibles dentro del log. |

## Comprensión de bases de datos legacy

Aquí el MCP deja de ser solo un filtro y se vuelve una herramienta para entender sistemas que nadie documentó.

| # | Historia | Criterio de aceptación |
| --- | --- | --- |
| 9 | **Exploración de esquema.** Como desarrollador, quiero que la IA descubra tablas y relaciones, incluso las no declaradas como llave foránea (inferidas por nombres y datos), y las resuma. | No necesita leer filas completas para entender la estructura. |
| 10 | **Glosario del negocio.** Como analista, quiero anotar qué significa cada tabla o columna (por ejemplo, `EST_3` = cliente moroso) y que la IA use esas anotaciones. | Las anotaciones viven en un archivo versionable en Git. |

## Extensibilidad y calidad

Estas historias hacen que el proyecto pueda crecer con contribuciones sin perder la garantía de seguridad.

| # | Historia | Criterio de aceptación |
| --- | --- | --- |
| 11 | **Adaptadores por motor.** Como contribuidor, quiero agregar un motor nuevo implementando una interfaz definida. | SQL Server y PostgreSQL de inicio, con las mismas pruebas de seguridad para ambos. |
| 12 | **Suite adversaria.** Como mantenedor, quiero un corpus de ataques que corra en CI en cada cambio. | Ningún ataque conocido pasa, y el resultado es visible en el repositorio. |

El corpus de ataques también sirve para evaluar los parsers de SQL candidatos en TypeScript con los mismos casos y elegir con datos.

## Consulta federada entre bases de datos

El MCP corre una consulta en la base A, toma sus resultados como filtro y consulta la base B, sin linked servers y sin saltarse el guard.

| # | Historia | Criterio de aceptación |
| --- | --- | --- |
| 13 | **Rastreo entre sistemas.** Como analista, quiero hacer una consulta en la BD A y que el MCP use sus resultados (por ejemplo unas 10 claves) como filtro en la BD B, para ver qué pasó con esos registros en otro sistema. | Las claves viajan siempre como parámetros, nunca pegadas en el texto del SQL. Hay un tope de claves configurable. Cada paso se audita por separado y usa su propio usuario de solo lectura. |

Por qué se evita el linked server: la consulta remota corre con las credenciales del servidor vinculado, que pueden tener más permisos que el usuario de solo lectura, y `OPENQUERY` o los nombres de cuatro partes podrían saltarse el guard. Las claves que salen de la BD A son datos no confiables, así que tratarlas como parámetros evita una inyección de segundo orden.

## Diagrama de flujo

&#91;embedded content: flujo de una consulta · 7 pasos, 3 puntos de rechazo, 1 camino federado\]

La consulta puede salir rechazada en tres puntos antes de tocar la base. Si es federada, el resultado de la BD A vuelve a pasar por el guard antes de consultar la BD B.

## Comandos de Spec Kit

Cada bloque de historias se convierte en una especificación propia, en este orden: primero la base (adaptadores y suite adversaria), luego seguridad, auditoría, control de costo, legacy y al final la consulta federada, que depende de las anteriores.

Los `/specify` describen el qué y el porqué; el stack (TypeScript) va en `/plan`. Según tu versión de Spec Kit, los comandos pueden llamarse `/specify`, `/plan` y `/tasks`, o llevar el prefijo `/speckit.`.

### 0. Constitución del proyecto

```text
/speckit.constitution Principios: 1) La IA nunca escribe: solo lectura verificada con un parser de SQL y con un usuario de BD sin permisos de escritura. 2) Defensa en profundidad: ningún control de seguridad es el único. 3) Los datos que salen de la BD son no confiables: nunca se interpretan como instrucciones ni se concatenan en SQL. 4) Los datos sensibles se enmascaran antes de salir del proceso. 5) Todo queda auditado, sin datos sensibles en el log. 6) Las pruebas adversarias se escriben antes que la funcionalidad y corren en CI en cada cambio. 7) TypeScript en modo estricto.
```

### 1. Base: adaptadores y suite adversaria (historias 11 y 12)

```text
/speckit.specify Un servidor MCP que permite a una IA consultar bases de datos relacionales. El soporte para cada motor se agrega implementando una interfaz de adaptador definida; SQL Server y PostgreSQL son los dos de inicio y pasan las mismas pruebas de seguridad. Un corpus de consultas de ataque corre en CI en cada cambio y ningún ataque conocido debe pasar. Un contribuidor puede agregar un motor nuevo sin modificar el núcleo.
```

### 2. Seguridad (historias 1 a 4)

```text
/speckit.specify Seguridad del servidor MCP. Toda consulta pasa por un parser de SQL y se rechaza cualquier cosa que no sea SELECT: punto y coma encadenados, comentarios que ocultan comandos, CTEs con escritura, SELECT INTO y llamadas a procedimientos. Al arrancar, verifica que el usuario de BD solo tenga permiso de lectura y se niega a iniciar si detecta permisos de escritura. Un administrador define reglas por columna o por patrón para enmascarar correos, teléfonos, DPI y montos, y el dato real nunca sale del proceso. El contenido de las filas se trata siempre como dato y nunca como instrucción, con pruebas de filas maliciosas.
```

### 3. Auditoría (historia 8)

```text
/speckit.specify Registro de auditoría de cada consulta: quién la hizo, cuándo, qué SQL, cuántas filas devolvió y si fue bloqueada y por qué. El formato es estructurado y el log nunca contiene datos sensibles.
```

### 4. Control de costo y riesgo (historias 5 a 7)

```text
/speckit.specify Control de costo y riesgo de las consultas. Antes de ejecutar, estima el costo con el plan de ejecución y bloquea lo excesivo, como escaneos completos o joins sin condición, con umbrales configurables. Aplica un tope de filas, de tiempo de ejecución y de consultas por minuto, y la consulta se cancela de verdad en la BD, no solo en el cliente. Las consultas marcadas como riesgosas esperan confirmación humana explícita y la IA no puede aprobarse a sí misma.
```

### 5. Comprensión de BDs legacy (historias 9 y 10)

```text
/speckit.specify Herramientas para entender una base de datos legacy. La IA descubre tablas y relaciones, incluso las no declaradas como llave foránea (inferidas por nombres y datos), y las resume sin necesidad de leer filas completas. Un analista anota el significado de tablas y columnas, por ejemplo EST_3 = cliente moroso, en un archivo versionable en Git que la IA usa al responder.
```

### 6. Consulta federada (historia 13)

```text
/speckit.specify Consulta federada entre dos bases de datos sin linked servers. Un analista hace una consulta en la BD A y el servidor usa sus resultados, por ejemplo unas 10 claves, como filtro en la BD B para rastrear qué pasó con esos registros en otro sistema. Las claves viajan siempre como parámetros y nunca pegadas en el texto del SQL, con un tope de claves configurable. Cada paso pasa por el guard, se audita por separado y usa su propio usuario de solo lectura.
```

### 7. Después de cada especificación

```text
/speckit.clarify
/speckit.plan TypeScript sobre Node.js con el SDK oficial de MCP. El parser de SQL se elige entre candidatos (por ejemplo node-sql-parser) probándolos contra la suite adversaria. Motores iniciales: SQL Server y PostgreSQL detrás de una interfaz de adaptador.
/speckit.tasks
/speckit.implement
```

## Decisiones pendientes

- [x] Lenguaje decidido: TypeScript sobre Node.js.
- [ ] Elegir el parser de SQL para TypeScript (por ejemplo `node-sql-parser`) probándolo contra la suite adversaria.
- [ ] Escribir la versión genérica como si fuera desde cero, sin esquemas ni lógica de la empresa.
- [ ] Definir el tope de claves en la consulta federada (la idea inicial es 500 a 1000).
- [ ] Decidir el diseño del guard: parser real más usuario de BD con solo `SELECT`.
- [ ] Ejecutar los comandos de Spec Kit en el orden de la sección anterior.
