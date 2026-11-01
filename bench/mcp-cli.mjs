// Usage: node bench/mcp-cli.mjs <tool> '<json args>'   -> prints the MCP tool result (what an agent would see).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { connect } from './mcp-client.mjs';

const [tool, raw = '{}'] = process.argv.slice(2);
if (!tool) {
  console.error('usage: mcp-cli.mjs <tool> [jsonArgs | @file.json]');
  process.exit(2);
}
// '@file.json' reads the args from a file (avoids shell quoting problems with SQL quotes).
const args = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw);
const s = await connect();
if (tool === 'tools') {
  console.log((await s.client.listTools()).tools.map((t) => `${t.name}: ${t.description}\n  ${JSON.stringify(t.inputSchema)}`).join('\n\n'));
} else {
  const r = await s.call(tool, args);
  mkdirSync(new URL('./.out/', import.meta.url), { recursive: true });
  appendFileSync(new URL(`./.out/calls-${args.adapterId ?? 'none'}.log`, import.meta.url), `${tool}\t${r.isError ? 'ERROR' : 'ok'}\n`);
  console.log(r.text);
}
await s.close();
