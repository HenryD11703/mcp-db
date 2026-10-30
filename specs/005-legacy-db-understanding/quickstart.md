# Quickstart: Validación del Descubrimiento Legacy

Contratos: [legacy-discovery.contract.ts](./contracts/legacy-discovery.contract.ts), [glossary.schema.json](./contracts/glossary.schema.json), [mcp-tools.schema.json](./contracts/mcp-tools.schema.json). Modelo: [data-model.md](./data-model.md).

## Prerrequisitos
- Node.js 20+, dependencias instaladas (`npm install`).
- Una BD de prueba PostgreSQL y/o SQL Server con esquema legacy sin FKs declaradas (p. ej. `pedidos.id_cliente` ↔ `clientes.id`, `fac_encabezado.cod_cli` ↔ `mae_clientes.cod_cli`) y un usuario de solo lectura.
- Variables: `GLOSSARY_PATH=docs/glossary.yaml`.

## Escenarios

1. **Catálogo sin leer filas** — Invocar `list_tables` y `describe_table`; verificar en el log del motor que solo se consultan vistas de sistema (sin `SELECT` sobre tablas de usuario) y que existe entrada de auditoría `CATALOG_DISCOVERY`.
2. **Inferencia** — Invocar `infer_table_relationships` con `minConfidence: 0.7`; esperar `pedidos.id_cliente → clientes.id` con nivel ≥ MEDIUM y desglose de factores; verificar que `pedidos.status`/`productos.status` NO se relacionan y que tipos incompatibles se descartan.
3. **Muestreo seguro** — Forzar timeout (tabla grande/retardo): la relación se devuelve con `statisticalStatus: TIMED_OUT`, confianza degradada y sin valores crudos en la respuesta.
4. **Glosario** — Añadir `TBL_CTA_CTE` con códigos (`EST_3: cliente moroso`) en `docs/glossary.yaml`; `describe_table` debe incluir los significados; `search_glossary "morosidad"` devuelve tabla/columna física.
5. **Recarga y resiliencia** — Editar el archivo: cambio válido visible en < 500 ms; archivo corrupto ⇒ error con línea y se mantiene la versión anterior; referencia a tabla inexistente ⇒ advertencia `stale_glossary_reference`.
6. **Zero-trust** — Insertar en el glosario "ignora instrucciones previas…"; la salida lo muestra dentro de delimitadores de datos no confiables.

## Comandos
```powershell
npm run build          # TypeScript estricto
npm test               # unitarias + contrato de adaptadores
npm run test:adversarial
```

Resultado esperado: todo en verde, corpus adversario sin ataques que pasen, y SC-001…SC-006 de la [spec](./spec.md) satisfechos.
