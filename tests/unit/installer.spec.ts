import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectAgentTargets,
  buildServerConfig,
  writeConfigToTarget
} from '../../src/bin/installer.js';

describe('MCP Interactive Installer (Agent Discovery & Configuration)', () => {
  const tempConfigDir = resolve(process.cwd(), 'tests/fixtures/installer-temp');
  const tempConfigFile = resolve(tempConfigDir, 'mcp_test_config.json');

  beforeEach(() => {
    if (existsSync(tempConfigDir)) {
      rmSync(tempConfigDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(tempConfigDir)) {
      rmSync(tempConfigDir, { recursive: true, force: true });
    }
  });

  it('detects agent targets without throwing', () => {
    const targets = detectAgentTargets();
    expect(targets.length).toBeGreaterThanOrEqual(2);
    const agy = targets.find((t) => t.id === 'antigravity');
    const claude = targets.find((t) => t.id === 'claude-code');
    expect(agy).toBeDefined();
    expect(claude).toBeDefined();
  });

  it('builds standard server config for Antigravity / Desktop', () => {
    const cfg = buildServerConfig('/path/to/db-mcp.js', {
      POSTGRES_URL: 'postgresql://ro:pass@localhost:5432/db',
      SQLSERVER_URL: ''
    });

    expect(cfg['command']).toBe('node');
    expect(cfg['args']).toEqual(['/path/to/db-mcp.js', 'start']);
    expect(cfg['env']).toEqual({
      POSTGRES_URL: 'postgresql://ro:pass@localhost:5432/db'
    });
    expect(cfg['type']).toBeUndefined();
  });

  it('builds stdio config for Claude Code with type field', () => {
    const cfg = buildServerConfig('/path/to/db-mcp.js', {
      POSTGRES_URL: 'postgresql://ro:pass@localhost:5432/db'
    }, true);

    expect(cfg['type']).toBe('stdio');
    expect(cfg['command']).toBe('node');
  });

  it('writes config to target file safely and preserves existing servers', () => {
    // Initial file with an existing server
    const initial = {
      mcpServers: {
        other_tool: { command: 'other' }
      }
    };
    writeConfigToTarget(tempConfigFile, 'existing', { command: 'existing' });

    const serverConfig = buildServerConfig('/my/script.js', { PG_URL: 'val' });
    writeConfigToTarget(tempConfigFile, 'db-mcp', serverConfig);

    const saved = JSON.parse(readFileSync(tempConfigFile, 'utf8'));
    expect(saved.mcpServers['existing']).toBeDefined();
    expect(saved.mcpServers['db-mcp']).toBeDefined();
    expect(saved.mcpServers['db-mcp'].command).toBe('node');
  });
});
