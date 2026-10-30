# db-mcp-node

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B%20LTS-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0.4-orange.svg)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/Tests-264%20Passing-brightgreen.svg)]()
[![License](https://img.shields.io/badge/License-MIT-purple.svg)]()

A hardened, enterprise-grade, read-only relational database **Model Context Protocol (MCP)** server decoupled via the strict `DatabaseAdapter` contract. Engineered with defense-in-depth protection: **AST SQL Security Guard**, **Zero-Trust sanitization**, **in-memory dynamic PII masking**, **cryptographically chained Merkle audit trail (SHA-256)**, **execution plan cost gating with out-of-band human-in-the-loop approval**, **legacy database discovery**, and **heterogeneous cross-server federated queries without linked servers**.

---

## Repository & Identity

- **Canonical Repository**: [https://github.com/HenryD11703/mcp-db.git](https://github.com/HenryD11703/mcp-db.git)
- **Author / Developer**: `HenryD11703` ([3680558330101@ingenieria.usac.edu.gt](mailto:3680558330101@ingenieria.usac.edu.gt))
- **Dialects Supported**: PostgreSQL (`pg`) and Microsoft SQL Server (`mssql` / T-SQL).

---

## Key Capabilities & Security Invariants

```
+-----------------------------------------------------------------------------------------------+
|                                      LLM / MCP Client                                         |
+-----------------------------------------------------------------------------------------------+
                                                 │
                                                 ▼
+───────────────────────────────────────────────────────────────────────────────────────────────+
|                                        MCP Server Layer                                       |
|                                                                                               |
|  [ 1. Startup Preflight Gate ]  ──▶ Enforces database read-only privileges (fail-closed)     |
|  [ 2. AST Security Guard ]      ──▶ Rejects mutations, stacked statements (;), comments      |
|  [ 3. Cost & Limits Engine ]    ──▶ Gating via EXPLAIN, timeouts, and two-tier rate limits   |
|  [ 4. Quarantine Store ]        ──▶ PENDING_APPROVAL tickets for human operator review        |
|  [ 5. Driver Execution ]        ──▶ Parameterized typed queries ($1, @p1)                     |
|  [ 6. Data Masking Engine ]     ──▶ In-memory DPI, emails, phones, and financial balances     |
|  [ 7. Federated Orchestrator ]  ──▶ Safe cross-engine join with session HMAC pseudonymization |
|  [ 8. Zero-Trust Sanitizer ]    ──▶ Structural delimiters (<data_result>) against prompt inj. |
|  [ 9. Merkle Audit Logger ]     ──▶ SHA-256 append-only chained audit log (audit.jsonl)       |
+───────────────────────────────────────────────────────────────────────────────────────────────+
                                                 │
                                                 ▼
                        +────────────────────────────────────────────────+
                        |  PostgreSQL 12+   │   SQL Server 2017+ / Azure |
                        +────────────────────────────────────────────────+
```

### 1. Unbreakable Read-Only AST Guard
- Enforces strict single-statement `SELECT` as the root AST node using `node-sql-parser` and lexical token scanners.
- Strictly rejects stacked queries (`;`), mutating CTEs (`WITH ... INSERT/UPDATE/DELETE`), `SELECT INTO`, table locking hints, obfuscating comments (`--`, `/* ... */`), and catalog modifications.
- Fails closed on syntax ambiguities or dialect edge-cases.

### 2. Fail-Closed Startup Preflight Check
- Before accepting any query, `StartupPreflightGate` connects to each database adapter and inspects system catalogs (`pg_roles`, `sys.fn_my_permissions`, `information_schema.table_privileges`).
- Aborts server startup immediately if the configured principal possesses write grants (`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER`, `CREATE`, `DROP`, `sysadmin`, `superuser`).

### 3. Execution Plan Cost Evaluation & Engine Cancellation
- Evaluates estimated rows and costs using native database execution plans (`EXPLAIN JSON` in PostgreSQL, `SET SHOWPLAN_XML ON` in SQL Server).
- Automatically rejects queries exceeding critical cost thresholds or performing unindexed sequential scans on protected tables (`BLOCKED_BY_COST`).
- True cancellation at the database engine level (`pg_cancel_backend` / `Request.cancel()`) when execution timeout is reached, logging `CANCELLED_BY_TIMEOUT`.
- In-memory two-tier sliding-window rate limiter (per-client and global).

### 4. Asynchronous Human-in-the-Loop Quarantine
- Moderate-risk queries transition to `PENDING_APPROVAL` with an expiration TTL (15 minutes by default) without hanging client connections.
- Constitutionally bars the AI from approving its own queries (principle of non-self-authorization).
- Human operators review and authorize or reject queries out-of-band via the `db-mcp` CLI.
- Passive read-only tool `get_query_result` allows clients to check ticket statuses and retrieve masked results once approved.

### 5. In-Memory Privacy & Dynamic Masking
- Sensitive data is dynamically masked before serialization:
  - **DPI / National IDs**: Masked leaving only the last 4 digits (`*********1234`).
  - **Emails**: Partially obfuscated (`u***r@domain.com`).
  - **Phone Numbers**: International & local formats masked (`+502 **** 5678`).
  - **Financial Balances & Totals**: Obfuscated or zero-redacted based on profile rules.
- Masking occurs strictly in volatile memory; raw sensitive values never leave the MCP server process.

### 6. Zero-Trust Prompt Injection Defense
- Results are enclosed in strict semantic XML boundaries (`<data_result>`) or typed JSON blocks.
- Dangerous delimiter strings, control characters, markdown escapes, and injection vectors inside database rows are neutralized before LLM delivery.

### 7. Cryptographically Chained Merkle Audit Trail
- Every operation creates a JSON Lines entry in `audit.jsonl`.
- Entries are cryptographically chained via `SHA-256(previousHash + canonicalJson)`.
- Zero PII leakage: all string literals (`'[REDACTED_LITERAL]'`) and numbers (`[REDACTED_NUM]`) are redacted from logged SQL.
- Built-in automatic log rotation preserving the hash chain across files.
- Dedicated `audit-verify` CLI tool for forensic verification of log integrity.

### 8. Legacy Database Understanding & Discovery
- Introspects legacy catalogs without reading user rows.
- Infers implicit foreign keys based on column names, data types, and bounded value containment sampling.
- Integrates a hot-reloadable business glossary (`docs/glossary.yaml`) for resolving legacy acronyms and business jargon.

### 9. Secure Federated Cross-Database Queries
- Executes federated joins across heterogeneous engines (e.g., PostgreSQL ↔ SQL Server) in process memory without database-level linked servers or `OPENQUERY`.
- Extracted join keys from source queries are treated as untrusted data and strictly injected into target queries as typed parameters (`$1, $2, ...` or `@p1, @p2, ...`), preventing second-order SQL injection.
- Configurable join key cap defaulting to 500 parameters (well within SQL Server's 2,100 limit).
- In-memory hash join executes on raw values, followed by session-bound deterministic pseudonymization (`pseudo_<16_hex>`) using HMAC-SHA256 with an ephemeral 32-byte salt, allowing analytical correlation without exposing raw keys.
- All federated steps share a unified `federation_id` (`correlationId`) across audit logs.

---

## MCP Tools Catalog

The server exposes **9 specialized MCP tools** for LLM agents:

| Tool Name | Scope | Description | Inputs |
| :--- | :---: | :--- | :--- |
| `query_database` | Query | Executes a strictly read-only `SELECT` query through AST validation, cost evaluation, in-memory masking, and Zero-Trust wrapping. | `adapterId`, `sql`, `params?`, `format?` (`semantic_xml` \| `strict_json`) |
| `explain_query` | Query | Preflight analysis returning execution plan cost, warnings, and risk profile without fetching data. | `adapterId`, `sql`, `params?` |
| `introspect_schema` | Schema | Returns normalized database schema catalog (tables, views, columns, keys). | `adapterId` |
| `get_query_result` | Quarantine | Passively polls status or retrieves masked data for queries queued in `PENDING_APPROVAL`. | `approvalId` |
| `search_catalog` | Discovery | Fuzzy natural language search across table and column names and glossary descriptions. | `adapterId`, `query`, `limit?` |
| `get_table_context` | Discovery | Retrieves comprehensive table metadata, declared constraints, and inferred foreign keys. | `adapterId`, `tableName` |
| `infer_relationships` | Discovery | Discovers undocumented, implicit relationships between tables using containment analysis. | `adapterId`, `tableName?`, `confidenceThreshold?` |
| `lookup_glossary` | Glossary | Resolves domain terms, abbreviations, and table/column annotations from `glossary.yaml`. | `term` |
| `execute_federated_query` | Federation | Orchestrates cross-database join across distinct database servers with typed parameter binding and session pseudonymization. | `sourceAdapterId`, `sourceSql`, `sourceKeyColumn`, `targetAdapterId`, `targetSqlTemplate`, `targetJoinColumn`, `joinType?`, `maxKeys?` |

---

## Installation & Build

### Prerequisites
- **Node.js**: `v20.0.0` LTS or higher
- **Package Manager**: `npm` v10+

### Setup
```bash
# Clone the repository
git clone https://github.com/HenryD11703/mcp-db.git
cd db-mcp-node

# Install dependencies
npm install

# Compile TypeScript to dist/
npm run build

# Verify type safety
npm run typecheck
```

---

## Configuration & Deployment

### 1. Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `POSTGRES_URL` / `PG_URL` | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`) | _Optional_ |
| `PG_ADAPTER_ID` | Identifier registered for the PostgreSQL adapter | `postgres` |
| `SQLSERVER_URL` / `MSSQL_URL` | SQL Server connection string (`Server=host,1433;Database=db;...`) | _Optional_ |
| `MSSQL_ADAPTER_ID` | Identifier registered for the SQL Server adapter | `sqlserver` |
| `AUDIT_LOG_PATH` | Path for the active append-only audit file | `audit.jsonl` |
| `APPROVAL_STORE_PATH` | Path for the pending approval tickets store | `.db-mcp/pending-approvals.json` |
| `GLOSSARY_PATH` | Path to the business glossary file | `docs/glossary.yaml` |
| `MCP_CONFIG_PATH` | Path to JSON multi-adapter configuration file | _Optional_ |

### 2. Multi-Adapter JSON Configuration (`config.json`)
You can configure multiple databases using a single configuration file:

```json
{
  "adapters": [
    {
      "id": "crm-postgres",
      "type": "postgres",
      "connectionString": "postgresql://mcp_ro:SuperSecret@pg-host:5432/crm"
    },
    {
      "id": "billing-sqlserver",
      "type": "sqlserver",
      "connectionString": "Server=mssql-host,1433;Database=billing;User Id=mcp_ro;Password=SuperSecret;TrustServerCertificate=true;"
    }
  ]
}
```

---

## Interactive Auto-Installer (`npm run install:mcp`)

The project includes an interactive setup wizard that automatically discovers your installed AI agents (**Google Antigravity**, **Claude Code CLI**, and **Claude Desktop**), prompts for database connection strings, and safely writes the server configuration directly into their configuration files (creating `.bak` backups automatically):

```bash
# Run the interactive configuration wizard:
npm run install:mcp

# Or via the db-mcp binary:
node dist/src/bin/db-mcp.js install
```

---

## Connecting to MCP Clients

### Claude Desktop (`claude_desktop_config.json`)
Add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "enterprise-databases": {
      "command": "node",
      "args": [
        "c:/Users/hquel/Documents/db-mcp-node/dist/src/bin/db-mcp.js",
        "start"
      ],
      "env": {
        "POSTGRES_URL": "postgresql://mcp_ro:Password123@localhost:5432/production_db",
        "SQLSERVER_URL": "Server=localhost,1433;Database=finance_db;User Id=mcp_ro;Password=Password123;TrustServerCertificate=true;",
        "AUDIT_LOG_PATH": "c:/Users/hquel/Documents/db-mcp-node/audit.jsonl"
      }
    }
  }
}
```

### Cursor & Antigravity MCP Config
Configure the command as `node` with arguments pointing to `dist/src/bin/db-mcp.js start` and the appropriate environment variables.

---

## Operator CLI (`db-mcp`)

The server bundles a dedicated operator CLI for managing queued queries and starting the service:

```bash
# Start the MCP server over Stdio transport
npm run cli:db-mcp start

# Start using a multi-adapter configuration file
npm run cli:db-mcp start -- --config ./config.json

# List pending queries awaiting human approval
npm run cli:db-mcp list-pending

# Approve a quarantined query
npm run cli:db-mcp approve appr_3fa85f64-5717-4562-b3fc-2c963f66afa6 -- --reason "Approved by Security Lead"

# Reject a quarantined query
npm run cli:db-mcp reject appr_3fa85f64-5717-4562-b3fc-2c963f66afa6 -- --reason "Estimated cost too high"
```

---

## Forensic Audit Verification (`audit-verify`)

Verify that the append-only Merkle hash chain has not been tampered with, edited, or truncated:

```bash
# Run verification on the default audit log
npm run audit:verify

# Or verify an explicit log file
node dist/src/bin/audit-verify.js ./audit.jsonl
```

### Verification Exit Codes & Output
- **Exit Code 0 (Valid)**:
  ```
  [AUDIT VERIFY SUCCESS] Cadena de auditoría 100% íntegra y auténtica.
  Total de entradas verificadas: 42
  Rango de secuencias: 1 a 42
  ```
- **Exit Code 1 (Tampered)**:
  Detailed forensic diagnostics showing line number, sequence number, correlation ID, and violation reason (`HASH_MISMATCH`, `PREVIOUS_HASH_MISMATCH`, `SEQUENCE_GAP`, or `INVALID_JSON`).

---

## Test Suite & Verification

The project includes an adversarial test suite, contract suites, and end-to-end integration tests:

```bash
# Run the complete test suite (44 test suites, 264 tests)
npm test

# Run adversarial SQL injection & bypass test suite
npm run test:adversarial

# Run second-order SQL injection test
npx vitest run tests/adversarial/second-order-sqli.spec.ts

# Run cost limits & rate limiter tests
npm run test:limits
npm run test:rate-limit

# Run human-in-the-loop approval tests
npm run test:approval

# Run catalog discovery & glossary tests
npm run test:discovery

# Run audit chain integrity tests
npm run test:audit
```

---

## Security Guarantees & Non-Goals

### Guarantees
1. **Zero Database Mutations**: No mutation query can bypass the AST parser, lexical scanner, and database read-only user enforcement.
2. **Zero Second-Order SQLi**: Extracted federated join keys are treated as untrusted data and strictly bound as dialetic-specific typed parameters.
3. **Zero Plaintext PII in Logs**: Logged queries have all literals redacted; sensitive data fields are pseudonymized or masked in memory.
4. **No AI Self-Approval**: The MCP server strictly forbids the AI model from authorizing its own quarantined tickets.

### Non-Goals
- **Write Operations**: No `INSERT`, `UPDATE`, `DELETE`, or DDL statements will ever be supported.
- **Arbitrary Code Execution**: No `xp_cmdshell`, user-defined script execution, or server-side linked server tunneling.

---

## License

MIT © [HenryD11703](https://github.com/HenryD11703) (USAC)
