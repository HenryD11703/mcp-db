// Usage: node bench/score-agent.mjs pg|mssql   (reads bench/.out/agent-<id>.json and calls-<id>.log)
import { existsSync, readFileSync } from 'node:fs';
import { score } from './score.mjs';

const id = process.argv[2];
const out = new URL('./.out/', import.meta.url);
const file = new URL(`agent-${id}.json`, out);
if (!existsSync(file)) {
  console.error(`missing ${file.pathname}`);
  process.exit(1);
}
const agent = JSON.parse(readFileSync(file, 'utf8'));
const log = existsSync(new URL(`calls-${id}.log`, out)) ? readFileSync(new URL(`calls-${id}.log`, out), 'utf8').trim().split('\n') : [];
const byTool = {};
for (const l of log) byTool[l.split('\t')[0]] = (byTool[l.split('\t')[0]] ?? 0) + 1;
console.log(JSON.stringify({ adapter: id, toolCalls: log.length, byTool, ...score(agent.relationships) }, null, 2));
