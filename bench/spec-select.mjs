// BENCH_SPEC=large selects the ~100-table schema (database bench_large); default is the 16-table one.
export const SPEC = process.env.BENCH_SPEC === 'large' ? 'large' : 'small';
export const SUFFIX = SPEC === 'large' ? '-large' : '';
export const DB_NAME = SPEC === 'large' ? 'bench_large' : 'bench';
export const spec = await import(SPEC === 'large' ? './spec-large.mjs' : './spec.mjs');
