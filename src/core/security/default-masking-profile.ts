import type { MaskingProfile, MaskingRule } from '../../contracts/security.contract.js';

export const DEFAULT_MASKING_RULES: ReadonlyArray<MaskingRule> = [
  // 1. Column-name based rules
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
    id: 'col-amount',
    targetType: 'column_name',
    matcher: /(^|_)(monto|salario|sueldo|balance|saldo|importe|amount|salary|total_pago)($|_)/i,
    dataType: 'amount',
    strategy: 'mask_amount',
    enabled: true
  },

  // 2. Content-pattern based rules (evaluated in priority order: email -> DPI -> amount -> phone)
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

export const DEFAULT_MASKING_PROFILE: MaskingProfile = {
  profileName: 'default-security-profile',
  description:
    'Default enterprise masking profile for emails, phone numbers, Guatemala 13-digit DPI, and monetary amounts.',
  rules: DEFAULT_MASKING_RULES,
  maskUnmatchedAmounts: false
};
