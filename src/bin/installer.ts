import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { defaultConfigPath, loadConfig, upsertConnection } from './config-store.js';

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

  const isNpx = serverScriptPath === 'npx' || serverScriptPath.startsWith('npx:');
  const pkgName = serverScriptPath.startsWith('npx:')
    ? serverScriptPath.slice(4)
    : 'db-mcp-node';

  const base: Record<string, unknown> = isNpx
    ? {
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', pkgName, 'start']
      }
    : {
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

export function resolveInstalledScriptPath(): string {
  const localDist = resolve(process.cwd(), 'dist/src/bin/db-mcp.js');
  if (existsSync(localDist)) {
    return localDist;
  }
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const siblingScript = resolve(currentDir, 'db-mcp.js');
    if (existsSync(siblingScript)) {
      return siblingScript;
    }
  } catch {
    // Fallback to localDist
  }
  return localDist;
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
    const raw = readFileSync(targetPath, 'utf8');
    if (raw.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('el contenido no es un objeto JSON');
        }
        fileContent = parsed as Record<string, unknown>;
      } catch (err) {
        // Never overwrite a file we cannot understand (e.g. ~/.claude.json holds all Claude Code state).
        throw new Error(
          `No se pudo leer "${targetPath}" como JSON (${err instanceof Error ? err.message : err}). ` +
            'No se modificó el archivo; corrígelo manualmente y vuelve a intentar.'
        );
      }
    }
    // Timestamped backup so repeated runs never clobber an earlier one.
    copyFileSync(targetPath, `${targetPath}.${Date.now()}.bak`);
  }

  const mcpServers = (fileContent['mcpServers'] ?? {}) as Record<string, unknown>;
  mcpServers[serverName] = config;
  fileContent['mcpServers'] = mcpServers;

  writeFileSync(targetPath, JSON.stringify(fileContent, null, 2) + '\n', 'utf8');
}

export interface InstallerFlags {
  readonly agent?: string;
  readonly pgUrl?: string;
  readonly mssqlUrl?: string;
  readonly mysqlUrl?: string;
  readonly sqlitePath?: string;
  readonly auditPath?: string;
  readonly mode?: string;
  readonly yes: boolean;
}

export function parseInstallerFlags(args: ReadonlyArray<string>): InstallerFlags {
  const read = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    const value = idx !== -1 ? args[idx + 1] : undefined;
    return value !== undefined && !value.startsWith('--') ? value : undefined;
  };
  return {
    agent: read('--agent'),
    pgUrl: read('--pg-url'),
    mssqlUrl: read('--mssql-url'),
    mysqlUrl: read('--mysql-url'),
    sqlitePath: read('--sqlite-path') || read('--sqlite-url'),
    auditPath: read('--audit-path'),
    mode: read('--mode'),
    yes: args.includes('--yes') || args.includes('-y')
  };
}

function selectTargets(targets: AgentTarget[], agent: string): AgentTarget[] | null {
  if (agent === 'all') {
    const detected = targets.filter((t) => t.exists);
    return detected.length > 0 ? detected : targets;
  }
  const picked = targets.find((t) => t.id === agent);
  return picked ? [picked] : null;
}

export async function runInteractiveInstaller(args: ReadonlyArray<string>): Promise<number> {
  const flags = parseInstallerFlags(args);
  const nonInteractive = flags.yes;
  const rl = nonInteractive ? undefined : readline.createInterface({ input, output });
  const ask = async (question: string, preset: string | undefined): Promise<string> =>
    preset !== undefined ? preset : rl ? await rl.question(question) : '';

  console.log('\n======================================================');
  console.log('       INSTALADOR DE SERVIDOR MCP (db-mcp-node)       ');
  console.log('======================================================\n');

  try {
    const targets = detectAgentTargets();
    const detectedTargets = targets.filter((t) => t.exists);
    let selectedTargets: AgentTarget[];

    if (flags.agent !== undefined || nonInteractive) {
      const picked = selectTargets(targets, (flags.agent ?? 'all').toLowerCase());
      if (!picked) {
        console.error(`Agente no válido: "${flags.agent}". Usa: ${targets.map((t) => t.id).join(', ')}, all.`);
        return 1;
      }
      selectedTargets = picked;
    } else {
      console.log('Agentes detectados en tu sistema:');
      targets.forEach((t, i) => {
        const status = t.exists ? '[DETECTADO]' : '[NO DETECTADO]';
        console.log(`  ${i + 1}) ${t.name.padEnd(26)} ${status} -> ${t.path}`);
      });
      console.log(`  ${targets.length + 1}) Todos los agentes detectados (${detectedTargets.map((d) => d.name).join(', ')})`);
      console.log('  0) Cancelar instalación\n');

      const defaultChoice = detectedTargets.length > 0 ? String(targets.length + 1) : '1';
      const selection = await ask(`Selecciona una opción [default: ${defaultChoice}]: `, undefined);
      const chosen = (selection.trim() || defaultChoice).toLowerCase();

      if (chosen === '0' || chosen === 'cancel') {
        console.log('Instalación cancelada.');
        return 0;
      }

      const choiceNum = parseInt(chosen, 10);
      if (choiceNum >= 1 && choiceNum <= targets.length) {
        selectedTargets = [targets[choiceNum - 1]!];
      } else if (choiceNum === targets.length + 1 || chosen === 'all') {
        selectedTargets = detectedTargets.length > 0 ? detectedTargets : targets;
      } else {
        console.error('Opción no válida.');
        return 1;
      }
    }

    if (!nonInteractive && flags.pgUrl === undefined && flags.mssqlUrl === undefined && flags.mysqlUrl === undefined && flags.sqlitePath === undefined) {
      console.log('\n------------------------------------------------------');
      console.log('  Configuración de Conexiones a Bases de Datos        ');
      console.log('------------------------------------------------------');
      console.log('(Puedes dejar en blanco cualquier campo para configurarlo después)\n');
    }

    const pgUrl = await ask(
      'Cadena de conexión PostgreSQL (ej. postgresql://ro_user:pass@localhost:5432/mibase):\n> ',
      flags.pgUrl ?? (nonInteractive ? process.env['POSTGRES_URL'] ?? '' : undefined)
    );
    const mssqlUrl = await ask(
      'Cadena de conexión SQL Server (ej. Server=localhost,1433;Database=mibase;User Id=ro_user;Password=pass;TrustServerCertificate=true;):\n> ',
      flags.mssqlUrl ?? (nonInteractive ? process.env['SQLSERVER_URL'] ?? '' : undefined)
    );
    const mysqlUrl = await ask(
      'Cadena de conexión MySQL/MariaDB (ej. mysql://ro_user:pass@localhost:3306/mibase):\n> ',
      flags.mysqlUrl ?? (nonInteractive ? process.env['MYSQL_URL'] ?? '' : undefined)
    );
    const sqlitePath = await ask(
      'Ruta a base de datos SQLite (ej. ./data/empresa.sqlite):\n> ',
      flags.sqlitePath ?? (nonInteractive ? process.env['SQLITE_PATH'] ?? '' : undefined)
    );

    if (
      !pgUrl.trim() &&
      !mssqlUrl.trim() &&
      !mysqlUrl.trim() &&
      !sqlitePath.trim() &&
      loadConfig(defaultConfigPath()).adapters.length === 0
    ) {
      console.error(
        '\n[AVISO] No hay conexiones configuradas: agrégalas con `db-mcp add <id> --type postgres|sqlserver|mysql|sqlite --url <cadena>`.'
      );
    }

    const defaultAuditPath = join(homedir(), '.db-mcp', 'audit.jsonl');
    const auditLogPath = await ask(`Ruta de auditoría [default: ${defaultAuditPath}]:\n> `, flags.auditPath ?? (nonInteractive ? '' : undefined));

    const localDistExists = existsSync(resolve(process.cwd(), 'dist/src/bin/db-mcp.js'));
    const defaultMode = localDistExists ? '1' : '2';
    const modePrompt = await ask(
      `Modo de ejecución [1 = Binario local/instalado, 2 = vía npx (sin clonar repo)] [default: ${defaultMode}]:\n> `,
      flags.mode ?? (nonInteractive ? '' : undefined)
    );
    const chosenMode = (modePrompt.trim() || defaultMode).toLowerCase();

    const scriptPath =
      chosenMode === '2' || chosenMode === 'npx'
        ? 'npx:db-mcp-node'
        : resolveInstalledScriptPath();

    // Credentials live in ~/.db-mcp/config.json (0600), not in each agent's config file.
    const configPath = defaultConfigPath();
    if (pgUrl.trim()) {
      upsertConnection(configPath, { id: 'postgres', type: 'postgres', connectionString: pgUrl.trim() });
    }
    if (mssqlUrl.trim()) {
      upsertConnection(configPath, { id: 'sqlserver', type: 'sqlserver', connectionString: mssqlUrl.trim() });
    }
    if (mysqlUrl.trim()) {
      upsertConnection(configPath, { id: 'mysql', type: 'mysql', connectionString: mysqlUrl.trim() });
    }
    if (sqlitePath.trim()) {
      upsertConnection(configPath, { id: 'sqlite', type: 'sqlite', connectionString: sqlitePath.trim() });
    }
    if (pgUrl.trim() || mssqlUrl.trim() || mysqlUrl.trim() || sqlitePath.trim()) {
      console.log(`\n✓ Credenciales guardadas en ${configPath} (solo lectura para tu usuario)`);
    }

    const envVars: Record<string, string> = {
      AUDIT_LOG_PATH: auditLogPath.trim() === defaultAuditPath ? '' : auditLogPath.trim()
    };

    console.log('\n------------------------------------------------------');
    console.log('  Escribiendo configuración...                        ');
    console.log('------------------------------------------------------');

    let failures = 0;
    for (const target of selectedTargets) {
      try {
        const config = buildServerConfig(scriptPath, envVars, Boolean(target.isClaudeCode));
        writeConfigToTarget(target.path, 'db-mcp', config);
        console.log(`✓ Configurado exitosamente en: ${target.name}`);
        console.log(`  Archivo: ${target.path}`);
        console.log(`  (Respaldo previo: ${target.path}.<timestamp>.bak)`);
      } catch (err) {
        failures++;
        console.error(`✗ ${target.name}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (failures > 0) {
      return 1;
    }

    console.log('\n======================================================');
    console.log('         ¡INSTALACIÓN COMPLETADA CON ÉXITO!           ');
    console.log('======================================================');
    console.log('\nReinicia tu agente (o abre un chat nuevo) para cargar db-mcp.');
    console.log('En Claude Code verifica con `claude mcp list`.');
    console.log('Gestiona conexiones con `db-mcp add|connections|test|remove` (credenciales en ~/.db-mcp/config.json).');
    console.log('Modo no interactivo: db-mcp install --yes --agent claude-code --pg-url <url> --mode npx\n');

    return 0;
  } finally {
    rl?.close();
  }
}
