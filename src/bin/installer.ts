import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export interface AgentTarget {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
  readonly isClaudeCode?: boolean;
}

export function detectAgentTargets(): AgentTarget[] {
  const home = homedir();
  const appData = process.env['APPDATA'] || join(home, 'AppData', 'Roaming');

  const antigravityPath = join(home, '.gemini', 'config', 'mcp_config.json');
  const claudeCodePath = join(home, '.claude.json');
  const claudeDesktopPath =
    process.platform === 'win32'
      ? join(appData, 'Claude', 'claude_desktop_config.json')
      : join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

  return [
    {
      id: 'antigravity',
      name: 'Google Antigravity (Agy)',
      path: antigravityPath,
      exists: existsSync(antigravityPath)
    },
    {
      id: 'claude-code',
      name: 'Claude Code CLI',
      path: claudeCodePath,
      exists: existsSync(claudeCodePath),
      isClaudeCode: true
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      path: claudeDesktopPath,
      exists: existsSync(claudeDesktopPath)
    }
  ];
}

export function buildServerConfig(
  serverScriptPath: string,
  envVars: Record<string, string>,
  isClaudeCode = false
): Record<string, unknown> {
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars)) {
    if (v && v.trim().length > 0) {
      cleanEnv[k] = v.trim();
    }
  }

  const base: Record<string, unknown> = {
    command: 'node',
    args: [serverScriptPath, 'start']
  };

  if (Object.keys(cleanEnv).length > 0) {
    base['env'] = cleanEnv;
  }

  if (isClaudeCode) {
    return {
      type: 'stdio',
      ...base
    };
  }

  return base;
}

export function writeConfigToTarget(
  targetPath: string,
  serverName: string,
  config: Record<string, unknown>
): void {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let fileContent: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try {
      // Create backup
      copyFileSync(targetPath, `${targetPath}.bak`);
      const raw = readFileSync(targetPath, 'utf8');
      fileContent = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      fileContent = {};
    }
  }

  const mcpServers = (fileContent['mcpServers'] ?? {}) as Record<string, unknown>;
  mcpServers[serverName] = config;
  fileContent['mcpServers'] = mcpServers;

  writeFileSync(targetPath, JSON.stringify(fileContent, null, 2) + '\n', 'utf8');
}

export async function runInteractiveInstaller(args: ReadonlyArray<string>): Promise<number> {
  const rl = readline.createInterface({ input, output });

  console.log('\n======================================================');
  console.log('       INSTALADOR DE SERVIDOR MCP (db-mcp-node)       ');
  console.log('======================================================\n');
  console.log('Este asistente configurará automáticamente db-mcp en');
  console.log('tus agentes de IA (Antigravity, Claude Code, etc.).\n');

  try {
    const targets = detectAgentTargets();
    const detectedTargets = targets.filter((t) => t.exists);

    console.log('Agentes detectados en tu sistema:');
    targets.forEach((t, i) => {
      const status = t.exists ? '[DETECTADO]' : '[NO DETECTADO]';
      console.log(`  ${i + 1}) ${t.name.padEnd(26)} ${status} -> ${t.path}`);
    });
    console.log(`  ${targets.length + 1}) Todos los agentes detectados (${detectedTargets.map((d) => d.name).join(', ')})`);
    console.log('  0) Cancelar instalación\n');

    const defaultChoice = detectedTargets.length > 0 ? String(targets.length + 1) : '1';
    const selection = await rl.question(`Selecciona una opción [default: ${defaultChoice}]: `);
    const chosen = (selection.trim() || defaultChoice).toLowerCase();

    if (chosen === '0' || chosen === 'cancel') {
      console.log('Instalación cancelada.');
      return 0;
    }

    const selectedTargets: AgentTarget[] = [];
    const choiceNum = parseInt(chosen, 10);

    if (choiceNum >= 1 && choiceNum <= targets.length) {
      const picked = targets[choiceNum - 1];
      if (picked) selectedTargets.push(picked);
    } else if (choiceNum === targets.length + 1 || chosen === 'all') {
      selectedTargets.push(...(detectedTargets.length > 0 ? detectedTargets : targets));
    } else {
      console.error('Opción no válida.');
      return 1;
    }

    console.log('\n------------------------------------------------------');
    console.log('  Configuración de Conexiones a Bases de Datos        ');
    console.log('------------------------------------------------------');
    console.log('(Puedes dejar en blanco cualquier campo para configurarlo después)\n');

    const pgUrl = await rl.question('Cadena de conexión PostgreSQL (ej. postgresql://ro_user:pass@localhost:5432/mibase):\n> ');
    const mssqlUrl = await rl.question('Cadena de conexión SQL Server (ej. Server=localhost,1433;Database=mibase;User Id=ro_user;Password=pass;TrustServerCertificate=true;):\n> ');

    const auditLogPath = await rl.question(`Ruta de auditoría [default: ${join(process.cwd(), 'audit.jsonl')}]:\n> `);

    // Determine script entry point
    const scriptPath = resolve(process.cwd(), 'dist/src/bin/db-mcp.js');

    const envVars: Record<string, string> = {
      POSTGRES_URL: pgUrl.trim(),
      SQLSERVER_URL: mssqlUrl.trim(),
      AUDIT_LOG_PATH: auditLogPath.trim() || join(process.cwd(), 'audit.jsonl')
    };

    console.log('\n------------------------------------------------------');
    console.log('  Escribiendo configuración...                        ');
    console.log('------------------------------------------------------');

    for (const target of selectedTargets) {
      const config = buildServerConfig(scriptPath, envVars, Boolean(target.isClaudeCode));
      writeConfigToTarget(target.path, 'db-mcp', config);
      console.log(`✓ Configurado exitosamente en: ${target.name}`);
      console.log(`  Archivo: ${target.path}`);
      console.log(`  (Se creó respaldo en: ${target.path}.bak)`);
    }

    console.log('\n======================================================');
    console.log('         ¡INSTALACIÓN COMPLETADA CON ÉXITO!           ');
    console.log('======================================================');
    console.log('\n¿Cómo usarlo ahora?');
    console.log('1. En Google Antigravity (Agy):');
    console.log('   - Reinicia la sesión o abre una nueva pestaña de chat.');
    console.log('   - Verás disponibles las 9 herramientas de db-mcp (query_database, execute_federated_query, etc.).');
    console.log('\n2. En Claude Code CLI:');
    console.log('   - Ejecuta `claude mcp list` para verificar que `db-mcp` esté conectado.');
    console.log('   - Claude Code ya tendrá acceso a consultar tus bases de datos de forma segura.');
    console.log('\nPara cambiar las credenciales en el futuro, puedes editar los archivos JSON');
    console.log('directamente o volver a ejecutar `npm run cli:db-mcp install`.\n');

    return 0;
  } finally {
    rl.close();
  }
}
