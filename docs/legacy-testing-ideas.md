# Legacy Databases & Challenges for Testing `db-mcp`

This guide documents candidate legacy databases, investigative mystery games, and real-world datasets for rigorously testing the capabilities of `db-mcp`:
- **Feature 005 (Legacy DB Understanding)**: Implicit foreign key inference (`infer_table_relationships`), glossary enrichment (`lookup_glossary`), and catalog navigation (`list_tables`, `describe_table`).
- **Feature 006 (Secure Federated Query)**: In-memory cross-database joins and session pseudonymization (`execute_federated_query`).
- **Feature 004 (Cost Limits & Human Approval)**: Execution plan risk gating, quarantine (`PENDING_APPROVAL`), and operator decisions.

---

## 1. SQL Murder Mystery (Interactive Detective Game) 🕵️‍♂️

- **Origin**: Knight Lab (Northwestern University).
- **Format**: Originally SQLite, easily ported to SQL Server (T-SQL) or PostgreSQL.
- **Premise**:
  A murder occurred in *"SQL City"* on **January 15, 2018**. The AI agent is given only the date and the city.
- **Investigation Trail**:
  1. Retrieve police report from `crime_scene_report` to locate the crime and witness addresses.
  2. Locate witnesses in `person` and retrieve their testimonies from `interview`.
  3. Witnesses mention clues:
     - *"Suspect had a gym bag from 'Get Fit Now' with membership starting with 48Z"*.
     - *"Suspect was driving a gold car with license plate containing H42W"*.
  4. Cross-reference `get_fit_now_member`, `get_fit_now_check_in`, and `drivers_license`.
  5. Identify the hitman (`interview` with the hitman reveals they were paid by an ultra-wealthy mastermind).
  6. Query `facebook_event_checkin` and `income` to uncover the mastermind.
- **Why It's Ideal for `db-mcp`**:
  - Tests natural language queries, table context retrieval, and multi-step joins.
  - Fun, engaging, and verifies that the AI can perform iterative forensic deduction using only read-only tools.

---

## 2. PKDD'99 Financial Dataset (The True Legacy Horror) 🏦

- **Origin**: Real Czech Bank dataset from 1999 released for the PKDD'99 conference.
- **Schema**:
  - Tables: `client`, `account`, `disp` (dispositions), `order` (standing orders), `trans` (transactions), `loan`, `card`.
  - Cryptic column names: `k_symbol` (character codes in Czech: `'POJISTNE'` = insurance, `'SIPO'` = household payments, `'LEASING'`, `'UVER'` = loan payment), `c_operation`, `a_id`, `trans_type`.
- **Difficulty**:
  - **Zero declared Foreign Keys**: Relationships exist purely by naming conventions and application logic (`account_id`, `client_id`, `disp_id`).
  - Perfect for testing `infer_table_relationships` (containment sampling and statistical scoring).
  - Perfect for configuring and testing the business glossary (`docs/glossary.yaml`) to map Czech/legacy acronyms to human semantics.

---

## 3. Microsoft Historical Relics (Pubs & Northwind) 📦

- **Origin**: Microsoft SQL Server official demonstration databases (1994–2000).
- **Pubs**:
  - Focus: Book publishing house.
  - Quirks: Unconventional composite keys (`title_id`, `au_id`), non-surrogate identifiers, vintage data types (`text`, `image`), and royalty calculation schedules (`roysched`).
- **Northwind**:
  - Focus: Specialty foods export/import trading company.
  - Quirks: Self-referencing recursive hierarchy (`Employees.ReportsTo`), composite primary keys in `Order Details` (`OrderID` + `ProductID`), and freight calculations.
- **Compatibility**: Available as native `.sql` scripts directly executable on any SQL Server edition.

---

## 4. Academic Text-to-SQL Benchmarks (Spider & BIRD-SQL) 📊

- **Spider** (Yale University) & **BIRD-SQL** (Big Bench for Large-scale Database Grounded Text-to-SQL):
  - Hundreds of real-world databases across 95+ domains (healthcare, government, logistics, sports).
  - Specifically designed with "dirty" schemas: inconsistent naming, missing constraints, unstructured text fields, and ambiguous joins.
  - Includes standardized evaluation questions ranging from simple filters to complex multi-level aggregations and window functions.

---

## 5. Custom Enterprise Forensic Challenge (Synthetic Scenario) 🏢

A tailor-made scenario designed to exercise all `db-mcp` defenses:
- **Scenario**: *"The Rogue Operator & The Ghost Invoice"*
- **Tables** (no declared FKs, short cryptic names):
  - `TBL_TRX_MVR`: Transaction movements (raw amounts, ledger codes).
  - `MST_PERS_ID`: Customer master data with encrypted or raw NIT / DPI.
  - `LOG_AUT_SYS`: System authorization log with operator IDs and timestamps.
  - `CAT_CLF_COD`: Lookup table for classification codes (`TIP_DOC`, `ST_OPE`).
- **The Mystery**:
  - An operator altered a tax ID and invoice total just before SAP synchronization.
  - The AI must use:
    1. `describe_table` and `infer_table_relationships` to construct the data model.
    2. `lookup_glossary` to understand internal codes.
    3. `query_database` to discover the audit trail and the altered record.
    4. Test in-memory data masking (`DataMaskingEngine`) to ensure national IDs (NIT/DPI) are masked before output.
