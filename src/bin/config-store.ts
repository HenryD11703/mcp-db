import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type ConnectionType = 'postgres' | 'sqlserver' | 'mysql' | 'mariadb' | 'sqlite';

export interface ConnectionEntry {
  readonly id: string;
  readonly type: ConnectionType;
  readonly connectionString: string;
}

/** Same shape `db-mcp start --config <file>` has always accepted: `{ "adapters": [...] }`. */
export interface DbMcpConfig {
  adapters: ConnectionEntry[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function defaultConfigPath(): string {
  return join(homedir(), '.db-mcp', 'config.json');
}

export function isConnectionType(value: string): value is ConnectionType {
  return value === 'postgres' || value === 'sqlserver' || value === 'mysql' || value === 'mariadb' || value === 'sqlite';
}

export function loadConfig(configPath: string): DbMcpConfig {
  if (!existsSync(configPath)) {
    return { adapters: [] };
  }
  const raw = readFileSync(configPath, 'utf8');
  if (raw.trim().length === 0) {
    return { adapters: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `No se pudo leer "${configPath}" como JSON (${err instanceof Error ? err.message : err}). No se modificó el archivo.`
    );
  }
  const adapters = (parsed as { adapters?: unknown } | null)?.adapters;
  if (!Array.isArray(adapters)) {
    throw new Error(`"${configPath}" no tiene un arreglo "adapters".`);
  }
  return { adapters: adapters as ConnectionEntry[] };
}

/** Atomic write; the file holds credentials so it is owner-only (0600) in a 0700 directory. */
export function saveConfig(configPath: string, config: DbMcpConfig): void {
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, configPath);
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions (e.g. Windows).
  }
}

export function upsertConnection(configPath: string, entry: ConnectionEntry): { replaced: boolean } {
  if (!ID_PATTERN.test(entry.id)) {
    throw new Error(`Identificador inválido "${entry.id}": use letras, números, "_" o "-" (máx. 64).`);
  }
  if (!isConnectionType(entry.type)) {
    throw new Error(`Tipo inválido "${entry.type}": use "postgres" o "sqlserver".`);
  }
  if (entry.connectionString.trim().length === 0) {
    throw new Error('La cadena de conexión no puede estar vacía.');
  }
  const config = loadConfig(configPath);
  const idx = config.adapters.findIndex((a) => a.id === entry.id);
  if (idx === -1) {
    config.adapters.push(entry);
  } else {
    config.adapters[idx] = entry;
  }
  saveConfig(configPath, config);
  return { replaced: idx !== -1 };
}

export function removeConnection(configPath: string, id: string): boolean {
  const config = loadConfig(configPath);
  const next = config.adapters.filter((a) => a.id !== id);
  if (next.length === config.adapters.length) {
    return false;
  }
  saveConfig(configPath, { adapters: next });
  return true;
}

/** Masks passwords for display: `postgresql://u:***@host/db`, `Password=***;`. */
export function redactConnectionString(value: string): string {
  return value
    .replace(/(:\/\/[^:/@\s]*:)[^@\s]*@/, '$1***@')
    .replace(/(password|pwd)\s*=\s*[^;]*/gi, '$1=***');
}

export function resolveConfigPath(explicit?: string): string {
  const candidate = explicit ?? process.env['MCP_CONFIG_PATH'];
  return candidate ? resolve(process.cwd(), candidate) : defaultConfigPath();
}
