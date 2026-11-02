import { defaultSessionContext } from './session-pseudonym.js';
import { z } from 'zod';
import type {
  MaskingProfile,
  MaskingRule,
  MaskingStrategy,
  SensitiveDataType
} from '../../contracts/security.contract.js';
import { DataMaskingError } from '../errors.js';

export const SensitiveDataTypeSchema = z.enum(['email', 'phone', 'dpi', 'nit', 'amount', 'custom']);
export const MaskingStrategySchema = z.enum(['partial', 'redact', 'session_pseudonym', 'mask_amount', 'custom']);
export const MaskingTargetTypeSchema = z.enum(['column_name', 'content_pattern']);

export const MaskingRuleConfigSchema = z.object({
  id: z.string().min(1),
  targetType: MaskingTargetTypeSchema,
  matcher: z.union([z.string().min(1), z.instanceof(RegExp)]),
  dataType: SensitiveDataTypeSchema,
  strategy: MaskingStrategySchema,
  customMask: z.string().optional(),
  enabled: z.boolean()
});

export const MaskingProfileConfigSchema = z.object({
  profileName: z.string().min(1),
  description: z.string().optional(),
  rules: z.array(MaskingRuleConfigSchema),
  maskUnmatchedAmounts: z.boolean().optional()
});

export function validateMaskingProfile(input: unknown): MaskingProfile {
  const parsed = MaskingProfileConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new DataMaskingError(`Invalid MaskingProfile configuration: ${parsed.error.message}`);
  }
  return parsed.data as MaskingProfile;
}

/**
 * Masks an email address preserving the first and last character of the local part
 * (when length >= 3) and keeping the domain:
 * - "juan.perez@empresa.com.gt" -> "j***z@empresa.com.gt"
 * - "ab@empresa.com.gt" -> "***@empresa.com.gt"
 */
export function formatMaskedEmail(raw: string): string {
  const trimmed = raw.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1) {
    return '***@***';
  }
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (local.length >= 3) {
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
  }
  return `***@${domain}`;
}

/**
 * Masks a phone number preserving the last 4 digits:
 * - "+502 5555-1234" -> "(***) ***-1234"
 * - "55551234" -> "(***) ***-1234"
 */
export function formatMaskedPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) {
    const last4 = digits.slice(-4);
    return `(***) ***-${last4}`;
  }
  return '(***) ***-****';
}

/**
 * Masks a Guatemalan 13-digit CUI/DPI preserving only the last 4 digits (department/municipality code):
 * - "2458 91234 0101" -> "*********0101"
 * - "2458912340101"   -> "*********0101"
 */
export function formatMaskedDpi(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) {
    const last4 = digits.slice(-4);
    return `*********${last4}`;
  }
  return '*************';
}

/**
 * Masks monetary amounts into a redacted currency representation:
 * - "Q 12,500.00" or 12500 -> "Q [ENMASCARADO]"
 */
export function formatMaskedAmount(raw: string | number, customMask?: string): string {
  if (customMask) {
    return customMask;
  }
  const str = String(raw).trim();
  if (str.startsWith('$')) {
    return '$ [ENMASCARADO]';
  }
  if (str.startsWith('€')) {
    return '€ [ENMASCARADO]';
  }
  return 'Q [ENMASCARADO]';
}

export const NIT_HYPHENATED_REGEX = /\b\d{2,8}-[0-9kK]\b/g;

/**
 * Validador de dígito verificador de NIT guatemalteco (Algoritmo Módulo 11 de la SAT).
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
 * Verifica si un valor califica como NIT legítimo mediante formato con guion o checksum Módulo 11.
 * Excluye enteros generales de pocos dígitos (años como 2024, códigos postales, etc.).
 */
export function isValidNitContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const str = String(value).trim();
  if (/\b\d{2,8}-[0-9kK]\b/i.test(str)) {
    return true;
  }
  const clean = str.replace(/[^0-9kK]/gi, '');
  if (clean.length >= 6 && clean.length <= 10) {
    return validateNitChecksumModulo11(clean);
  }
  return false;
}

/**
 * Enmascara un NIT preservando el guion y el dígito verificador (o mediante redacción / pseudonimización).
 * - "1234567-4" -> "*******-4"
 * - "1234567K" -> "******-K"
 */
export function formatMaskedNit(
  raw: string,
  strategy: MaskingStrategy = 'partial',
  customMask?: string
): string {
  if (strategy === 'redact') {
    return customMask ?? '[NIT ENMASCARADO]';
  }
  if (strategy === 'session_pseudonym' && customMask) {
    return customMask;
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

/**
 * Applies a single MaskingRule strategy to a string or number value.
 */
export function applyMaskingStrategy(
  raw: string,
  dataType: SensitiveDataType,
  strategy: MaskingStrategy,
  customMask?: string,
  customTransformer?: (val: string) => string
): string {
  if (strategy === 'custom' && customTransformer) {
    return customTransformer(raw);
  }
  if (strategy === 'redact') {
    return customMask ?? '[REDACTED]';
  }
  if (strategy === 'session_pseudonym') {
    return customMask ?? defaultSessionContext.getPseudonym(raw, dataType);
  }
  if (strategy === 'mask_amount' || dataType === 'amount') {
    return formatMaskedAmount(raw, customMask);
  }
  switch (dataType) {
    case 'email':
      return formatMaskedEmail(raw);
    case 'phone':
      return formatMaskedPhone(raw);
    case 'nit':
      return formatMaskedNit(raw, strategy, customMask);
    case 'dpi':
      return formatMaskedDpi(raw);
    default:
      return customMask ?? '[REDACTED]';
  }
}

export function compileRuleMatcher(matcher: string | RegExp, isColumnName: boolean): RegExp {
  if (matcher instanceof RegExp) {
    return matcher;
  }
  if (isColumnName) {
    return new RegExp(matcher, 'i');
  }
  return new RegExp(matcher, 'g');
}

/**
 * Splits a column identifier into its constituent words, recognizing snake_case
 * ("telefono_movil"), camelCase ("clienteTelefono") and the acronym-prefixed
 * PascalCase legacy schemas commonly use ("CLTTelefono" -> ["CLT", "Telefono"]).
 */
function tokenizeIdentifier(name: string): string[] {
  const withSeparators = name.replace(/[^a-zA-Z0-9]+/g, '_');
  return withSeparators
    .split('_')
    .flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z]|[^A-Za-z]|$)|[A-Z]?[a-z]+|[0-9]+/g) ?? [part])
    .filter((part) => part.length > 0);
}

/** Normalizes any naming convention to lowercase snake_case so column-name rules match regardless of style. */
function normalizeColumnName(name: string): string {
  return tokenizeIdentifier(name).join('_').toLowerCase();
}

export function doesColumnMatchRule(columnName: string, rule: MaskingRule): boolean {
  if (!rule.enabled || rule.targetType !== 'column_name') {
    return false;
  }
  const regex = compileRuleMatcher(rule.matcher, true);
  return regex.test(columnName) || regex.test(normalizeColumnName(columnName));
}
