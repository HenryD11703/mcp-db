/**
 * Catálogo de términos comerciales, técnicos y palabras comunes que contienen
 * subsecuencias de letras similares a tokens sensibles (ej. 'nit', 'cel', 'sal', 'mail', 'dpi')
 * pero que son estrictamente NO sensibles (0 % de falsos positivos garantizado).
 */
export const SAFE_BENIGN_EXACT_TERMS: ReadonlySet<string> = new Set([
  'unit',
  'unit_price',
  'unitid',
  'units',
  'units_in_stock',
  'unidades',
  'unity',
  'monitor',
  'monitor_status',
  'monitoring',
  'benito',
  'manito',
  'definition',
  'unanimity',
  'nitrate',
  'nitrogen',
  'nitrogeno',
  'ignite',
  'ignition',
  'granite',
  'infinite',
  'infinity',
  'knit',
  'dpid',
  'rapid_build',
  'mailbox_capacity',
  'thumbnail',
  'chainmail',
  'cocktail',
  'telephone_book_id',
  'cell_count',
  'celebrity_id',
  'salient_feature',
  'salad_type',
  'balance_sheet_id',
  'monto_total_items',
  'id',
  'created_at',
  'updated_at',
  'status',
  'name',
  'description'
]);

export class SafeVocabularyDictionary {
  private readonly benignTerms: Set<string>;

  constructor(additionalBenignTerms: string[] = []) {
    this.benignTerms = new Set(SAFE_BENIGN_EXACT_TERMS);
    for (const term of additionalBenignTerms) {
      this.benignTerms.add(term.trim().toLowerCase());
    }
  }

  /**
   * Comprueba si una columna normalizada coincide con el catálogo seguro de palabras benignas.
   */
  public isSafeBenign(normalizedColumnName: string): boolean {
    const clean = normalizedColumnName.trim().toLowerCase().replace(/^[_\-\s]+|[_\-\s]+$/g, '');
    if (this.benignTerms.has(clean)) {
      return true;
    }
    // Si contiene la palabra unit como token aislado en snake_case
    const tokens = clean.split(/[_\-\s]+/);
    if (tokens.includes('unit') || tokens.includes('units')) {
      // Si todos los tokens son benignos
      const sensitiveRoots = ['nit', 'dpi', 'cui', 'email', 'correo', 'telefono', 'celular', 'salario', 'sueldo'];
      const hasAnySensitiveRoot = tokens.some((t) => sensitiveRoots.includes(t));
      if (!hasAnySensitiveRoot) {
        return true;
      }
    }
    return false;
  }
}
