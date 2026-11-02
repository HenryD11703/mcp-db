import type {
  ColumnClassificationResult,
  SensitiveDataType
} from '../../contracts/security.contract.js';
import { UnifiedPrefixCatalog } from './unified-prefix-catalog.js';
import { SafeVocabularyDictionary } from './safe-vocabulary-dict.js';

export interface LexicalAnalyzerOptions {
  readonly prefixCatalog?: UnifiedPrefixCatalog;
  readonly safeVocabulary?: SafeVocabularyDictionary;
}

export class LexicalColumnAnalyzer {
  private readonly prefixCatalog: UnifiedPrefixCatalog;
  private readonly safeVocabulary: SafeVocabularyDictionary;

  constructor(options?: LexicalAnalyzerOptions) {
    this.prefixCatalog = options?.prefixCatalog ?? new UnifiedPrefixCatalog();
    this.safeVocabulary = options?.safeVocabulary ?? new SafeVocabularyDictionary();
  }

  public classifyColumn(rawColumnName: string): ColumnClassificationResult {
    const raw = rawColumnName.trim();
    if (raw.length === 0) {
      return {
        columnName: rawColumnName,
        isSensitive: false,
        dataType: 'custom',
        confidence: 'none',
        strategy: 'partial'
      };
    }

    // Capa 0: Normalización de casing y delimitadores
    const normalized = this.normalizeColumnName(raw);

    // Capa 1: Atajo de Vocabulario Seguro (0% falsos positivos)
    if (this.safeVocabulary.isSafeBenign(normalized) || this.safeVocabulary.isSafeBenign(raw)) {
      return {
        columnName: rawColumnName,
        isSensitive: false,
        dataType: 'custom',
        confidence: 'none',
        strategy: 'partial'
      };
    }

    // Comprobación directa sobre el nombre normalizado completo antes de despegar prefijos
    const directMatch = this.matchSensitiveRoot(normalized);
    if (directMatch) {
      return {
        columnName: rawColumnName,
        isSensitive: true,
        dataType: directMatch,
        confidence: 'deterministic',
        strategy: directMatch === 'amount' ? 'mask_amount' : 'partial',
        matchedRuleId: `col-${directMatch}`
      };
    }

    // Capa 2: Despegue Secuencial de Prefijos (con delimitador o continuos)
    const { prefixes, remainder } = this.prefixCatalog.stripPrefixes(normalized);

    // Verificar si el residuo resultante cayó en vocabulario seguro
    if (this.safeVocabulary.isSafeBenign(remainder)) {
      return {
        columnName: rawColumnName,
        isSensitive: false,
        dataType: 'custom',
        confidence: 'none',
        strategy: 'partial',
        inferredPrefixes: prefixes
      };
    }

    // Capa 3 & 4: Reconocimiento léxico de raíces sensibles sobre el residuo
    const remainderMatch = this.matchSensitiveRoot(remainder);
    if (remainderMatch) {
      return {
        columnName: rawColumnName,
        isSensitive: true,
        dataType: remainderMatch,
        confidence: 'deterministic',
        strategy: remainderMatch === 'amount' ? 'mask_amount' : 'partial',
        matchedRuleId: `col-${remainderMatch}`,
        inferredPrefixes: prefixes
      };
    }

    return {
      columnName: rawColumnName,
      isSensitive: false,
      dataType: 'custom',
      confidence: 'none',
      strategy: 'partial',
      inferredPrefixes: prefixes
    };
  }

  private normalizeColumnName(name: string): string {
    // 1. Convertir camelCase a snake_case
    let s = name.replace(/([a-z\d])([A-Z])/g, '$1_$2');
    s = s.toLowerCase();

    // 2. Manejo de letras individuales separadas por guiones o puntos: n_i_t -> nit
    if (/^[a-z](_[a-z])+$/.test(s)) {
      const compacted = s.replace(/_/g, '');
      if (compacted === 'nit' || compacted === 'cui' || compacted === 'dpi') {
        return compacted;
      }
    }

    // 3. E_mail o e-mail -> email
    s = s.replace(/^e[_\-\s]mail/, 'email');

    // 4. Estandarizar delimitadores a '_'
    s = s.replace(/[-\s.]+/g, '_');

    // 5. Trim de guiones bajos
    return s.replace(/^_+|_+$/g, '');
  }

  private matchSensitiveRoot(candidate: string): SensitiveDataType | null {
    const clean = candidate.replace(/^_+|_+$/g, '');
    const tokens = clean.split('_').filter((t) => t.length > 0);

    // 1. Comprobación directa token por token o palabra completa
    for (const token of [clean, ...tokens]) {
      // NIT / Tax ID
      if (
        token === 'nit' ||
        token === 'niit' ||
        token === 'nti' ||
        token === 'taxid' ||
        token === 'tax_id'
      ) {
        return 'nit';
      }

      // DPI / CUI / Cédula / Documento de identificación
      if (
        token === 'dpi' ||
        token === 'cui' ||
        token === 'dpii' ||
        token === 'dip' ||
        token === 'cedula' ||
        token === 'nationalid' ||
        token === 'national_id' ||
        token === 'idnumber' ||
        token === 'identidad' ||
        token === 'identificacion'
      ) {
        return 'dpi';
      }

      // Email
      if (
        token === 'email' ||
        token === 'correo' ||
        token === 'mail' ||
        token === 'correoe' ||
        token === 'emial' ||
        token === 'corre' ||
        token === 'correoo'
      ) {
        return 'email';
      }

      // Teléfono / Celular
      if (
        token === 'telefono' ||
        token === 'phone' ||
        token === 'celular' ||
        token === 'movil' ||
        token === 'tel' ||
        token === 'telf' ||
        token === 'cel' ||
        token === 'telefon' ||
        token === 'telefeno' ||
        token === 'teelfono'
      ) {
        return 'phone';
      }

      // Salario / Sueldo / Monto (amount)
      if (
        token === 'salario' ||
        token === 'salary' ||
        token === 'sueldo' ||
        token === 'monto' ||
        token === 'balance' ||
        token === 'saldo' ||
        token === 'sal' ||
        token === 'salarioo' ||
        token === 'salraio' ||
        token === 'sueldoo'
      ) {
        return 'amount';
      }
    }

    // Compuestos específicos con delimitadores o continuos
    if (/^tax_?id$/i.test(clean)) {
      return 'nit';
    }
    if (/^nit(no|num|numero|empleado|cliente|empresa|fiscal)?$/i.test(clean)) {
      return 'nit';
    }
    if (/^(empleado|cliente|empresa|fiscal)nit$/i.test(clean)) {
      return 'nit';
    }
    if (/^dpi(no|num|numero|cliente|empleado)?$/i.test(clean)) {
      return 'dpi';
    }
    if (/^(cliente|empleado)dpi$/i.test(clean)) {
      return 'dpi';
    }
    if (/^id_?number$/i.test(clean) || /^doc(umento)?_ident/i.test(clean) || /^cedula_ident/i.test(clean)) {
      return 'dpi';
    }
    if (/^correo_?(electronico|contacto)?$/i.test(clean) || /^email_?address$/i.test(clean)) {
      return 'email';
    }
    if (/^contacto_?correo$/i.test(clean)) {
      return 'email';
    }
    if (/^(numero_)?telefono/i.test(clean) || /^phone_?number/i.test(clean) || /^telefono_?celular$/i.test(clean)) {
      return 'phone';
    }
    if (
      /^sueldo_?base$/i.test(clean) ||
      /^salario_?(mensual|neto)$/i.test(clean) ||
      /^monthly_?salary$/i.test(clean)
    ) {
      return 'amount';
    }

    return null;
  }
}
