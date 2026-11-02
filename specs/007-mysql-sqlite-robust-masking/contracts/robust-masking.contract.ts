import { z } from 'zod';

/**
 * Categorías de datos sensibles reconocidas formalmente por el servidor MCP.
 * Se incorpora 'nit' según FR-006 y FR-010.
 * 'amount' continúa siendo el tipo canónico para montos, sueldos y salarios.
 */
export const SensitiveDataTypeSchema = z.enum([
  'email',
  'phone',
  'dpi',
  'nit',
  'amount',
  'custom'
]);
export type SensitiveDataType = z.infer<typeof SensitiveDataTypeSchema>;

/**
 * Estrategias de enmascaramiento soportadas en memoria.
 */
export const MaskingStrategySchema = z.enum([
  'partial',
  'redact',
  'session_pseudonym',
  'mask_amount',
  'custom'
]);
export type MaskingStrategy = z.infer<typeof MaskingStrategySchema>;

/**
 * Catálogo unificado de prefijos organizacionales, técnicos y de identificación.
 */
export interface UnifiedPrefixConfig {
  readonly organizationalPrefixes: ReadonlyArray<string>;
  readonly technicalPrefixes: ReadonlyArray<string>;
  readonly abbreviationPrefixes: ReadonlyArray<string>;
  readonly customPrefixes: ReadonlyArray<string>;
}

/**
 * Estados discretos de confianza para clasificación determinista:
 * - 'none': Columna no sensible o perteneciente a SafeVocabularyDictionary (0 % falsos positivos garantizado).
 * - 'deterministic': Coincidencia exacta o segmentada con raíces sensibles conocidas.
 * - 'low_confidence_fail_safe': Ambigüedad detectada; enmascara preventivamente y emite auditoría sin filtrar PII.
 */
export type ConfidenceState = 'deterministic' | 'low_confidence_fail_safe' | 'none';

/**
 * Resultado de clasificación determinista de columna sensible.
 */
export interface ColumnClassificationResult {
  readonly columnName: string;
  readonly isSensitive: boolean;
  readonly dataType: SensitiveDataType;
  readonly confidence: ConfidenceState;
  readonly strategy: MaskingStrategy;
  readonly matchedRuleId?: string;
  readonly inferredPrefixes?: ReadonlyArray<string>;
}

/**
 * Opciones de contexto de sesión efímera para pseudonimización determinista.
 */
export interface SessionContextOptions {
  readonly secretKey: Buffer;
  readonly createdAt: Date;
  readonly prefixFormat?: string; // Por defecto 'pseudo_'
}

/**
 * Patrón regex estricto de NIT para inspección de contenido:
 * Requiere formato con guion obligatorio (\b\d{2,8}-[0-9kK]\b) para evitar falsos positivos
 * con años (ej. 2024), códigos postales o identificadores numéricos generales.
 */
export const NIT_HYPHENATED_REGEX = /\b\d{2,8}-[0-9kK]\b/g;

/**
 * Valida el dígito verificador de un NIT guatemalteco utilizando el algoritmo Módulo 11 de la SAT.
 * Evita falsos positivos al inspeccionar valores numéricos de celdas sin guion.
 */
export function validateNitChecksumModulo11(raw: string): boolean {
  const clean = raw.trim().replace(/[^0-9kK]/gi, '');
  if (clean.length < 2 || clean.length > 10) {
    return false;
  }
  const body = clean.slice(0, -1);
  const expectedCheckDigit = clean.slice(-1).toUpperCase();

  let sum = 0;
  const factorBase = body.length + 1;
  for (let i = 0; i < body.length; i++) {
    const digit = parseInt(body[i]!, 10);
    if (isNaN(digit)) return false;
    sum += digit * (factorBase - i);
  }

  const remainder = sum % 11;
  const checkVal = (11 - remainder) % 11;
  const calculatedCheckDigit = checkVal === 10 ? 'K' : String(checkVal);

  return calculatedCheckDigit === expectedCheckDigit;
}

/**
 * Verifica si un valor de celda califica como NIT legítimo mediante formato estructurado o checksum.
 */
export function isValidNitContent(value: string | number): boolean {
  const str = String(value).trim();
  if (NIT_HYPHENATED_REGEX.test(str)) {
    return true;
  }
  // Para valores sin guion, exige longitud mínima de 6 dígitos y comprobación Módulo 11
  const clean = str.replace(/[^0-9kK]/gi, '');
  if (clean.length >= 6 && clean.length <= 10) {
    return validateNitChecksumModulo11(clean);
  }
  return false;
}

/**
 * Función de enmascaramiento para NIT:
 * Preserva guion y dígito verificador: "1234567-4" -> "*******-4" / "1234567K" -> "******-K"
 */
export function formatMaskedNit(raw: string, strategy: MaskingStrategy = 'partial', sessionPseudonym?: string): string {
  if (strategy === 'redact') {
    return '[NIT ENMASCARADO]';
  }
  if (strategy === 'session_pseudonym' && sessionPseudonym) {
    return sessionPseudonym;
  }
  const trimmed = raw.trim();
  const hasHyphen = trimmed.includes('-');
  const clean = trimmed.replace(/[^0-9kK]/gi, '');
  if (clean.length < 2) {
    return '***';
  }
  const checkDigit = clean.slice(-1).toUpperCase();
  const maskedLength = clean.length - 1;
  const asterisks = '*'.repeat(maskedLength);
  return hasHyphen ? `${asterisks}-${checkDigit}` : `${asterisks}${checkDigit}`;
}
