# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Business amounts (`monto_*`, `saldo`, `balance`, `Q 1,234.56` patterns) are no longer masked by default; set `MASKING_MASK_AMOUNTS=true` to restore it. Salaries stay masked. The catalog's `isMasked` flag follows the same setting.

### Fixed
- `UPDATE ... SET` is now rejected as `NON_SELECT_ROOT` instead of being mislabelled `V10_SESSION_OR_INTERNAL_CMD`.

## [1.0.0] - 2026-11-02

### Added
- **Multi-Engine Relational Support**:
  - PostgreSQL 12+ (`pg` connection pool with read-only transaction defaults).
  - SQL Server 2017+ / Azure SQL (`mssql` pool with `SHOWPLAN_XML` cost analysis).
  - MySQL 8.0+ / MariaDB 10.5+ (`mysql2` pool with strict SQL modes, a `READ ONLY` session and `KILL QUERY <threadId>` cancellation; the startup preflight matches the exact `'user'@'host'` account and also rejects `FILE`, `LOCK TABLES`, `TRIGGER` and similar grants).
  - SQLite 3 (built-in `node:sqlite`, no native build step; needs Node.js 22.16+). Opens read-only with `query_only`, runs every statement in a killable child process (real cancellation, hard timeout, streamed row cap), resolves symlinks in the directory whitelist, rejects `:memory:`, and prices scans from table size so the cost gate works.
- **Defense-in-Depth Security Layers**:
  - Read-Only AST Guard (`node-sql-parser` + lexical scanner) rejecting stacked queries, mutating CTEs, `SELECT INTO`, comments outside literals, and dangerous procedures.
  - Fail-closed startup preflight gate inspecting user privileges (`pg_roles`, `sys.fn_my_permissions`, `information_schema.user_privileges`) before allowing connection.
  - Native execution plan cost evaluation with operational limits (max rows ceiling, sliding-window rate limiters).
  - Human-in-the-loop quarantine tickets for high-cost queries with asynchronous out-of-band CLI approvals (`db-mcp approve/reject`).
  - Robust in-memory PII/financial masking engine supporting:
    - Guatemalan SAT NIT Modulo 11 check-digit algorithm and hyphenated formats.
    - National identification numbers (DPI/CUI), emails, phone numbers, and monetary balances.
    - Morphological segmentation for continuous concatenation names (`galempnit`, `clinit`, `emp_nit`) using `UnifiedPrefixCatalog`.
    - Zero false positives on legitimate business terminology (`unit`, `unit_price`, `monitor`, `benito`, `definition`, `nitrate`, `thumbnail`) via `SafeVocabularyDictionary`.
    - Content pattern fallback with non-downgrade rules.
  - Zero-trust prompt injection neutralization wrapping query results in semantic XML (`<database_records>`) or strict machine-readable JSON.
  - Cryptographically chained audit log (`audit.jsonl`) with HMAC/SHA-256 integrity, SQL literal redaction, rotation, and CLI verification (`audit-verify`).
- **Legacy Database Discovery & Federation**:
  - Schema catalog introspection without reading user rows.
  - Undeclared Foreign Key inference engine combining token scoring with value containment testing.
  - Hot-reloading YAML business glossary (`glossary.yaml`) for mapping legacy abbreviations to domain concepts.
  - Heterogeneous cross-database memory joins with typed parameter binding to prevent second-order SQL injection, coupled with deterministic HMAC session pseudonymization.
- **Operator CLI & Developer Experience**:
  - Interactive multi-agent installer (`db-mcp install`) supporting Claude Code, Claude Desktop, and Google Antigravity.
  - Connection management: `db-mcp add`, `connections`, `remove`, `test`.
  - Comprehensive system health diagnostics command: `db-mcp doctor`.
  - Multi-OS GitHub Actions CI matrix across Ubuntu, Windows, and macOS.
