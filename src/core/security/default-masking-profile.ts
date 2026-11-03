import type { MaskingProfile, MaskingRule } from '../../contracts/security.contract.js';

/**
 * Business amounts (invoice totals, balances, prices) are not masked by default: hiding them
 * breaks legitimate reporting, and the same figures are usually reachable through detail tables,
 * so masking one column only gives a false sense of protection. Personal pay (salary) is always
 * masked. Set MASKING_MASK_AMOUNTS=true to also mask business amounts and `Q 1,234.56` patterns.
 */
export function isAmountMaskingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env['MASKING_MASK_AMOUNTS'] ?? '');
}

export function buildDefaultMaskingRules(maskAmounts: boolean): ReadonlyArray<MaskingRule> {
  return DEFAULT_RULE_TEMPLATES.map((rule) =>
    rule.dataType === 'amount' && rule.id !== 'col-salary' ? { ...rule, enabled: maskAmounts } : rule
  );
}

const DEFAULT_RULE_TEMPLATES: ReadonlyArray<MaskingRule> = [
  // 1. Column-name based rules
  {
    id: 'col-nit',
    targetType: 'column_name',
    matcher: /(^|_)(nit|tax_?id|taxid)($|_)/i,
    dataType: 'nit',
    strategy: 'partial',
    enabled: true
  },
  {
    id: 'col-email',
    targetType: 'column_name',
    matcher: /(^|_)(email|correo|e_mail|mail)($|_)/i,
    dataType: 'email',
    strategy: 'partial',
    enabled: true
  },
  {
    id: 'col-dpi',
    targetType: 'column_name',
    matcher: /(^|_)(dpi|cui|identificacion|doc_identidad)($|_)/i,
    dataType: 'dpi',
    strategy: 'partial',
    enabled: true
  },
  {
    id: 'col-phone',
    targetType: 'column_name',
    matcher: /(^|_)(telefono|phone|celular|movil|tel)($|_)/i,
    dataType: 'phone',
    strategy: 'partial',
    enabled: true
  },
  {
    id: 'col-salary',
    targetType: 'column_name',
    matcher: /(^|_)(salario|sueldo|salary)($|_)/i,
    dataType: 'amount',
    strategy: 'mask_amount',
    enabled: true
  },
  {
    id: 'col-amount',
    targetType: 'column_name',
    matcher: /(^|_)(monto|balance|saldo|importe|amount|total_pago)($|_)/i,
    dataType: 'amount',
    strategy: 'mask_amount',
    enabled: true
  },

  // 2. Content-pattern based rules (evaluated in priority order: email -> DPI -> NIT -> amount -> phone)
  {
    id: 'pat-email',
    targetType: 'content_pattern',
    matcher: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    dataType: 'email',
    strategy: 'partial',
    enabled: true
  },
  {
    id: 'pat-dpi',
    targetType: 'content_pattern',
    matcher: /\b\d{4}\s?\d{5}\s?\d{4}\b/g,
    dataType: 'dpi',
    strategy: 'partial',
    enabled: true
  },
  {
    id: 'pat-nit',
    targetType: 'content_pattern',
    matcher: /\b\d{2,8}-[0-9kK]\b/g,
    dataType: 'nit',
    strategy: 'partial',
    enabled: true
  },
  {
    id: 'pat-amount',
    targetType: 'content_pattern',
    matcher: /[Q$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/g,
    dataType: 'amount',
    strategy: 'mask_amount',
    enabled: true
  },
  {
    id: 'pat-phone',
    targetType: 'content_pattern',
    matcher: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{3,4}\)[\s-]?)?\b\d{4}[\s-]\d{4}\b/g,
    dataType: 'phone',
    strategy: 'partial',
    enabled: true
  }
];

export const DEFAULT_MASKING_RULES: ReadonlyArray<MaskingRule> = buildDefaultMaskingRules(isAmountMaskingEnabled());

export const DEFAULT_MASKING_PROFILE: MaskingProfile = {
  profileName: 'default-security-profile',
  description:
    'Default enterprise masking profile for emails, phone numbers, Guatemala 13-digit DPI, NIT and salaries; business amounts only with MASKING_MASK_AMOUNTS=true.',
  rules: DEFAULT_MASKING_RULES,
  maskUnmatchedAmounts: false
};
