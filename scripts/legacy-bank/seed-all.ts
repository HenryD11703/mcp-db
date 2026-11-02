/** Seeds every reachable engine. SQLite always runs (no Docker needed); the others
 *  are skipped with a warning if their container isn't reachable yet. */
import { spawnSync } from 'node:child_process';

function run(label: string, file: string): boolean {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync('npx', ['tsx', `scripts/legacy-bank/${file}`], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32'
  });
  return result.status === 0;
}

async function main(): Promise<void> {
  const results: Record<string, boolean> = {};
  results['sqlite'] = run('SQLite', 'seed-sqlite.ts');
  results['mysql'] = run('MySQL', 'seed-mysql.ts');
  results['postgres'] = run('PostgreSQL', 'seed-postgres.ts');
  results['sqlserver'] = run('SQL Server', 'seed-sqlserver.ts');

  console.log('\n=== Resumen de siembra ===');
  for (const [engine, ok] of Object.entries(results)) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${engine}`);
  }
  if (!results['sqlite']) {
    process.exit(1);
  }
}

main();
