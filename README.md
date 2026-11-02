<div align="center">

# db-mcp-node

**A read-only database MCP server your security team can say yes to.**<br>
Let AI agents explore PostgreSQL and SQL Server, including legacy schemas with no documentation, without ever being able to change a row.

[![npm](https://img.shields.io/npm/v/db-mcp-node?color=cb3837&logo=npm)](https://www.npmjs.com/package/db-mcp-node)
[![CI](https://github.com/HenryD11703/mcp-db/actions/workflows/ci.yml/badge.svg)](https://github.com/HenryD11703/mcp-db/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-orange)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

</div>

---

## Why this exists

Pointing an LLM at a production database is useful and scary. `db-mcp-node` puts nine independent safeguards between the model and your data, so one failure is never enough to cause damage:

- **It cannot write.** SQL is parsed into an AST and only a single `SELECT` passes, and the server refuses to start if its database user could write anyway.
- **It cannot run away.** Query plans are costed before execution; expensive or cartesian queries are blocked or sent to a human.
- **It cannot leak.** IDs, emails, phones and balances are masked in memory, and the audit log never contains a literal value.
- **It can understand legacy databases.** It infers the foreign keys nobody ever declared, so an agent can rebuild the data model on its own.

| | |
| :--- | :--- |
| **Engines** | PostgreSQL 12+ · SQL Server 2017+ / Azure SQL · MySQL 8.0+ / MariaDB 10.5+ · SQLite 3 |
| **Clients** | Claude Code · Claude Desktop · Google Antigravity · any MCP client |
| **Runtime** | Node.js 20+ |

---

## Quick start

```bash
npm i -g db-mcp-node
db-mcp install
```

The wizard finds your AI agents, asks for your connection strings and registers the server in each one. Then add or check connections at any time:

```bash
db-mcp add erp --type postgres --url "postgresql://ro_user:pass@localhost:5432/erp"
db-mcp add legacy --type sqlserver --url "Server=host,1433;Database=db;User Id=ro;Password=pass;TrustServerCertificate=true;"
db-mcp add sales --type mysql --url "mysql://ro_user:pass@localhost:3306/sales"
db-mcp add local --type sqlite --url "./data/app.db"
db-mcp connections     # list them, passwords masked
db-mcp test            # connect, prove the user is read-only, check plan analysis
```

<p align="center">
  <img src="docs/img/install.svg" alt="Installation flow: npm install, db-mcp install, credentials file and agent configuration" width="900">
</p>

- Credentials live **once** in `~/.db-mcp/config.json` (owner-only, `0600`). Agent config files only say `db-mcp start`, with no secrets.
- The wizard never overwrites a config file it cannot parse, and keeps a timestamped `.bak` of every file it touches.
- Non-interactive (CI, scripts): `db-mcp install --yes --agent claude-code --pg-url "postgresql://..." --mode npx`
- Connection resolution at `db-mcp start`: `--config <file>` or `MCP_CONFIG_PATH` → `POSTGRES_URL` / `SQLSERVER_URL` env vars → `~/.db-mcp/config.json`.

### Create a read-only database user

The server **refuses to start** if its user has any write privilege, so use a dedicated read-only account.

<details>
<summary><b>PostgreSQL</b></summary>

```sql
CREATE ROLE mcp_ro LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE mydb TO mcp_ro;
GRANT USAGE ON SCHEMA public TO mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_ro;
ALTER ROLE mcp_ro SET default_transaction_read_only = on;
```
</details>

<details>
<summary><b>SQL Server</b></summary>

```sql
CREATE LOGIN mcp_ro WITH PASSWORD = 'change-me', CHECK_POLICY = ON;
USE mydb;
CREATE USER mcp_ro FOR LOGIN mcp_ro;
ALTER ROLE db_datareader ADD MEMBER mcp_ro;
GRANT SHOWPLAN TO mcp_ro;   -- required, see below
```
</details>

> **Important: SQL Server needs `GRANT SHOWPLAN`.** Cost gating reads the execution plan before each query. Without `SHOWPLAN` the plan cannot be checked, so the server fails safe and puts **every** query in `PENDING_APPROVAL`. Run `db-mcp test`: it warns you and prints the exact `GRANT` to run.

---

## How a request is protected

<p align="center">
  <img src="docs/img/architecture.svg" alt="db-mcp request pipeline: MCP client, nine protection stages, read-only databases" width="900">
</p>

### 1. Read-only AST guard
- Only a single `SELECT` is allowed as the root AST node (`node-sql-parser` plus a lexical scanner).
- Rejects stacked statements (`;`), mutating CTEs, `SELECT INTO`, locking hints, obfuscating comments and catalog changes.
- Fails closed on any syntax ambiguity.

### 2. Fail-closed startup preflight
- Before serving anything it inspects the database principal (`pg_roles`, `sys.fn_my_permissions`, `information_schema.table_privileges`).
- Aborts startup if the user holds `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER`, `CREATE`, `DROP`, `sysadmin` or superuser rights.

### 3. Cost evaluation and cancellation
- Uses native plans (`EXPLAIN (FORMAT JSON)` on PostgreSQL, `SET SHOWPLAN_XML` on SQL Server).
- Blocks queries over the cost or row thresholds, cartesian joins, and full scans of protected tables (`BLOCKED_BY_COST`).
- Cancels at the engine (`pg_cancel_backend`, `Request.cancel()`) on timeout and logs `CANCELLED_BY_TIMEOUT`.
- Two-tier sliding-window rate limiter (per client and global).

### 4. Human-in-the-loop quarantine
- Moderate-risk queries become `PENDING_APPROVAL` tickets (15 minute TTL) and never hang the client.
- The agent cannot approve its own tickets: approval happens out of band through the `db-mcp` CLI.
- `get_query_result` lets the agent poll a ticket and receive masked rows once approved.

<p align="center">
  <img src="docs/img/query-flow.svg" alt="Query decision flow: execute, quarantine for approval, or block by cost" width="900">
</p>

### 5. In-memory masking
- **National IDs** keep the last 4 digits (`*********1234`), **emails** are partly hidden (`u***r@domain.com`), **phones** are masked (`+502 **** 5678`), **balances** follow profile rules.
- Masking happens only in process memory. Raw sensitive values never leave the server.

### 6. Zero-trust prompt-injection defense
- Results are wrapped in strict semantic XML (`<data_result>`) or typed JSON.
- Delimiter strings, control characters and markdown escapes inside rows are neutralized before the model sees them.

### 7. Chained audit trail
- Every operation appends a JSON Lines entry to `audit.jsonl`, chained with `SHA-256(previousHash + canonicalJson)`.
- Literals are redacted from logged SQL (`'[REDACTED_LITERAL]'`, `[REDACTED_NUM]`), so there is no PII in the log.
- Log rotation keeps the chain intact, and `audit-verify` detects edits, gaps and truncation.

### 8. Legacy database understanding
- Introspects catalogs without reading user rows.
- Infers undeclared foreign keys from column names (including role suffixes such as `cod_suc_ori`), types and bounded value sampling. When a column has no name hint at all (a self-reference such as `cod_jefe`, or `cliente` pointing at `cod_cli`), it falls back to **value containment**: it tests the column against every same-type unique key in one query and reports ambiguous matches instead of guessing.
- Hot-reloadable business glossary (`glossary.yaml`) to translate legacy acronyms and domain codes.

### 9. Federated cross-database queries
- Joins PostgreSQL and SQL Server in process memory, with no linked servers or `OPENQUERY`.
- Join keys from the source are treated as untrusted and bound as typed parameters (`$1` / `@p1`), which blocks second-order SQL injection.

<p align="center">
  <img src="docs/img/federation.svg" alt="Federated query: source keys, typed parameters into the target engine, in-memory join, pseudonymization" width="900">
</p>

---

## MCP tools

The server exposes **10 tools**.

| Tool | Scope | What it does | Main inputs |
| :--- | :---: | :--- | :--- |
| `list_adapters` | Discovery | Lists the configured connections and their dialect. | none |
| `list_tables` | Discovery | Tables and views from system catalogs only (no rows read), with row estimates and glossary titles. | `adapterId`, `schema?`, `namePattern?`, `limit?`, `cursor?` |
| `describe_table` | Discovery | Columns, types, keys, indexes and declared foreign keys, enriched with glossary meanings. | `adapterId`, `table`, `schema?` |
| `infer_table_relationships` | Discovery | Scored hypotheses for undeclared foreign keys. `tables` is optional: omit it to analyze the whole schema. | `adapterId`, `tables?`, `minConfidence?`, `verifyStatistically?` |
| `search_glossary` | Glossary | Looks up business terms, synonyms and domain codes, and returns matching tables and columns. | `query`, `adapterId?`, `limit?` |
| `introspect_schema` | Schema | Full normalized catalog (tables, views, columns, keys). | `adapterId` |
| `query_database` | Query | Runs a read-only `SELECT` through AST validation, cost evaluation, masking and zero-trust wrapping. | `adapterId`, `sql`, `params?`, `format?` (`semantic_xml` \| `strict_json`) |
| `explain_query` | Query | Execution plan cost, warnings and risk profile without fetching data. | `adapterId`, `sql`, `params?` |
| `get_query_result` | Quarantine | Polls a `PENDING_APPROVAL` ticket and returns masked rows once approved. | `approvalId` |
| `execute_federated_query` | Federation | Cross-engine join with typed parameter binding and session pseudonymization. | `sourceAdapterId`, `sourceSql`, `sourceKeyColumn`, `targetAdapterId`, `targetSqlTemplate`, `targetJoinColumn`, `joinType?`, `maxKeys?` |

When only one adapter is configured, `adapterId` can be omitted.

### Discovery benchmark

`bench/` builds synthetic legacy ERPs with **no declared foreign keys** and a known answer, loads them into PostgreSQL and SQL Server with Docker, and scores how much of the data model is recovered. Default confidence threshold (0.7), read-only user, `infer_table_relationships` with no arguments:

| Schema | Real relationships | Recovered | False positives | Engines agree |
| :--- | :---: | :---: | :---: | :---: |
| 16 tables | 15 | 15 / 15 | 0 | yes |
| 100 tables (28 with opaque names or self-references) | 156 | 143 / 156 (91.7%) | 0 | yes |

What still gets missed in the 100-table schema are columns with no name hint whose values fit several parent keys equally well (small dense integer ids). When a text column fits two to five parents, the tool returns each candidate with `ambiguousWith` instead of guessing; beyond five it says nothing. Agents that verified candidates with `query_database` recovered 152 / 156 on both engines, with the remaining four being exactly those unresolvable ties. It is synthetic data, so treat it as a regression check, not a guarantee. See [`bench/`](bench) to run it (`BENCH_SPEC=large` selects the big schema).

---

## Configuration

### Environment variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `POSTGRES_URL` / `PG_URL` | PostgreSQL connection string | none |
| `PG_ADAPTER_ID` | Adapter id for the PostgreSQL URL | `postgres` |
| `SQLSERVER_URL` / `MSSQL_URL` | SQL Server connection string | none |
| `MSSQL_ADAPTER_ID` | Adapter id for the SQL Server URL | `sqlserver` |
| `MYSQL_URL` / `MYSQL_URI` | MySQL / MariaDB connection string | none |
| `MYSQL_ADAPTER_ID` | Adapter id for the MySQL URL | `mysql` |
| `SQLITE_PATH` / `SQLITE_URL` | SQLite database file path | none |
| `SQLITE_ADAPTER_ID` | Adapter id for the SQLite connection | `sqlite` |
| `SQLITE_ALLOWED_DIRECTORIES` | Comma-separated whitelist of allowed directories for SQLite files | current dir + db dir |
| `MASKING_CUSTOM_PREFIXES` | Comma-separated custom prefixes for continuous column name segmentation | none |
| `MCP_CONFIG_PATH` | JSON file with several adapters | none |
| `AUDIT_LOG_PATH` | Append-only audit file | `./audit.jsonl` if it exists, else `~/.db-mcp/audit.jsonl` |
| `APPROVAL_STORE_PATH` | Pending approval tickets | `~/.db-mcp/pending_approvals.json` |
| `GLOSSARY_PATH` | Business glossary file | `./docs/glossary.yaml`, then `~/.db-mcp/glossary.yaml`, then a bundled sample |
| `MCP_OUTPUT_FORMAT` | Default result encoding for `query_database`: `semantic_xml` or `strict_json` (machine-parseable) | `semantic_xml` |
| `MCP_OPERATOR_NAME` | Name recorded when you approve or reject | your OS user |

### Config file format

`~/.db-mcp/config.json` (managed by `db-mcp add`) and any `--config` file share one format:

```json
{
  "adapters": [
    { "id": "crm", "type": "postgres", "connectionString": "postgresql://mcp_ro:secret@pg-host:5432/crm" },
    { "id": "billing", "type": "sqlserver", "connectionString": "Server=mssql-host,1433;Database=billing;User Id=mcp_ro;Password=secret;TrustServerCertificate=true;" }
  ]
}
```

### Manual client setup

`db-mcp install` does this for you. To edit a client by hand, point it at `db-mcp start`. Credentials come from `~/.db-mcp/config.json`, so no secrets are needed in the client file.

<details>
<summary><b>Claude Desktop</b> (<code>claude_desktop_config.json</code>)</summary>

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "db-mcp",
      "args": ["start"]
    }
  }
}
```

Without a global install, use `"command": "npx"` and `"args": ["-y", "db-mcp-node", "start"]`.
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add db-mcp -- db-mcp start
claude mcp list
```
</details>

---

## Operator CLI

Humans approve quarantined queries and manage connections from the same binary:

```bash
db-mcp doctor                                    # comprehensive system, audit & adapter diagnostics
db-mcp list-pending                              # queries waiting for approval
db-mcp approve <approvalId> --reason "Reviewed"  # or: db-mcp approve latest
db-mcp reject  <approvalId> --reason "Too costly"

db-mcp add | connections | test | remove         # manage connections
db-mcp start [--config ./config.json]            # run the MCP server over stdio
```

### Verify the audit trail

```bash
audit-verify                 # default log
audit-verify ./audit.jsonl   # explicit file
```

Exit code `0` means the chain is intact (`Chain intact. N entries verified.`). Exit code `1` prints the line, sequence number, correlation id and reason (`HASH_MISMATCH`, `PREVIOUS_HASH_MISMATCH`, `SEQUENCE_GAP` or `INVALID_JSON`).

---

## Development

```bash
git clone https://github.com/HenryD11703/mcp-db.git
cd mcp-db
npm install
npm run build
npm test                   # full suite
npm run test:adversarial   # SQL injection and bypass corpus
npm run test:discovery     # catalog, inference and glossary
npm run test:audit         # audit chain integrity
```

Diagrams in this README are generated: edit [`docs/diagrams/build.mjs`](docs/diagrams/build.mjs) and run `node docs/diagrams/build.mjs`.

---

## Security guarantees and non-goals

**Guarantees**
1. **No database mutations.** No write can get past the AST parser, the lexical scanner and the read-only user check.
2. **No second-order SQL injection.** Federated join keys are untrusted data, bound only as typed parameters.
3. **No plaintext PII in logs.** Logged SQL has every literal redacted, and sensitive fields are masked in memory.
4. **No AI self-approval.** The model can never authorize its own quarantined query.

**Non-goals**
- Write operations of any kind (`INSERT`, `UPDATE`, `DELETE`, DDL) will never be supported.
- No arbitrary code execution: no `xp_cmdshell`, user scripts or linked-server tunneling.

---

## License

MIT © [HenryD11703](https://github.com/HenryD11703) · [Repository](https://github.com/HenryD11703/mcp-db) · [Report an issue](https://github.com/HenryD11703/mcp-db/issues)
