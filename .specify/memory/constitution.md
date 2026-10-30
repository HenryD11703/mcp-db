<!--
Sync Impact Report
- Version change: N/A (uninitialized template) → 1.0.0
- Modified principles:
  - [PRINCIPLE_1_NAME] → I. Solo Lectura Inquebrantable (La IA Nunca Escribe)
  - [PRINCIPLE_2_NAME] → II. Defensa en Profundidad
  - [PRINCIPLE_3_NAME] → III. Cero Confianza en los Datos (Zero-Trust Data Handling)
  - [PRINCIPLE_4_NAME] → IV. Privacidad en Memoria
  - [PRINCIPLE_5_NAME] → V. Auditoría Estructurada Inmutable
- Added sections:
  - Principle VI. Desarrollo Guiado por Pruebas Adversarias (NON-NEGOTIABLE)
  - Principle VII. Desacoplamiento por Contrato (DatabaseAdapter)
  - Restricciones Tecnológicas y de Arquitectura (replaces [SECTION_2_NAME])
  - Flujo de Desarrollo y Compuertas de Calidad (replaces [SECTION_3_NAME])
- Removed sections: None
- Follow-up TODOs: None
-->
# db-mcp-node Constitution

## Core Principles

### I. Solo Lectura Inquebrantable (La IA Nunca Escribe)
Toda consulta MUST validarse mediante un parser de SQL (AST) tras eliminar o rechazar comentarios inline y de bloque, garantizando que el nodo raíz sea exclusivamente `SELECT` sin efectos secundarios (rechazando sentencias encadenadas con `;`, CTEs con escritura, `SELECT INTO` y llamadas a procedimientos almacenados). Este control MUST estar respaldado por un usuario de base de datos sin permisos de escritura verificado obligatoriamente en el arranque (*preflight check*), negándose el servidor a iniciar si detecta privilegios de modificación.

### II. Defensa en Profundidad
Ningún control de seguridad MUST depender de una sola capa. Todo riesgo crítico —escritura no autorizada, exfiltración de información sensible, inyección SQL o de prompts, y degradación del servicio por consultas costosas— MUST mitigarse mediante controles independientes y superpuestos: validación AST en el guard, privilegios mínimos en el motor de base de datos, estimación previa de plan de ejecución, límites estrictos de recursos y confirmación humana explícita para consultas riesgosas.

### III. Cero Confianza en los Datos (Zero-Trust Data Handling)
Los valores provenientes de la base de datos MUST tratarse siempre como datos no confiables. Nunca MUST interpretarse como instrucciones —envolviéndose en delimitadores estructurales contra *prompt injection* indirecto antes de entregarse al modelo— ni MUST concatenarse jamás en texto SQL, viajando estrictamente como parámetros tipados en cualquier consulta subsecuente o federada.

### IV. Privacidad en Memoria
Los datos sensibles (correos electrónicos, teléfonos, identificadores personales como DPI, montos u otros definidos por columna o patrón) MUST enmascararse o pseudonimizarse dentro del proceso antes de serializar la respuesta hacia el cliente MCP. Se permite realizar cruces federados en memoria utilizando los valores reales únicamente dentro del espacio de memoria del proceso, garantizando que el dato crudo nunca abandone el servidor MCP ni aparezca en la salida final.

### V. Auditoría Estructurada Inmutable
Toda ejecución o rechazo de consulta MUST quedar registrado en un log estructurado e inmutable que capture quién realizó la solicitud, cuándo ocurrió, el SQL evaluado, cuántas filas devolvió y, en caso de bloqueo, la causa exacta del rechazo. Los registros de auditoría MUST NOT exponer datos sensibles ni valores crudos provenientes de las filas consultadas.

### VI. Desarrollo Guiado por Pruebas Adversarias (NON-NEGOTIABLE)
El corpus de ataques (inyecciones SQL, evasión mediante comentarios inline o de bloque, CTEs con mutación, *prompt injection* en celdas y consultas de denegación de servicio) MUST definirse antes de dar por válida cualquier funcionalidad y MUST ejecutarse en integración continua (CI) en cada cambio. Ningún ataque conocido del corpus puede pasar, y todos los adaptadores de motor MUST superar la misma batería de pruebas de seguridad.

### VII. Desacoplamiento por Contrato (DatabaseAdapter)
El núcleo del servidor MCP MUST permanecer agnóstico a motores de base de datos específicos; MUST interactuar únicamente mediante una interfaz `DatabaseAdapter` escrita en TypeScript en modo estricto (`strict: true`). El soporte para cada motor (iniciando con SQL Server y PostgreSQL) se implementa detrás de este contrato sin modificar el núcleo del sistema.

## Restricciones Tecnológicas y de Arquitectura

- **Lenguaje y Tipado**: El proyecto MUST desarrollarse en TypeScript sobre Node.js con el compilador en modo estricto (`strict: true`) y utilizando el SDK oficial de MCP.
- **Federación sin Linked Servers**: Las consultas federadas entre bases de datos MUST coordinarse desde el proceso del MCP tomando las claves del origen como parámetros tipados hacia el destino, con un tope configurable de claves, validación en el guard en cada paso, auditoría independiente y credenciales de solo lectura propias por cada base de datos. Queda prohibido el uso de *linked servers* u `OPENQUERY`.
- **Control de Costo y Cancelación Real**: Toda consulta MUST respetar topes configurables de costo de plan de ejecución, número máximo de filas, tiempo de ejecución y tasa de consultas por minuto. Cuando se exceda el tiempo límite, la consulta MUST cancelarse de forma efectiva en el motor de base de datos y no únicamente en el cliente.

## Flujo de Desarrollo y Compuertas de Calidad

- **Secuencia de Especificación**: El desarrollo con Spec Kit MUST respetar el orden de dependencias arquitectónicas: 1) Base (adaptadores y suite adversaria), 2) Seguridad, 3) Auditoría, 4) Control de costo y riesgo, 5) Comprensión de bases de datos legacy y 6) Consulta federada.
- **Verificación en CI**: Ningún cambio se considera válido si no compila bajo TypeScript estricto o si falla algún caso del corpus de pruebas adversarias en CI.
- **Aprobación Humana**: Las consultas marcadas como riesgosas por el analizador de costos o políticas MUST esperar confirmación humana explícita; la IA tiene prohibido auto-aprobarse.

## Governance

Esta Constitución prevalece sobre cualquier otra práctica, especificación o decisión técnica del proyecto.

- **Procedimiento de Enmienda**: Cualquier modificación a estos principios requiere documentar la justificación técnica, evaluar el impacto en la seguridad y en la suite adversaria, y actualizar las plantillas o especificaciones afectadas.
- **Política de Versionado**: La Constitución sigue versionado semántico (`MAJOR.MINOR.PATCH`):
  - `MAJOR`: Eliminación o redefinición incompatible de algún principio inquebrantable o reducción de garantías de seguridad.
  - `MINOR`: Adición de nuevos principios, secciones o expansión sustancial de controles obligatorios.
  - `PATCH`: Aclaraciones de redacción, correcciones tipográficas o refinamientos no semánticos.
- **Revisión de Cumplimiento**: Todo artefacto generado mediante `/speckit-specify`, `/speckit-plan`, `/speckit-tasks` y `/speckit-implement` MUST verificar explícitamente la conformidad con los siete principios fundamentales definidos en este documento.

**Version**: 1.0.0 | **Ratified**: 2026-10-30 | **Last Amended**: 2026-10-30
