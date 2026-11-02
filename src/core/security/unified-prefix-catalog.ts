import type { UnifiedPrefixConfig } from '../../contracts/security.contract.js';

export const DEFAULT_ORGANIZATIONAL_PREFIXES: ReadonlyArray<string> = [
  'emp',
  'gal',
  'cli',
  'prov',
  'usr',
  'cust',
  'tit',
  'cta',
  'dep',
  'suc',
  'doc'
];

export const DEFAULT_TECHNICAL_PREFIXES: ReadonlyArray<string> = [
  't1',
  'col',
  'v',
  'tbl'
];

export const DEFAULT_ABBREVIATION_PREFIXES: ReadonlyArray<string> = [
  'no',
  'num',
  'nro',
  'id',
  'tax'
];

export class UnifiedPrefixCatalog {
  private readonly organizationalPrefixes: Set<string>;
  private readonly technicalPrefixes: Set<string>;
  private readonly abbreviationPrefixes: Set<string>;
  private readonly customPrefixes: Set<string>;
  private readonly allPrefixesSorted: string[];

  constructor(customPrefixesFromEnv: string = process.env['MASKING_CUSTOM_PREFIXES'] || '') {
    this.organizationalPrefixes = new Set(DEFAULT_ORGANIZATIONAL_PREFIXES);
    this.technicalPrefixes = new Set(DEFAULT_TECHNICAL_PREFIXES);
    this.abbreviationPrefixes = new Set(DEFAULT_ABBREVIATION_PREFIXES);
    this.customPrefixes = new Set();

    if (customPrefixesFromEnv.trim()) {
      const parsed = customPrefixesFromEnv
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0);
      for (const p of parsed) {
        this.customPrefixes.add(p);
      }
    }

    const all = new Set([
      ...this.organizationalPrefixes,
      ...this.technicalPrefixes,
      ...this.abbreviationPrefixes,
      ...this.customPrefixes
    ]);

    // Ordenar de mayor a menor longitud para permitir el despegue codicioso de prefijos más largos primero
    this.allPrefixesSorted = Array.from(all).sort((a, b) => b.length - a.length);
  }

  public getConfig(): UnifiedPrefixConfig {
    return {
      organizationalPrefixes: Array.from(this.organizationalPrefixes),
      technicalPrefixes: Array.from(this.technicalPrefixes),
      abbreviationPrefixes: Array.from(this.abbreviationPrefixes),
      customPrefixes: Array.from(this.customPrefixes)
    };
  }

  public isKnownPrefix(candidate: string): boolean {
    const lower = candidate.toLowerCase();
    return (
      this.organizationalPrefixes.has(lower) ||
      this.technicalPrefixes.has(lower) ||
      this.abbreviationPrefixes.has(lower) ||
      this.customPrefixes.has(lower)
    );
  }

  /**
   * Despega secuencialmente los prefijos conocidos al inicio de una cadena (delimitada o continua).
   * Ejemplos:
   * - "emp_nit" -> { prefixes: ["emp"], remainder: "nit" }
   * - "galempnit" -> { prefixes: ["gal", "emp"], remainder: "nit" }
   * - "t1_col_emp_nit" -> { prefixes: ["t1", "col", "emp"], remainder: "nit" }
   */
  public stripPrefixes(input: string): { prefixes: string[]; remainder: string } {
    let current = input.toLowerCase().trim();
    const matchedPrefixes: string[] = [];

    // Limpiar delimitadores iniciales
    current = current.replace(/^[_\-\s]+/, '');

    let foundPrefix = true;
    while (foundPrefix && current.length > 0) {
      foundPrefix = false;
      for (const prefix of this.allPrefixesSorted) {
        if (current.startsWith(prefix)) {
          const afterPrefix = current.slice(prefix.length);
          // Si después del prefijo hay delimitador: "emp_nit" -> remainder "nit"
          if (afterPrefix.startsWith('_') || afterPrefix.startsWith('-') || afterPrefix.startsWith(' ')) {
            matchedPrefixes.push(prefix);
            current = afterPrefix.replace(/^[_\-\s]+/, '');
            foundPrefix = true;
            break;
          }
          // Si después del prefijo hay una subcadena no vacía de al menos 2 caracteres: "empnit" -> remainder "nit"
          if (afterPrefix.length >= 2) {
            matchedPrefixes.push(prefix);
            current = afterPrefix;
            foundPrefix = true;
            break;
          }
        }
      }
    }

    return {
      prefixes: matchedPrefixes,
      remainder: current
    };
  }
}
