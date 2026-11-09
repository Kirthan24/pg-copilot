# 🐘 pg-copilot: AI-Native PostgreSQL Health, Index & Vacuum Advisor

> **Production-Safe, Read-Only PostgreSQL Catalog Observability & AI-Driven Remediation**

`pg-copilot` is an AI-native database performance advisor built for production PostgreSQL systems. It safely inspects PostgreSQL system catalogs (`pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_stats`, and `pg_index`), isolates performance regressions (MVCC dead tuple bloat, sequential scan hotspots, unused indexes, and stale optimizer statistics), and synthesizes non-blocking remediation DDL via a Principal DBRE Agent.

---

## 🎯 Problem Statement

In high-throughput OLTP PostgreSQL databases, performance degradations often compound invisibly inside system catalogs before surfacing as user-facing latency spikes:

1. **MVCC Dead Tuple Bloat**:
   PostgreSQL Multi-Version Concurrency Control (MVCC) never overwrites rows in-place during `UPDATE` or `DELETE` operations. Instead, it marks row versions as dead tuples. If autovacuum scale factors are misconfigured or fall behind write volume, dead tuples accumulate, causing physical heap bloat, cache pollution in `shared_buffers`, and degraded sequential/index scan throughput.
2. **Write Amplification from Unused Indexes**:
   Every secondary index created on a table must be updated on every `INSERT` and `DELETE`, and on non-HOT `UPDATE` operations. Unused indexes (`idx_scan = 0`) waste operating system RAM and disk I/O while producing pure write amplification.
3. **Sequential Scan Hotspots on Unindexed Predicates**:
   Without selective indexes on high-frequency predicate columns, the PostgreSQL query planner sweeps entire relation heaps from disk into memory, causing CPU saturation and evicting hot cache pages.
4. **Stale Optimizer Statistics**:
   The cost-based optimizer (CBO) relies on `pg_statistic` histogram and Most Common Values (MCV) distributions. Heavy row modifications without updated statistics cause catastrophic plan regressions—such as choosing slow Nested Loop joins over Hash Joins.

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Full-Stack React + Vite                          │
│     (KPI Metrics • Severity Cards • Telemetry Explorer • SQL Exporter)      │
│                                                                             │
│   [Mode A: Live Connection URI]       [Mode B: Air-Gapped JSON Snapshot]    │
└──────────────────────┬───────────────────────────────────────┬──────────────┘
                       │                                       │
                       ▼                                       ▼
┌──────────────────────────────────────────────┐ ┌────────────────────────────┐
│ Safe Read-Only Catalog Inspector (analyzer/) │ │ Air-Gapped Snapshot Loader │
│                                              │ │ (Offline telemetry.json)   │
│  • default_transaction_read_only = on        │ └─────────────┬──────────────┘
│  • statement_timeout = 5000ms                │               │
│  • pg_stat_user_tables / indexes telemetry   │               │
└──────────────────────┬───────────────────────┘               │
                       │                                       │
                       └───────────────────┬───────────────────┘
                                           │ (JSON Telemetry)
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      AI Reasoning Agent (agent/)                            │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ Knowledge Base Grounding: kb/postgres_grounding.md                    │  │
│  │ Provider 1: Anthropic Claude (claude-3-5-sonnet tool-use schema)      │  │
│  │ Provider 2: OpenAI (gpt-4o structured JSON schema)                    │  │
│  │ Fallback: Zero-Dependency Deterministic Rule Engine (100% Offline)   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  • Grounded root-cause analysis of internal engine mechanics                │
│  • Production safety verification & lock-level analysis                     │
│  • Consolidated, non-blocking remediation script assembly                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Non-Blocking Remediation DDL                         │
│                                                                             │
│  • DROP INDEX CONCURRENTLY IF EXISTS ...                                    │
│  • CREATE INDEX CONCURRENTLY IF NOT EXISTS ...                              │
│  • VACUUM (VERBOSE, ANALYZE) ...                                            │
│  • ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.05)               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Safety Guarantees & Production Guardrails

`pg-copilot` is architected from the ground up to guarantee that inspecting a production database will **never** destabilize application traffic:

| Guardrail | Implementation | Protection |
| :--- | :--- | :--- |
| **Read-Only Session** | `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;`<br/>`SET default_transaction_read_only = on;` | Database rejects any `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, or `ALTER` with `ReadOnlySqlTransaction`. |
| **Strict Query Timeout** | `SET statement_timeout = 5000;` | Cancels any diagnostic query that exceeds 5 seconds, preventing long queries from blocking queue pipelines. |
| **Lock Level Isolation** | Enforced in Pydantic schema validation | All recommended DDL uses `CONCURRENTLY` (acquires only `ShareUpdateExclusiveLock`), permitting uninterrupted concurrent reads and writes. Blocks `VACUUM FULL` and locking `DROP INDEX`. |
| **Air-Gapped Snapshot Mode** | 100% Client-side JSON Upload | Ingests pre-exported `telemetry.json` from isolated VPCs/air-gapped DBs without requiring network ingress. |
| **Offline Deterministic Fallback** | `generate_deterministic_diagnosis()` | If no API key is supplied or rate limits occur, the rule engine generates identical structured reports without failing. |

---

## ⚡ 2-Minute Quickstart

### 1. Start the Isolated PostgreSQL Sandbox
Launch the isolated PostgreSQL 16 container (configured with `autovacuum=off` and `track_counts=on` to model predictable bloat):

```bash
docker compose up -d
```

### 2. Seed Degraded Production Scenarios
Run the seed script to simulate 100k bloated orders, missing indexes with 4.8M sequential reads, redundant indexes, and stale statistics:

```bash
python seed_dirty_db.py
```

### 3. Launch the Application (Full-Stack React + FastAPI Architecture)

1. Start the FastAPI backend:
```bash
uvicorn api.main:app --reload --port 8000
```

2. Start the Vite React frontend:
```bash
cd frontend && npm run dev
```
Open **`http://localhost:5173`** in your browser.

---

## 🧪 Test Suite

Run the full integration and unit test suite verifying read-only enforcement, catalog diagnostics, and Pydantic DDL validators:

```bash
python3 -m pytest tests/test_advisor.py -v
```

Output:
```text
tests/test_advisor.py::test_advisor_report_schema_valid PASSED           [  7%]
tests/test_advisor.py::test_advisor_report_score_bounds PASSED           [ 15%]
tests/test_advisor.py::test_enforce_concurrently_in_index_drop PASSED    [ 23%]
tests/test_advisor.py::test_deterministic_diagnosis_engine PASSED        [ 30%]
tests/test_advisor.py::test_readonly_connection_session_settings PASSED  [ 38%]
tests/test_advisor.py::test_readonly_connection_rejects_insert PASSED    [ 46%]
tests/test_advisor.py::test_readonly_connection_rejects_update PASSED    [ 53%]
tests/test_advisor.py::test_readonly_connection_rejects_delete PASSED    [ 61%]
tests/test_advisor.py::test_get_unused_indexes_structure PASSED          [ 69%]
tests/test_advisor.py::test_get_vacuum_bloat_candidates_structure PASSED [ 76%]
tests/test_advisor.py::test_get_missing_index_candidates_structure PASSED [ 84%]
tests/test_advisor.py::test_get_stale_stats_candidates_structure PASSED  [ 92%]
tests/test_advisor.py::test_collect_full_telemetry PASSED                [100%]

============================== 13 passed in 0.21s ==============================
```

---

## 📂 Project Structure

```
pg-copilot/
├── docker-compose.yml       # PostgreSQL 16 sandbox with track_counts=on, autovacuum=off
├── seed_dirty_db.py         # Simulates bloat, seq scans, unused indexes & stale stats
├── requirements.txt         # Core dependencies (FastAPI, uvicorn, anthropic, openai, etc.)
├── .env.example             # Configuration placeholders
├── kb/
│   └── postgres_grounding.md# DBRE grounding knowledge base (MVCC, locks, scale factors)
├── api/
│   ├── __init__.py          # API package
│   └── main.py              # FastAPI service with diagnose, snapshot & reseed endpoints
├── frontend/                # Vite + React + Tailwind CSS + Lucide React app
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── src/
│       ├── components/      # Sidebar, Navbar, KpiGrid, FindingCard, RemediationScript, TelemetryTables
│       ├── App.jsx
│       └── main.jsx
├── analyzer/
│   ├── __init__.py          # Package exports
│   ├── db.py                # Safe read-only context manager with statement_timeout
│   └── catalog_queries.py   # pg_stat_* telemetry queries & aggregator
├── agent/
│   ├── __init__.py          # Agent exports
│   └── advisor_agent.py     # Pydantic schemas, GPT-4o DBRE prompt & deterministic engine
├── tests/
│   ├── __init__.py
│   ├── test_advisor.py      # Catalog & advisor unit/integration tests
│   └── test_api.py          # FastAPI endpoint integration tests
└── README.md                # System documentation
```

