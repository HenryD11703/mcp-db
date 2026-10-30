import { z } from 'zod';
import type {
  MaskingProfile,
  MaskingRule,
  MaskingStrategy,
  SensitiveDataType
} from '../../contracts/security.contract.js';
import { DataMaskingError } from '../errors.js';

export const SensitiveDataTypeSchema = z.enum(['email', 'phone', 'dpi', 'amount', 'custom']);
export const MaskingStrategySchema = z.enum(['partial', 'redact', 'mask_amount', 'custom']);
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
  if (strategy === 'mask_amount' || dataType === 'amount') {
    return formatMaskedAmount(raw, customMask);
  }
  switch (dataType) {
    case 'email':
      return formatMaskedEmail(raw);
    case 'phone':
      return formatMaskedPhone(raw);
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

export function doesColumnMatchRule(columnName: string, rule: MaskingRule): boolean {
  if (!rule.enabled || rule.targetType !== 'column_name') {
    return false;
  }
  const regex = compileRuleMatcher(rule.matcher, true);
  return regex.test(columnName);
}
