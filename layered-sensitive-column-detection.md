# Detección de columnas sensibles por capas — propuesta de diseño

## 1. Cómo funciona hoy (lectura de `src/`)

La detección de columnas sensibles vive en dos archivos:

- `src/core/security/default-masking-profile.ts`: lista fija de reglas (`DEFAULT_MASKING_RULES`), cada una con un `matcher` tipo `/(^|_)(palabra1|palabra2|...)($|_)/i`.
- `src/core/security/masking-rules.ts`: `doesColumnMatchRule()` compila el matcher y hace `regex.test(columnName)`. `compileRuleMatcher()` fuerza la bandera `i` para nombres de columna pero no toca nada más.

El motor (`data-masking-engine.ts`) solo le pregunta a cada columna "¿hay una regla de `column_name` cuyo regex haga match?" — es un único paso, basado 100% en diccionario fijo + anclas de `_`/inicio/fin de cadena. No hay normalización previa del nombre de columna, no hay puntuación de confianza, no hay fallback por contenido salvo para los tipos que ya tienen `content_pattern` (email, dpi, amount, phone).

### Tipo de dato ausente: NIT

`SensitiveDataType` en `src/contracts/security.contract.ts` es `'email' | 'phone' | 'dpi' | 'amount' | 'custom'`. **No existe `'nit'`.** Ninguna regla de `DEFAULT_MASKING_RULES` cubre `nit`, `tax_id`, `cedula`, etc. Una columna llamada `nit` hoy no se enmascara — pasa en texto plano. Esto es el hueco más importante encontrado.

### Por qué falla con variantes reales

1. **camelCase**: el ancla es literalmente el carácter `_` o el inicio/fin de la cadena completa. `correoElectronico`, `telefonoCelular`, `empSalario` no matchean porque después de la palabra clave no viene `_` ni fin de cadena, sino una mayúscula. El regex nunca separa por límites de palabra en camelCase (no usa `(?=[A-Z])` ni normaliza a snake_case antes de comparar).
2. **Prefijos/sufijos sin guión bajo**: `empEmail`, `galNit`, `nitno` fallan por la misma razón — el ancla `_` no está.
3. **Abreviaturas no listadas**: `telf`, `nro_nit`, `tax_id`, `cedula`, `n_i_t` no están en el diccionario de ninguna regla.
4. **Errores de ortografía**: `niit`, `nti`, `emial`, `corre`, `teelfono`, `salraio` no matchean nada — el enfoque es comparación exacta de palabras completas, sin tolerancia a edición (no hay distancia de Levenshtein, no hay stemming).
5. **Mezcla de idioma / sinónimos no cubiertos**: `cedula`, `national_id`, `taxid` no están en el diccionario de DPI, aunque son sinónimos reales usados en bases de datos guatemaltecas e internacionales.
6. **Falsos positivos reales si se agrega NIT de forma naive**: si el patrón para `nit` se escribe como substring sin anclas (`/nit/i`), capturaría `unit`, `unit_price`, `monitor`, `definition`, `benito` — nombres de columna o incluso nombres propios de personas en datos de prueba. Esto demuestra que el enfoque de un solo diccionario con regex no es seguro de extender sin un diseño de capas.
7. **Sin señal de contenido para columnas no reconocidas por nombre**: si una columna se llama `campo1` o `dato_x` pero contiene DPIs reales, el motor nunca mira el contenido para decidir si **la columna** debe tratarse como sensible de forma persistente — el `content_pattern` solo actúa celda por celda, no retro-alimenta la clasificación de la columna ni se usa para alertar sobre columnas no cubiertas.
8. **Todo o nada**: no hay score de confianza ni modo "flag para revisión humana" — una columna matchea una regla y se enmascara con esa estrategia, o no matchea nada y se sirve en crudo. No hay término medio para casos ambiguos (`balance_sheet_id`, `monto_total_items`).

## 2. Corpus (`corpus/column-name-sensitivity-corpus.json`)

Se creó un corpus etiquetado (`sensible` / `no_sensible`) con ~115 nombres de columna cubriendo:

- NIT, DPI/CUI, correo, teléfono, salario — en snake_case, camelCase, abreviaturas, prefijos (`emp_`, `gal_`), errores de ortografía, español e inglés.
- Falsos positivos reales: `unit`, `unit_price`, `monitor`, `benito`, `manito`, `dpid`, `thumbnail`, `chainmail`, `cocktail`, `cell_count`, `celebrity_id`, `salient_feature`, `salad_type`, y casos ambiguos (`balance_sheet_id`, `monto_total_items`).

Este corpus sirve como set de regresión para medir precisión/recall de cualquier diseño nuevo antes de reemplazar las reglas actuales.

## 3. Diseño propuesto: detección por capas

La idea central es **no depender de un único regex por tipo de dato**, sino encadenar capas de señal creciente, cada una con una confianza asociada, y combinar nombre + contenido antes de decidir.

### Capa 0 — Normalización del nombre de columna

Antes de cualquier matching, normalizar el nombre crudo a una forma canónica de "tokens":

- `camelCase` → `camel_case` (insertar `_` antes de mayúsculas internas).
- minúsculas, trim de espacios.
- separar por `_`, `-`, espacios → lista de tokens (`emp_nit` → `["emp","nit"]`, `empNit` → `["emp","nit"]`, `n_i_t` → `["n","i","t"]`, colapsar runs de una sola letra adyacentes: `["n","i","t"]` → `["nit"]`).

Esto resuelve el problema #1, #2 y #4 (parcialmente, al dar una forma consistente antes de comparar) sin cambiar el diccionario.

### Capa 1 — Diccionario exacto por token (alta confianza, barato)

Comparar cada token normalizado contra listas de sinónimos por tipo de dato (incluyendo `nit` con sus sinónimos: `nit`, `taxid`, `tax_id`→tokens `tax`,`id`, `cedula`, etc.), en vez de un regex monolítico con anclas de string completo. Un match de **token completo** (no substring) da confianza alta (p.ej. 0.9).

Esto por sí solo ya elimina los falsos positivos de substring (`unit`, `monitor`, `benito`) porque "nit" como token completo de `unit` no existe — el token es `unit`, no `nit`. Es la razón principal para preferir tokenización sobre regex de substring.

### Capa 2 — Prefijos/sufijos conocidos (confianza media-alta)

Después de quitar prefijos/sufijos organizacionales conocidos (`emp`, `gal`, `cli`, `usr`, `cust`, `no`, `num`, `nro`, `id`) de la lista de tokens, re-evaluar contra la Capa 1. Esto cubre `gal_nit`, `nit_no`, `nro_nit`, `empSalario` sin necesidad de enumerar cada combinación en el diccionario base.

### Capa 3 — Similitud difusa / tolerancia a errores (confianza media)

Para tokens que no matchean exacto en Capa 1/2, calcular distancia de edición (Levenshtein ≤1 o ≤2 según longitud) contra el diccionario canónico. Cubre `niit`, `nti`, `emial`, `corre`, `teelfono`, `salraio`. Confianza más baja que un match exacto (p.ej. 0.6), y se debe exigir una distancia relativa (no absoluta) para evitar que palabras cortas den demasiados falsos positivos (p.ej. `sal` vs `salad` a distancia 2 no debería auto-calificar; usar mínimo de longitud de token para activar fuzzy matching, y lista de exclusión explícita para palabras cortas ambiguas como `sal`, `cel`, `tel`, `unit`, `mail`-como-substring).

### Capa 4 — Señal de contenido (confianza alta, costosa, bajo muestreo)

Para columnas que no alcanzaron confianza suficiente por nombre, o para confirmar/descartar un match de baja confianza, muestrear N valores no nulos de la columna y correr los `content_pattern` ya existentes (regex de email, DPI de 13 dígitos, montos, teléfono) más validadores específicos de NIT (formato guatemalteco: dígitos + guión + dígito verificador). Si ≥X% del muestreo matchea un patrón de contenido, subir la confianza de la columna a "sensible" independientemente del nombre. Esto resuelve el problema #7 (columnas con nombre genérico pero contenido sensible) y sirve también para **bajar** la confianza de un match de nombre ambiguo si el contenido claramente no corresponde (p.ej. `balance_sheet_id` con valores tipo UUID, no montos).

### Capa 5 — Umbral y modo de decisión

Combinar las señales en un score final y mapear a tres zonas:

- **Score ≥ 0.85** → enmascarar automáticamente con la estrategia del tipo de dato (comportamiento actual, pero más preciso).
- **0.5 ≤ score < 0.85** → "ambiguo": enmascarar por defecto (fail-safe, dado que el riesgo es exponer PII) pero emitir una entrada de auditoría/log marcada `low_confidence_match` con el nombre de columna y la señal que disparó el match, para que un humano revise y pueda añadir una regla explícita (allowlist/denylist) en el perfil.
- **Score < 0.5** → no enmascarar, igual que hoy.

Esto introduce la pieza que falta hoy: **no hay término medio** (#8). El modo ambiguo es clave para no recaer en el extremo "enmascarar todo lo que suene parecido" (que rompería `unit_price`, `monitor_status`, etc.) ni en el extremo "diccionario exacto" (que deja pasar `nti`, `cedula`, `taxid`).

### Resumen de flujo

```
nombre crudo
   │
   ▼
Capa 0: normalizar a tokens
   │
   ▼
Capa 1: match exacto de token completo ──► alta confianza
   │ (sin match)
   ▼
Capa 2: quitar prefijos/sufijos conocidos, reintentar Capa 1 ──► confianza media-alta
   │ (sin match)
   ▼
Capa 3: fuzzy match (Levenshtein acotado + exclusiones) ──► confianza media
   │
   ▼
Capa 4: muestreo de contenido (patrones existentes + validador NIT) ──► confirma/ajusta confianza
   │
   ▼
Capa 5: umbral → {enmascarar, enmascarar+flag de revisión, no enmascarar}
```

### Compatibilidad con el código existente

- `SensitiveDataType` debe extenderse con `'nit'` en `security.contract.ts`, con su propio `formatMaskedNit()` en `masking-rules.ts` (análogo a `formatMaskedDpi`) y una regla de `content_pattern` para el formato NIT guatemalteco.
- Las Capas 0–3 reemplazan únicamente la función `doesColumnMatchRule()` (y la estructura de `matcher: string | RegExp`) por una función que recibe tokens normalizados y devuelve `{ dataType, confidence }`; el resto del motor (`data-masking-engine.ts`) solo necesita leer `confidence` para decidir la rama de la Capa 5.
- El corpus en `corpus/column-name-sensitivity-corpus.json` se usa como test de regresión: cada caso `sensible` debe terminar en zona ≥0.5 para el `dataType` correcto, y cada caso `no_sensible` debe terminar en zona <0.5 (o explícitamente excluido) para todos los tipos.
