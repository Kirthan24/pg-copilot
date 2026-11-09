"""Test suite for pg-copilot: Database advisor, catalog queries, and safety guarantees."""

import os
import psycopg2
import pytest
from pydantic import ValidationError

from analyzer.db import get_readonly_connection, get_default_db_url
from analyzer.catalog_queries import (
    get_unused_indexes,
    get_vacuum_bloat_candidates,
    get_missing_index_candidates,
    get_stale_stats_candidates,
    collect_full_telemetry,
)
from agent.advisor_agent import (
    Finding,
    AdvisorReport,
    generate_deterministic_diagnosis,
)


# ============================================================================
# Helpers & Fixtures
# ============================================================================

def get_test_db_url() -> str:
    """Find reachable sandbox database port (5433 or 5432)."""
    env_url = os.getenv("DATABASE_URL")
    candidates = [
        env_url,
        "postgresql://postgres:postgres@localhost:5433/perf_sandbox",
        "postgresql://postgres:postgres@localhost:5432/perf_sandbox",
    ]
    for url in [u for u in candidates if u]:
        try:
            with get_readonly_connection(url) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1;")
            return url
        except Exception:
            continue
    pytest.skip("Local PostgreSQL sandbox is not reachable. Skipping integration tests.")


@pytest.fixture(scope="module")
def db_conn():
    """Module-level read-only connection fixture."""
    url = get_test_db_url()
    with get_readonly_connection(url) as conn:
        yield conn


# ============================================================================
# 1. Pydantic Model & Non-Blocking DDL Validation Unit Tests
# ============================================================================

def test_advisor_report_schema_valid():
    """Verify that a properly constructed AdvisorReport passes validation."""
    finding = Finding(
        category="INDEX",
        severity="WARNING",
        target_object="public.idx_orders_unused",
        root_cause_analysis="Index has 0 scans causing write amplification overhead.",
        recommended_sql="DROP INDEX CONCURRENTLY IF EXISTS public.idx_orders_unused;",
        locking_impact="Safe for production: uses ShareUpdateExclusiveLock.",
    )
    report = AdvisorReport(
        health_score=85,
        executive_summary="Database health is good with 1 minor unused index.",
        findings=[finding],
        consolidated_remediation_sql="DROP INDEX CONCURRENTLY IF EXISTS public.idx_orders_unused;",
    )
    assert report.health_score == 85
    assert len(report.findings) == 1
    assert report.findings[0].category == "INDEX"
    assert "CONCURRENTLY" in report.findings[0].recommended_sql


def test_advisor_report_score_bounds():
    """Ensure health_score validates bounds (0 to 100)."""
    valid_finding = Finding(
        category="VACUUM",
        severity="INFO",
        target_object="public.orders",
        root_cause_analysis="Routine vacuum check.",
        recommended_sql="VACUUM (VERBOSE, ANALYZE) public.orders;",
        locking_impact="Safe.",
    )

    # Valid boundaries
    report_zero = AdvisorReport(
        health_score=0,
        executive_summary="Critical state.",
        findings=[valid_finding],
        consolidated_remediation_sql="-- None",
    )
    assert report_zero.health_score == 0

    report_hundred = AdvisorReport(
        health_score=100,
        executive_summary="Optimal state.",
        findings=[],
        consolidated_remediation_sql="-- None",
    )
    assert report_hundred.health_score == 100

    # Negative score rejected
    with pytest.raises(ValidationError):
        AdvisorReport(
            health_score=-5,
            executive_summary="Invalid.",
            findings=[],
            consolidated_remediation_sql="--",
        )

    # Score > 100 rejected
    with pytest.raises(ValidationError):
        AdvisorReport(
            health_score=105,
            executive_summary="Invalid.",
            findings=[],
            consolidated_remediation_sql="--",
        )


def test_enforce_concurrently_in_index_drop():
    """Verify that Finding model enforces CONCURRENTLY for DROP INDEX recommendations."""
    # 1. Valid non-blocking drop passes
    valid_finding = Finding(
        category="INDEX",
        severity="WARNING",
        target_object="public.idx_orders_unused",
        root_cause_analysis="Zero index scans detected.",
        recommended_sql="DROP INDEX CONCURRENTLY IF EXISTS public.idx_orders_unused;",
        locking_impact="Non-blocking ShareUpdateExclusiveLock.",
    )
    assert "CONCURRENTLY" in valid_finding.recommended_sql

    # 2. Blocking DROP INDEX without CONCURRENTLY must raise ValidationError
    with pytest.raises(ValidationError) as exc_info:
        Finding(
            category="INDEX",
            severity="WARNING",
            target_object="public.idx_orders_unused",
            root_cause_analysis="Zero index scans detected.",
            recommended_sql="DROP INDEX public.idx_orders_unused;",  # Blocking!
            locking_impact="Blocks writes.",
        )
    assert "must enforce CONCURRENTLY" in str(exc_info.value)


def test_deterministic_diagnosis_engine():
    """Test deterministic rule engine creates valid AdvisorReport from raw telemetry."""
    sample_telemetry = {
        "collected_at": "2026-11-07T00:00:00Z",
        "unused_indexes": [
            {
                "schemaname": "public",
                "table_name": "orders",
                "index_name": "idx_orders_unused_status",
                "idx_scan": 0,
                "index_size_bytes": 1048576,
                "index_size_pretty": "1024 kB",
            }
        ],
        "vacuum_bloat_candidates": [
            {
                "schemaname": "public",
                "relname": "orders",
                "n_live_tup": 85000,
                "n_dead_tup": 55000,
                "dead_tup_ratio": 39.29,
                "last_vacuum": None,
                "last_autovacuum": None,
            }
        ],
        "missing_index_candidates": [
            {
                "schemaname": "public",
                "relname": "audit_logs",
                "seq_scan": 61,
                "seq_tup_read": 4800000,
                "idx_scan": 0,
                "avg_tup_per_seq_scan": 78688.52,
            }
        ],
        "stale_stats_candidates": [
            {
                "schemaname": "public",
                "relname": "inventory",
                "n_live_tup": 75000,
                "n_mod_since_analyze": 25000,
                "last_analyze": "2026-11-07T00:00:00Z",
                "last_autoanalyze": None,
            }
        ],
    }

    report = generate_deterministic_diagnosis(sample_telemetry)
    assert isinstance(report, AdvisorReport)
    assert 0 <= report.health_score <= 100
    assert len(report.findings) == 4

    categories = {f.category for f in report.findings}
    assert categories == {"INDEX", "VACUUM", "SEQ_SCAN", "STATS"}

    # Verify all index drops enforce CONCURRENTLY
    index_findings = [f for f in report.findings if f.category == "INDEX"]
    for idx_f in index_findings:
        assert "CONCURRENTLY" in idx_f.recommended_sql


# ============================================================================
# 2. Read-Only Connection & Safety Guarantee Integration Tests
# ============================================================================

def test_readonly_connection_session_settings(db_conn):
    """Verify default_transaction_read_only is on and statement_timeout is configured."""
    with db_conn.cursor() as cur:
        cur.execute("SHOW default_transaction_read_only;")
        res = cur.fetchone()
        read_only_val = res["default_transaction_read_only"] if isinstance(res, dict) else res[0]
        assert read_only_val.lower() == "on"

        cur.execute("SHOW statement_timeout;")
        res = cur.fetchone()
        timeout_val = res["statement_timeout"] if isinstance(res, dict) else res[0]
        assert timeout_val in ("5000ms", "5s")


def test_readonly_connection_rejects_insert(db_conn):
    """Verify that attempting an INSERT raises ReadOnlySqlTransaction."""
    with pytest.raises(psycopg2.errors.ReadOnlySqlTransaction):
        with db_conn.cursor() as cur:
            cur.execute("""
                INSERT INTO orders (user_id, amount, status, created_at)
                VALUES (999, 100.00, 'TEST', NOW());
            """)


def test_readonly_connection_rejects_update(db_conn):
    """Verify that attempting an UPDATE raises ReadOnlySqlTransaction."""
    with pytest.raises(psycopg2.errors.ReadOnlySqlTransaction):
        with db_conn.cursor() as cur:
            cur.execute("UPDATE orders SET amount = 999.99 WHERE id = 1;")


def test_readonly_connection_rejects_delete(db_conn):
    """Verify that attempting a DELETE raises ReadOnlySqlTransaction."""
    with pytest.raises(psycopg2.errors.ReadOnlySqlTransaction):
        with db_conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = 1;")


# ============================================================================
# 3. Catalog Diagnostic Queries Integration Tests
# ============================================================================

def test_get_unused_indexes_structure(db_conn):
    """Verify get_unused_indexes returns list of dicts with expected keys."""
    results = get_unused_indexes(db_conn)
    assert isinstance(results, list)
    expected_keys = {
        "schemaname",
        "table_name",
        "index_name",
        "idx_scan",
        "index_size_bytes",
        "index_size_pretty",
    }
    for row in results:
        assert isinstance(row, dict)
        assert expected_keys.issubset(row.keys())
        assert row["idx_scan"] == 0


def test_get_vacuum_bloat_candidates_structure(db_conn):
    """Verify get_vacuum_bloat_candidates returns list of dicts with expected keys."""
    results = get_vacuum_bloat_candidates(db_conn)
    assert isinstance(results, list)
    expected_keys = {
        "schemaname",
        "relname",
        "n_live_tup",
        "n_dead_tup",
        "dead_tup_ratio",
        "last_vacuum",
        "last_autovacuum",
    }
    for row in results:
        assert isinstance(row, dict)
        assert expected_keys.issubset(row.keys())
        assert row["dead_tup_ratio"] > 5.0
        assert row["n_dead_tup"] > 5000


def test_get_missing_index_candidates_structure(db_conn):
    """Verify get_missing_index_candidates returns list of dicts with expected keys."""
    results = get_missing_index_candidates(db_conn)
    assert isinstance(results, list)
    expected_keys = {
        "schemaname",
        "relname",
        "seq_scan",
        "seq_tup_read",
        "idx_scan",
        "avg_tup_per_seq_scan",
        "existing_indexed_columns",
        "candidate_columns",
    }
    for row in results:
        assert isinstance(row, dict)
        assert expected_keys.issubset(row.keys())
        assert isinstance(row["existing_indexed_columns"], list)
        assert isinstance(row["candidate_columns"], list)
        assert row["seq_scan"] > 20
        assert row["seq_tup_read"] > 100000


def test_get_stale_stats_candidates_structure(db_conn):
    """Verify get_stale_stats_candidates returns list of dicts with expected keys."""
    results = get_stale_stats_candidates(db_conn)
    assert isinstance(results, list)
    expected_keys = {
        "schemaname",
        "relname",
        "n_live_tup",
        "n_mod_since_analyze",
        "last_analyze",
        "last_autoanalyze",
    }
    for row in results:
        assert isinstance(row, dict)
        assert expected_keys.issubset(row.keys())
        assert row["n_mod_since_analyze"] > 10000


def test_collect_full_telemetry():
    """Verify collect_full_telemetry consolidates all metrics into serializable dict."""
    test_url = get_test_db_url()
    telemetry = collect_full_telemetry(test_url)
    assert isinstance(telemetry, dict)

    expected_top_keys = {
        "collected_at",
        "unused_indexes",
        "vacuum_bloat_candidates",
        "missing_index_candidates",
        "stale_stats_candidates",
        "summary",
    }
    assert expected_top_keys.issubset(telemetry.keys())
    assert isinstance(telemetry["summary"], dict)
    assert "total_unused_indexes" in telemetry["summary"]
    assert "total_vacuum_bloat_candidates" in telemetry["summary"]
    assert "total_missing_index_candidates" in telemetry["summary"]
    assert "total_stale_stats_candidates" in telemetry["summary"]


def test_air_gapped_telemetry_snapshot_lifecycle():
    """Verify that telemetry can be serialized to JSON and loaded in air-gapped mode."""
    import json
    from agent.advisor_agent import generate_ai_diagnosis

    test_url = get_test_db_url()
    telemetry = collect_full_telemetry(test_url)

    # 1. Simulate export to JSON string (like an air-gapped export)
    json_bytes = json.dumps(telemetry, indent=2).encode("utf-8")
    assert len(json_bytes) > 0

    # 2. Simulate upload and parsing from air-gapped machine
    loaded_telemetry = json.loads(json_bytes.decode("utf-8"))
    assert "unused_indexes" in loaded_telemetry

    # 3. Verify advisor generates report directly from offline snapshot
    report = generate_ai_diagnosis(loaded_telemetry)
    assert isinstance(report, AdvisorReport)
    assert 0 <= report.health_score <= 100
    assert len(report.findings) > 0


def test_markdown_grounding_kb_injection():
    """Verify that kb/postgres_grounding.md is loaded and injected into system prompt."""
    from agent.advisor_agent import _load_grounding_kb, build_system_prompt

    kb = _load_grounding_kb()
    assert len(kb) > 500
    assert "MVCC Architecture" in kb
    assert "ShareUpdateExclusiveLock" in kb
    assert "autovacuum_vacuum_scale_factor" in kb

    prompt = build_system_prompt()
    assert "POSTGRESQL ENGINE GROUNDING KNOWLEDGE BASE" in prompt
    assert "ShareUpdateExclusiveLock" in prompt


def test_anthropic_claude_provider_fallback_flow():
    """Verify that provider='anthropic' defaults gracefully to deterministic when key is absent."""
    from agent.advisor_agent import generate_ai_diagnosis

    dummy_telemetry = {
        "collected_at": "2026-11-07T00:00:00Z",
        "unused_indexes": [],
        "vacuum_bloat_candidates": [],
        "missing_index_candidates": [],
        "stale_stats_candidates": [],
    }

    # Without API key, falls back to deterministic cleanly
    report = generate_ai_diagnosis(dummy_telemetry, api_key="", provider="anthropic")
    assert isinstance(report, AdvisorReport)
    assert report.health_score == 100


def test_missing_index_uses_candidate_columns_case_a():
    """Verify advisor uses actual candidate columns instead of hardcoded (user_id, status)."""
    from agent.advisor_agent import generate_ai_diagnosis

    telemetry = {
        "collected_at": "2026-11-08T00:00:00Z",
        "missing_index_candidates": [
            {
                "schemaname": "public",
                "relname": "client_interaction_v1",
                "seq_scan": 150,
                "seq_tup_read": 3000000,
                "idx_scan": 0,
                "avg_tup_per_seq_scan": 20000.0,
                "existing_indexed_columns": ["id"],
                "candidate_columns": ["client_id", "created_at"],
            }
        ]
    }

    report = generate_ai_diagnosis(telemetry)
    finding = next(f for f in report.findings if f.category == "SEQ_SCAN")

    # MUST NOT contain hardcoded user_id, status
    assert "user_id, status" not in finding.recommended_sql
    # MUST contain actual candidate columns
    assert "(client_id, created_at)" in finding.recommended_sql
    assert "idx_client_interaction_v1_client_id_created_at" in finding.recommended_sql
    assert "CONCURRENTLY" in finding.recommended_sql


def test_missing_index_legacy_snapshot_template_case_b():
    """Verify legacy snapshots without column metadata output pre-check and placeholders without hallucinating columns."""
    from agent.advisor_agent import generate_ai_diagnosis

    telemetry = {
        "collected_at": "2026-11-08T00:00:00Z",
        "missing_index_candidates": [
            {
                "schemaname": "public",
                "relname": "profile_org_relationship_v1",
                "seq_scan": 95,
                "seq_tup_read": 1800000,
                "idx_scan": 0,
                "avg_tup_per_seq_scan": 18947.0,
            }
        ]
    }

    report = generate_ai_diagnosis(telemetry)
    finding = next(f for f in report.findings if f.category == "SEQ_SCAN")

    # MUST NOT hallucinate fake columns
    assert "user_id, status" not in finding.recommended_sql
    # MUST provide pg_stats pre-check query
    assert "SELECT attname, n_distinct" in finding.recommended_sql
    # MUST provide placeholder template
    assert "(<filter_col_1>, <filter_col_2>)" in finding.recommended_sql


def test_consolidated_sql_deduplicates_redundant_analyze():
    """Verify that when a table is vacuumed with VACUUM (VERBOSE, ANALYZE), standalone ANALYZE is deduplicated."""
    from agent.advisor_agent import generate_ai_diagnosis

    telemetry = {
        "collected_at": "2026-11-08T00:00:00Z",
        "vacuum_bloat_candidates": [
            {
                "schemaname": "public",
                "relname": "orders",
                "n_live_tup": 85000,
                "n_dead_tup": 55000,
                "dead_tup_ratio": 39.29,
            }
        ],
        "stale_stats_candidates": [
            {
                "schemaname": "public",
                "relname": "orders",
                "n_live_tup": 85000,
                "n_mod_since_analyze": 155000,
            },
            {
                "schemaname": "public",
                "relname": "inventory",
                "n_live_tup": 75000,
                "n_mod_since_analyze": 25000,
            }
        ]
    }

    report = generate_ai_diagnosis(telemetry)
    sql = report.consolidated_remediation_sql

    # orders receives VACUUM (VERBOSE, ANALYZE)
    assert "VACUUM (VERBOSE, ANALYZE) public.orders;" in sql
    # orders should NOT have a second standalone ANALYZE VERBOSE
    assert "ANALYZE VERBOSE public.orders;" not in sql
    # inventory was NOT vacuumed, so it MUST receive standalone ANALYZE VERBOSE
    assert "ANALYZE VERBOSE public.inventory;" in sql


def test_filter_telemetry_thresholds_filters_false_positives():
    """Verify filter_telemetry_thresholds eliminates low-bloat and low-modification false positives."""
    from agent.advisor_agent import filter_telemetry_thresholds, generate_ai_diagnosis

    unfiltered_snapshot = {
        "collected_at": "2026-11-08T00:00:00Z",
        "vacuum_bloat_candidates": [
            {
                "schemaname": "public",
                "relname": "clean_table",
                "n_live_tup": 1000000,
                "n_dead_tup": 100,
                "dead_tup_ratio": 0.01,  # False positive: 0.01% dead tuples
            },
            {
                "schemaname": "public",
                "relname": "low_bloat_table",
                "n_live_tup": 500000,
                "n_dead_tup": 1950,
                "dead_tup_ratio": 0.39,  # False positive: 0.39% dead tuples
            },
            {
                "schemaname": "public",
                "relname": "genuinely_bloated_table",
                "n_live_tup": 85000,
                "n_dead_tup": 55000,
                "dead_tup_ratio": 39.29, # True positive: > 5.0% and > 5000 dead rows
            }
        ],
        "stale_stats_candidates": [
            {
                "schemaname": "public",
                "relname": "massive_table",
                "n_live_tup": 6000000,
                "n_mod_since_analyze": 148, # False positive: 148 mods on 6M rows (< 5% and < 10k)
            },
            {
                "schemaname": "public",
                "relname": "active_table",
                "n_live_tup": 80000,
                "n_mod_since_analyze": 80000, # True positive: 100% mods and > 10000
            }
        ],
        "summary": {
            "total_vacuum_bloat_candidates": 3,
            "total_stale_stats_candidates": 2,
        }
    }

    filtered = filter_telemetry_thresholds(unfiltered_snapshot)
    assert len(filtered["vacuum_bloat_candidates"]) == 1
    assert filtered["vacuum_bloat_candidates"][0]["relname"] == "genuinely_bloated_table"
    assert len(filtered["stale_stats_candidates"]) == 1
    assert filtered["stale_stats_candidates"][0]["relname"] == "active_table"

    # Verify report generated from this snapshot only addresses the true positives
    report = generate_ai_diagnosis(unfiltered_snapshot)
    targets = [f.target_object for f in report.findings]
    assert "public.clean_table" not in targets
    assert "public.low_bloat_table" not in targets
    assert "public.massive_table" not in targets
    assert "public.genuinely_bloated_table" in targets
    assert "public.active_table" in targets


def test_missing_index_candidate_columns_dict_structure_and_rca():
    """Verify that candidate_columns dicts are used to generate DDL and mentioned in RCA."""
    from agent.advisor_agent import generate_ai_diagnosis

    telemetry = {
        "collected_at": "2026-11-08T00:00:00Z",
        "missing_index_candidates": [
            {
                "schemaname": "public",
                "relname": "profile_org_relationship_v1",
                "seq_scan": 400,
                "seq_tup_read": 12000000,
                "idx_scan": 0,
                "avg_tup_per_seq_scan": 30000.0,
                "existing_indexed_columns": ["id"],
                "candidate_columns": [
                    {
                        "column_name": "org_id",
                        "data_type": "uuid",
                        "n_distinct": 25000,
                        "null_frac": 0.0,
                    },
                    {
                        "column_name": "created_at",
                        "data_type": "timestamp with time zone",
                        "n_distinct": 80000,
                        "null_frac": 0.01,
                    },
                    {
                        "column_name": "relationship_type",
                        "data_type": "varchar",
                        "n_distinct": 5,
                        "null_frac": 0.05,
                    }
                ],
            }
        ]
    }

    report = generate_ai_diagnosis(telemetry)
    finding = next(f for f in report.findings if f.target_object == "public.profile_org_relationship_v1")

    # SQL creates index with top 2 candidate columns
    assert "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profile_org_relationship_v1_org_id_created_at" in finding.recommended_sql
    assert "ON public.profile_org_relationship_v1 (org_id, created_at);" in finding.recommended_sql

    # RCA mentions existing_indexed_columns and n_distinct / null_pct
    assert "Existing leading indexed columns on table: id" in finding.root_cause_analysis
    assert "org_id" in finding.root_cause_analysis
    assert "n_distinct=25000" in finding.root_cause_analysis
    assert "nulls=0.0%" in finding.root_cause_analysis


def test_candidate_columns_filter_high_nulls_and_low_cardinality():
    """Verify that columns with null_pct >= 90.0 or n_distinct in (0, 1) are excluded."""
    from agent.advisor_agent import generate_ai_diagnosis

    telemetry = {
        "collected_at": "2026-11-08T00:00:00Z",
        "missing_index_candidates": [
            {
                "schemaname": "public",
                "relname": "client_interaction_v1",
                "seq_scan": 500,
                "seq_tup_read": 15000000,
                "existing_indexed_columns": ["id"],
                "candidate_columns": [
                    {
                        "column_name": "account_org_id",
                        "data_type": "uuid",
                        "n_distinct": 0, # Empty column / 0 distinct
                        "null_pct": 100.0,
                    },
                    {
                        "column_name": "crm_acc_opp_id",
                        "data_type": "varchar",
                        "n_distinct": 0, # Empty column / 0 distinct
                        "null_pct": 100.0,
                    },
                    {
                        "column_name": "client_id",
                        "data_type": "uuid",
                        "n_distinct": 25000,
                        "null_pct": 0.0,
                    },
                    {
                        "column_name": "created_at",
                        "data_type": "timestamp with time zone",
                        "n_distinct": 80000,
                        "null_pct": 0.0,
                    },
                ],
            },
            {
                "schemaname": "public",
                "relname": "interaction_v1",
                "seq_scan": 300,
                "seq_tup_read": 8000000,
                "existing_indexed_columns": ["id"],
                "candidate_columns": [
                    {
                        "column_name": "interaction_type_id",
                        "data_type": "int4",
                        "n_distinct": 1, # Constant value across 4M rows!
                        "null_pct": 0.0,
                    },
                    {
                        "column_name": "interaction_date",
                        "data_type": "date",
                        "n_distinct": 1500,
                        "null_pct": 0.0,
                    },
                    {
                        "column_name": "actor_id",
                        "data_type": "uuid",
                        "n_distinct": 4000,
                        "null_pct": 2.5,
                    },
                ],
            },
            {
                "schemaname": "public",
                "relname": "all_disqualified_table",
                "seq_scan": 100,
                "seq_tup_read": 500000,
                "existing_indexed_columns": ["id"],
                "candidate_columns": [
                    {
                        "column_name": "empty_col",
                        "data_type": "text",
                        "n_distinct": 0,
                        "null_pct": 98.0,
                    },
                    {
                        "column_name": "constant_flag",
                        "data_type": "int4",
                        "n_distinct": 1,
                        "null_pct": 0.0,
                    },
                ],
            },
        ]
    }

    report = generate_ai_diagnosis(telemetry)

    # 1. client_interaction_v1: account_org_id and crm_acc_opp_id must be skipped, client_id and created_at picked
    f_client = next(f for f in report.findings if f.target_object == "public.client_interaction_v1")
    assert "account_org_id" not in f_client.recommended_sql
    assert "crm_acc_opp_id" not in f_client.recommended_sql
    assert "idx_client_interaction_v1_client_id_created_at" in f_client.recommended_sql
    assert "ON public.client_interaction_v1 (client_id, created_at);" in f_client.recommended_sql

    # 2. interaction_v1: interaction_type_id (n_distinct: 1) must be skipped, interaction_date and actor_id picked
    f_inter = next(f for f in report.findings if f.target_object == "public.interaction_v1")
    assert "interaction_type_id" not in f_inter.recommended_sql
    assert "idx_interaction_v1_interaction_date_actor_id" in f_inter.recommended_sql
    assert "ON public.interaction_v1 (interaction_date, actor_id);" in f_inter.recommended_sql

    # 3. all_disqualified_table: all candidates disqualified -> falls back to placeholder template Case B
    f_disq = next(f for f in report.findings if f.target_object == "public.all_disqualified_table")
    assert "<filter_col_1>" in f_disq.recommended_sql
    assert "Discovered catalog columns were disqualified" in f_disq.root_cause_analysis


def test_detect_provider_from_key():
    """Verify provider detection by API key prefix."""
    from agent.advisor_agent import detect_provider_from_key

    assert detect_provider_from_key("gsk_1234567890abcdef") == "groq"
    assert detect_provider_from_key("AIzaSyD-1234567890") == "gemini"
    assert detect_provider_from_key("sk-ant-api03-abcdef") == "anthropic"
    assert detect_provider_from_key("sk-proj-1234567890") == "openai"
    assert detect_provider_from_key("sk-1234567890") == "openai"
    assert detect_provider_from_key("") is None
    assert detect_provider_from_key(None) is None
    assert detect_provider_from_key("some_random_key") is None


def test_provider_auto_detection_and_fallback_on_api_error(monkeypatch):
    """Verify that auto-detected providers gracefully fallback to deterministic on error."""
    from agent.advisor_agent import generate_ai_diagnosis

    telemetry = {
        "collected_at": "2026-11-08T00:00:00Z",
        "unused_indexes": [],
        "vacuum_bloat_candidates": [],
        "missing_index_candidates": [],
        "stale_stats_candidates": [],
    }

    # 1. Groq key: gsk_*
    def mock_groq_fail(*args, **kwargs):
        raise ConnectionError("Rate limit / 429 Too Many Requests on Groq")

    monkeypatch.setattr("agent.advisor_agent._call_groq_advisor", mock_groq_fail)
    report_groq = generate_ai_diagnosis(telemetry, api_key="gsk_mock_test_key")
    assert "[Deterministic Fallback Active - Groq error:" in report_groq.executive_summary
    assert report_groq.health_score == 100

    # 2. Gemini key: AIza*
    def mock_gemini_fail(*args, **kwargs):
        raise ConnectionError("Gemini Auth failure 401")

    monkeypatch.setattr("agent.advisor_agent._call_gemini_advisor", mock_gemini_fail)
    report_gemini = generate_ai_diagnosis(telemetry, api_key="AIza_mock_test_key")
    assert "[Deterministic Fallback Active - Gemini error:" in report_gemini.executive_summary
    assert report_gemini.health_score == 100

    # 3. Claude key: sk-ant-*
    def mock_anthropic_fail(*args, **kwargs):
        raise ConnectionError("Anthropic Auth failure")

    monkeypatch.setattr("agent.advisor_agent._call_anthropic_advisor", mock_anthropic_fail)
    report_claude = generate_ai_diagnosis(telemetry, api_key="sk-ant-mock_key")
    assert "[Deterministic Fallback Active - Anthropic error:" in report_claude.executive_summary

    # 4. OpenAI key: sk-*
    def mock_openai_fail(*args, **kwargs):
        raise ConnectionError("OpenAI Quota exceeded")

    monkeypatch.setattr("agent.advisor_agent._call_openai_advisor", mock_openai_fail)
    report_openai = generate_ai_diagnosis(telemetry, api_key="sk-mock_openai_key")
    assert "[Deterministic Fallback Active - Openai error:" in report_openai.executive_summary


def test_mocked_groq_and_gemini_calls(monkeypatch):
    """Verify that Groq and Gemini invoke the OpenAI client with correct base_url and models."""
    from agent.advisor_agent import generate_ai_diagnosis, AdvisorReport

    telemetry = {
        "collected_at": "2026-11-08T00:00:00Z",
        "unused_indexes": [],
        "vacuum_bloat_candidates": [],
        "missing_index_candidates": [],
        "stale_stats_candidates": [],
    }

    recorded_calls = []

    def mock_compatible_call(telemetry_dict, api_key, model_name, base_url=None):
        recorded_calls.append({
            "api_key": api_key,
            "model_name": model_name,
            "base_url": base_url,
        })
        return AdvisorReport(
            health_score=95,
            executive_summary="AI Report via LLM",
            findings=[],
            consolidated_remediation_sql="-- None",
        )

    monkeypatch.setattr("agent.advisor_agent._call_openai_compatible_advisor", mock_compatible_call)

    # Call with Groq key
    rep_groq = generate_ai_diagnosis(telemetry, api_key="gsk_real_format_key")
    assert rep_groq.health_score == 95
    assert recorded_calls[-1]["base_url"] == "https://api.groq.com/openai/v1"
    assert recorded_calls[-1]["model_name"] == "llama-3.3-70b-versatile"

    # Call with Gemini key
    rep_gemini = generate_ai_diagnosis(telemetry, api_key="AIzaSyD_real_format_key")
    assert rep_gemini.health_score == 95
    assert recorded_calls[-1]["base_url"] == "https://generativelanguage.googleapis.com/v1beta/openai/"
    assert recorded_calls[-1]["model_name"] == "gemini-2.5-flash"

    # Even if provider was passed as 'anthropic' (stale frontend), Gemini key overrides and calls Gemini!
    rep_gemini_override = generate_ai_diagnosis(telemetry, api_key='"AIzaSyD_quoted_key"', provider="anthropic")
    assert rep_gemini_override.health_score == 95
    assert recorded_calls[-1]["api_key"] == "AIzaSyD_quoted_key"
    assert recorded_calls[-1]["base_url"] == "https://generativelanguage.googleapis.com/v1beta/openai/"


def test_clean_api_key():
    """Verify that quotes, bearer prefix, and export wrappers are stripped."""
    from agent.advisor_agent import clean_api_key

    assert clean_api_key('"AIzaSyD_test"') == "AIzaSyD_test"
    assert clean_api_key("'AIzaSyD_test'") == "AIzaSyD_test"
    assert clean_api_key("Bearer AIzaSyD_test") == "AIzaSyD_test"
    assert clean_api_key("export GEMINI_API_KEY=AIzaSyD_test") == "AIzaSyD_test"
    assert clean_api_key("GEMINI_API_KEY='AIzaSyD_test'") == "AIzaSyD_test"
    assert clean_api_key("  gsk_12345  ") == "gsk_12345"


def test_gemini_model_fallback_on_404(monkeypatch):
    """Verify that if gemini-2.5-flash returns 404, it falls back to 2.0 or 1.5."""
    from agent.advisor_agent import _call_gemini_advisor, AdvisorReport

    attempted_models = []

    def mock_call(telemetry, api_key, model_name, base_url):
        attempted_models.append(model_name)
        if model_name == "gemini-2.5-flash":
            raise Exception("Error code: 404 - Model 'gemini-2.5-flash' not found")
        return AdvisorReport(
            health_score=90,
            executive_summary="Fallback model success",
            findings=[],
            consolidated_remediation_sql="-- None",
        )

    monkeypatch.setattr("agent.advisor_agent._call_openai_compatible_advisor", mock_call)
    report = _call_gemini_advisor({}, "AIzaSyD_test", "gemini-2.5-flash")
    assert report.health_score == 90
    assert "gemini-2.5-flash" in attempted_models
    assert "gemini-2.0-flash" in attempted_models






