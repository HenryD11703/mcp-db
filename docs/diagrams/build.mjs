// Generates the README diagrams as standalone SVGs (they render identically on GitHub and npm,
// where Mermaid is not available). Run: node docs/diagrams/build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../img');
mkdirSync(outDir, { recursive: true });

const C = {
  bg: '#f6f8fa', border: '#d0d7de', text: '#1f2328', muted: '#59636e', white: '#ffffff',
  blue: '#0969da', blueBg: '#ddf4ff', green: '#1a7f37', greenBg: '#dafbe1',
  amber: '#9a6700', amberBg: '#fff8c5', red: '#cf222e', redBg: '#ffebe9',
  purple: '#8250df', purpleBg: '#fbefff', gray: '#6e7781', grayBg: '#eaeef2'
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Rough text metrics (px per character) used only to warn about overflow; there is no renderer here.
const approx = (str, size, weight = 400, mono = false) => str.length * size * (mono ? 0.62 : weight >= 600 ? 0.6 : 0.56);
const warnings = [];
const check = (what, width, limit) => {
  if (width > limit) warnings.push(`${what}: ~${Math.round(width)}px > ${Math.round(limit)}px`);
};

class Svg {
  constructor(w, h, title) {
    this.w = w; this.h = h; this.title = title; this.parts = [];
  }
  add(s) { this.parts.push(s); }
  rect(x, y, w, h, { fill = C.white, stroke = C.border, r = 10, sw = 1.5, dash } = {}) {
    this.add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
  }
  text(x, y, s, { size = 13, weight = 400, fill = C.text, anchor = 'middle', mono = false } = {}) {
    this.add(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${mono ? ' font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"' : ''}>${esc(s)}</text>`);
  }
  /** Rounded box with a bold title and optional subtitle lines, centered. */
  box(x, y, w, h, title, subs = [], { fill = C.white, stroke = C.border, tc = C.text, mono = false } = {}) {
    this.rect(x, y, w, h, { fill, stroke });
    check(`box title "${title}"`, approx(title, 14, 600, mono), w - 16);
    subs.forEach((t) => check(`box sub "${t}"`, approx(t, 12), w - 16));
    const lines = subs.length;
    const total = 16 + lines * 16;
    let ty = y + h / 2 - total / 2 + 14;
    this.text(x + w / 2, ty, title, { size: 14, weight: 600, fill: tc, mono });
    subs.forEach((s, i) => this.text(x + w / 2, ty + 18 + i * 16, s, { size: 12, fill: C.muted }));
  }
  arrow(x1, y1, x2, y2, { label, color = C.gray, dash, lx, ly } = {}) {
    this.add(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#a-${color.slice(1)})"/>`);
    if (label) this.text(lx ?? (x1 + x2) / 2, ly ?? (y1 + y2) / 2 - 7, label, { size: 12, fill: C.muted });
  }
  poly(points, { color = C.gray, dash, label, lx, ly } = {}) {
    this.add(`<polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#a-${color.slice(1)})"/>`);
    if (label) this.text(lx, ly, label, { size: 12, fill: C.muted });
  }
  badge(cx, cy, n, color = C.blue) {
    this.add(`<circle cx="${cx}" cy="${cy}" r="12" fill="${color}"/>`);
    this.text(cx, cy + 4.5, n, { size: 12, weight: 700, fill: C.white });
  }
  chip(x, y, label, { fill, stroke, color }) {
    const w = label.length * 6.6 + 16;
    this.rect(x, y, w, 20, { fill, stroke, r: 10, sw: 1 });
    this.text(x + w / 2, y + 14, label, { size: 11, weight: 600, fill: color });
    return w;
  }
  render() {
    const colors = [...new Set(this.parts.join('').match(/#a-([0-9a-f]{6})/g) ?? [])].map((m) => m.slice(3));
    const markers = colors
      .map((c) => `<marker id="a-${c}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#${c}"/></marker>`)
      .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}" role="img" aria-label="${esc(this.title)}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<title>${esc(this.title)}</title>
<defs>${markers}</defs>
<rect width="${this.w}" height="${this.h}" rx="14" fill="${C.bg}" stroke="${C.border}"/>
${this.parts.join('\n')}
</svg>
`;
  }
}

function save(name, svg) {
  if (warnings.length) console.warn(`[${name}] possible overflow:\n  ` + warnings.splice(0).join('\n  '));
  writeFileSync(resolve(outDir, name), svg.render());
  console.log('wrote', name);
}

/* ---------------------------------------------------------------- 1. architecture */
{
  const s = new Svg(900, 760, 'db-mcp architecture: MCP client, nine-stage protection pipeline, read-only databases');
  s.text(450, 34, 'db-mcp request pipeline', { size: 18, weight: 700 });

  s.box(250, 56, 400, 58, 'LLM / MCP client', ['Claude Code · Claude Desktop · Antigravity · Cursor'], { fill: C.blueBg, stroke: C.blue, tc: C.blue });
  s.arrow(450, 114, 450, 148, { label: 'MCP over stdio', color: C.blue, lx: 540, ly: 135 });

  s.rect(60, 150, 780, 470, { fill: C.white, stroke: C.blue, r: 14, sw: 2 });
  s.text(80, 176, 'db-mcp server', { size: 14, weight: 700, fill: C.blue, anchor: 'start' });

  const rows = [
    ['Startup preflight gate', 'Refuses to start if the database principal can write (fail-closed)', 'startup', 'gray'],
    ['AST security guard', 'Single SELECT only: rejects mutations, stacked statements, comments', 'per query', 'blue'],
    ['Cost & limits engine', 'EXPLAIN-based gating, timeouts, two-tier rate limiting', 'per query', 'blue'],
    ['Quarantine store', 'PENDING_APPROVAL tickets approved by a human, never by the AI', 'per query', 'blue'],
    ['Driver execution', 'Parameterized, typed queries ($1 / @p1)', 'per query', 'blue'],
    ['Data masking engine', 'IDs, emails, phones and balances masked in memory', 'per query', 'blue'],
    ['Federated orchestrator', 'Cross-engine join with session HMAC pseudonymization', 'federation', 'purple'],
    ['Zero-trust sanitizer', 'Delimiters and escaping against prompt injection', 'per query', 'blue'],
    ['Merkle audit logger', 'SHA-256 chained, append-only audit.jsonl', 'always', 'green']
  ];
  const chipStyle = {
    gray: { fill: C.grayBg, stroke: C.gray, color: C.gray },
    blue: { fill: C.blueBg, stroke: C.blue, color: C.blue },
    purple: { fill: C.purpleBg, stroke: C.purple, color: C.purple },
    green: { fill: C.greenBg, stroke: C.green, color: C.green }
  };
  rows.forEach(([title, sub, tag, color], i) => {
    const y = 192 + i * 47;
    s.rect(80, y, 740, 40, { fill: C.bg, stroke: C.border, r: 8, sw: 1 });
    s.badge(104, y + 20, i + 1, chipStyle[color].stroke);
    s.text(128, y + 17, title, { size: 14, weight: 600, anchor: 'start' });
    s.text(128, y + 33, sub, { size: 12, fill: C.muted, anchor: 'start' });
    const w = tag.length * 6.6 + 16;
    check(`row "${title}"`, 48 + approx(sub, 12), 740 - w - 24);
    s.chip(800 - w, y + 10, tag, chipStyle[color]);
  });

  s.arrow(450, 620, 450, 660, { label: 'read-only principal', color: C.green, lx: 545, ly: 646 });
  s.box(160, 662, 280, 62, 'PostgreSQL 12+', ['SELECT-only role'], { fill: C.greenBg, stroke: C.green, tc: C.green });
  s.box(460, 662, 280, 62, 'SQL Server 2017+ / Azure SQL', ['db_datareader + SHOWPLAN'], { fill: C.greenBg, stroke: C.green, tc: C.green });
  save('architecture.svg', s);
}

/* ---------------------------------------------------------------- 2. approval flow */
{
  const s = new Svg(900, 520, 'Query decision flow: execute, quarantine for human approval, or block by cost');
  s.text(450, 34, 'What happens to a query', { size: 18, weight: 700 });

  s.box(30, 168, 150, 64, 'query_database', ['agent sends SQL'], { fill: C.blueBg, stroke: C.blue, tc: C.blue, mono: true });
  s.arrow(180, 200, 198, 200);
  s.box(200, 168, 150, 64, 'AST guard', ['SELECT only?'], { fill: C.white, stroke: C.blue });
  s.arrow(350, 200, 368, 200);
  s.box(370, 168, 150, 64, 'Cost evaluation', ['EXPLAIN / SHOWPLAN'], { fill: C.white, stroke: C.blue });

  // outcomes of the cost evaluation
  s.poly([[520, 184], [560, 184], [560, 90], [600, 90]], { color: C.green });
  s.text(554, 140, 'low risk', { size: 12, fill: C.muted, anchor: 'end' });
  s.arrow(520, 200, 600, 200, { color: C.amber });
  s.text(560, 192, 'moderate', { size: 12, fill: C.muted });
  s.poly([[520, 216], [560, 216], [560, 380], [600, 380]], { color: C.red });
  s.text(554, 330, 'critical', { size: 12, fill: C.muted, anchor: 'end' });

  s.box(600, 60, 270, 60, 'EXECUTED', ['masked rows returned'], { fill: C.greenBg, stroke: C.green, tc: C.green });
  s.box(600, 170, 270, 60, 'PENDING_APPROVAL', ['ticket, expires in 15 min'], { fill: C.amberBg, stroke: C.amber, tc: C.amber });
  s.box(600, 350, 270, 60, 'BLOCKED_BY_COST', ['cartesian join / huge scan'], { fill: C.redBg, stroke: C.red, tc: C.red });

  // human in the loop
  s.arrow(735, 230, 735, 262, { color: C.purple, dash: '5 4' });
  s.box(600, 264, 270, 64, 'Human operator', ['db-mcp approve | reject', 'agent then polls get_query_result'], { fill: C.purpleBg, stroke: C.purple, tc: C.purple });

  // guard rejection
  s.poly([[275, 232], [275, 460], [600, 460]], { color: C.red, dash: '5 4' });
  s.text(300, 452, 'mutation, stacked statement or comment', { size: 12, fill: C.muted, anchor: 'start' });
  s.box(600, 430, 270, 60, 'REJECTED', ['BLOCKED_BY_GUARD'], { fill: C.redBg, stroke: C.red, tc: C.red });

  s.text(30, 508, 'Every outcome is written to the SHA-256 chained audit log.', { size: 12, fill: C.muted, anchor: 'start' });
  save('query-flow.svg', s);
}

/* ---------------------------------------------------------------- 3. federation */
{
  const s = new Svg(900, 360, 'Federated query: keys from source engine, typed parameters into target engine, in-memory join');
  s.text(450, 34, 'Cross-database join without linked servers', { size: 18, weight: 700 });

  const steps = [
    ['1', 'Source query', ['runs on engine A', 'e.g. PostgreSQL'], C.green, C.greenBg],
    ['2', 'Extract keys', ['untrusted data', 'capped at 500'], C.amber, C.amberBg],
    ['3', 'Target query', ['keys bound as typed', 'params ($1 / @p1)'], C.green, C.greenBg],
    ['4', 'In-memory join', ['hash join on raw', 'values, in process'], C.blue, C.blueBg],
    ['5', 'Pseudonymize', ['HMAC-SHA256 with an', 'ephemeral salt'], C.purple, C.purpleBg]
  ];
  const w = 152, gap = 28, x0 = 30;
  steps.forEach(([n, t, subs, stroke, fill], i) => {
    const x = x0 + i * (w + gap);
    s.box(x, 110, w, 96, t, subs, { fill, stroke, tc: stroke });
    s.badge(x + 18, 110, n, stroke);
    if (i < steps.length - 1) s.arrow(x + w, 158, x + w + gap, 158);
  });
  s.text(450, 250, 'Each step shares one federation_id in the audit log. Raw join keys never reach the agent.', { size: 13, fill: C.muted });

  s.box(30, 280, 380, 52, 'Engine A  ·  PostgreSQL or SQL Server', [], { fill: C.greenBg, stroke: C.green, tc: C.green });
  s.box(490, 280, 380, 52, 'Engine B  ·  SQL Server or PostgreSQL', [], { fill: C.greenBg, stroke: C.green, tc: C.green });
  s.arrow(106, 206, 106, 278, { color: C.green, dash: '4 3' });
  s.arrow(486, 206, 560, 278, { color: C.green, dash: '4 3' });
  save('federation.svg', s);
}

/* ---------------------------------------------------------------- 4. install flow */
{
  const s = new Svg(900, 420, 'Installation: npm install, db-mcp install, central credentials file, agent configuration');
  s.text(450, 34, 'From install to first query', { size: 18, weight: 700 });

  s.box(30, 80, 220, 70, 'npm i -g db-mcp-node', ['one command'], { fill: C.blueBg, stroke: C.blue, tc: C.blue, mono: true });
  s.arrow(250, 115, 300, 115);
  s.box(302, 80, 220, 70, 'db-mcp install', ['wizard or --yes flags'], { fill: C.blueBg, stroke: C.blue, tc: C.blue, mono: true });

  s.poly([[522, 100], [570, 100], [570, 60], [600, 60]], { color: C.green });
  s.poly([[522, 130], [570, 130], [570, 190], [600, 190]], { color: C.blue });
  s.box(602, 30, 270, 70, '~/.db-mcp/config.json', ['credentials, owner-only (0600)'], { fill: C.greenBg, stroke: C.green, tc: C.green, mono: true });
  s.box(602, 155, 270, 70, 'Agent config', ['Claude Code · Desktop · Antigravity', 'command: db-mcp start (no secrets)'], { fill: C.white, stroke: C.blue });

  s.text(30, 262, 'Manage connections any time', { size: 14, weight: 700, anchor: 'start' });
  const cmds = [['db-mcp add', 'save a connection'], ['db-mcp connections', 'list, passwords masked'], ['db-mcp test', 'connect + preflight'], ['db-mcp remove', 'delete a connection']];
  cmds.forEach(([c, d], i) => s.box(30 + i * 213, 276, 195, 62, c, [d], { fill: C.white, stroke: C.border, mono: true }));

  s.rect(30, 356, 840, 46, { fill: C.white, stroke: C.border, r: 8, sw: 1 });
  check('install footer', approx('At runtime: db-mcp start reads config.json, preflight proves read-only, MCP tools go live', 13), 800);
  s.text(50, 384, 'At runtime: db-mcp start reads config.json, preflight proves read-only, MCP tools go live', { size: 13, fill: C.text, anchor: 'start' });
  save('install.svg', s);
}
