"""FastAPI endpoint integration tests for pg-copilot."""

import pytest
from fastapi.testclient import TestClient
from api.main import app

client = TestClient(app)


def test_health_check_endpoint():
    """Verify /api/health responds with healthy status."""
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "healthy"
    assert data["service"] == "pg-copilot-api"


def test_diagnose_snapshot_endpoint():
    """Verify /api/diagnose-snapshot evaluates raw telemetry without live DB."""
    sample_telemetry = {
        "collected_at": "2026-11-07T00:00:00Z",
        "unused_indexes": [
            {
                "schemaname": "public",
                "table_name": "orders",
                "index_name": "idx_unused_status",
                "idx_scan": 0,
                "index_size_bytes": 1048576,
                "index_size_pretty": "1 MB",
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
        "missing_index_candidates": [],
        "stale_stats_candidates": [],
    }

    res = client.post("/api/diagnose-snapshot", json={"telemetry": sample_telemetry})
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert "report" in data
    assert "health_score" in data["report"]
    assert len(data["report"]["findings"]) == 2


def test_diagnose_live_endpoint():
    """Verify /api/diagnose against local sandbox."""
    res = client.post(
        "/api/diagnose",
        json={"db_url": "postgresql://postgres:postgres@localhost:5433/perf_sandbox"},
    )
    if res.status_code == 500:
        pytest.skip("Local sandbox not reachable for live endpoint test.")

    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert "telemetry" in data
    assert "report" in data

