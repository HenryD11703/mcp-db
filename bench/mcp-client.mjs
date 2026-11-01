import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const BENCH_ENV = {
  POSTGRES_URL: 'postgresql://bench_ro:RoBench%232026@localhost:15432/bench',
  SQLSERVER_URL: 'Server=localhost,14330;Database=bench;User Id=bench_ro;Password=RoBench#2026;TrustServerCertificate=true;',
  PG_ADAPTER_ID: 'pg',
  MSSQL_ADAPTER_ID: 'mssql',
  AUDIT_LOG_PATH: resolve(root, 'bench/.out/audit.jsonl'),
  PENDING_APPROVAL_STORE_PATH: resolve(root, 'bench/.out/pending.json')
};

export async function connect(env = BENCH_ENV) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(root, 'dist/src/bin/db-mcp.js'), 'start'],
    env: { ...process.env, ...env },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'bench', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  let calls = 0;
  const call = async (name, args) => {
    calls++;
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.map((c) => c.text ?? '').join('') ?? '';
    let json;
    try {
      const start = text.search(/^[{[]/m);
      json = JSON.parse(start === -1 ? text : text.slice(start, text.lastIndexOf('}') + 1));
    } catch {
      json = undefined;
    }
    return { isError: Boolean(res.isError), text, json };
  };
  return { client, call, close: () => client.close(), get calls() { return calls; } };
}
