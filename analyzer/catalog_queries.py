"""PostgreSQL system catalog and stat queries for health, index, and vacuum diagnostics."""

import json
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
from analyzer.db import get_readonly_connection


def _serialize_val(val: Any) -> Any:
    """Helper to convert PostgreSQL data types to JSON-friendly Python primitives."""
    if isinstance(val, datetime):
        return val.isoformat()
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, list):
        return [_serialize_val(x) for x in val]
    if isinstance(val, dict):
        return {k: _serialize_val(v) for k, v in val.items()}
    return val


def _rows_to_dicts(rows: List[Any]) -> List[Dict[str, Any]]:
    """Convert RealDictRow or tuple rows to clean, serializable dictionaries."""
    result = []
    for row in rows:
        item = {}
        for k, v in dict(row).items():
            item[k] = _serialize_val(v)
        result.append(item)
    return result


def get_unused_indexes(conn) -> List[Dict[str, Any]]:
    """Query unused secondary indexes (idx_scan = 0, non-unique, non-primary).

    Returns:
        List of dicts with schemaname, table_name, index_name, idx_scan,
        index_size_bytes, and index_size_pretty.
    """
    query = """
        SELECT
            sui.schemaname,
            sui.relname AS table_name,
            sui.indexrelname AS index_name,
            sui.idx_scan,
            pg_relation_size(sui.indexrelid) AS index_size_bytes,
            pg_size_pretty(pg_relation_size(sui.indexrelid)) AS index_size_pretty
        FROM pg_stat_user_indexes sui
        JOIN pg_index i ON sui.indexrelid = i.indexrelid
        WHERE sui.idx_scan = 0
          AND i.indisunique IS FALSE
          AND i.indisprimary IS FALSE
        ORDER BY index_size_bytes DESC;
    """
    with conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()
        return _rows_to_dicts(rows)


def get_vacuum_bloat_candidates(conn) -> List[Dict[str, Any]]:
    """Query tables with significant dead tuple accumulation requiring VACUUM.

    Filters for tables where n_dead_tup > 5000 and dead_tup_ratio > 5.0%.

    Returns:
        List of dicts with schemaname, relname, n_live_tup, n_dead_tup,
        dead_tup_ratio, last_vacuum, and last_autovacuum.
    """
    query = """
        SELECT
            schemaname,
            relname,
            n_live_tup,
            n_dead_tup,
            round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2)::float AS dead_tup_ratio,
            last_vacuum,
            last_autovacuum
        FROM pg_stat_user_tables
        WHERE n_dead_tup > 5000
          AND (100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0)) > 5.0
        ORDER BY dead_tup_ratio DESC;
    """
    with conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()
        return _rows_to_dicts(rows)


def get_missing_index_candidates(conn) -> List[Dict[str, Any]]:
    """Query tables suffering from heavy sequential scans on large row counts.

    Filters for tables where seq_scan > 20, n_live_tup > 10,000, and seq_tup_read > 100,000.
    Enriches each table with:
    - existing_indexed_columns: Columns that are already the leading column of an index via pg_index.
    - candidate_columns: Up to 4 unindexed columns from information_schema.columns joined with pg_stats
      (prioritizing *_id, status/type, and timestamps with low null_frac).

    Returns:
        List of dicts with schemaname, relname, seq_scan, seq_tup_read,
        idx_scan, avg_tup_per_seq_scan, existing_indexed_columns, and candidate_columns.
    """
    query = """
        SELECT
            s.schemaname,
            s.relname,
            s.seq_scan,
            s.seq_tup_read,
            s.idx_scan,
            round(s.seq_tup_read::numeric / NULLIF(s.seq_scan, 0), 2)::float AS avg_tup_per_seq_scan,
            (
                SELECT COALESCE(json_agg(DISTINCT a2.attname), '[]'::json)
                FROM pg_class tbl2
                JOIN pg_namespace ns2 ON ns2.oid = tbl2.relnamespace
                JOIN pg_index i2 ON i2.indrelid = tbl2.oid
                JOIN pg_attribute a2 ON a2.attrelid = tbl2.oid AND a2.attnum = i2.indkey[0]
                WHERE ns2.nspname = s.schemaname AND tbl2.relname = s.relname
                  AND a2.attnum > 0 AND NOT a2.attisdropped
            ) AS existing_indexed_columns,
            (
                SELECT COALESCE(json_agg(json_build_object(
                    'column_name', cols.column_name,
                    'data_type', cols.data_type,
                    'n_distinct', cols.n_distinct,
                    'null_frac', cols.null_frac
                )), '[]'::json)
                FROM (
                    SELECT
                        c.column_name,
                        c.data_type,
                        COALESCE(st.n_distinct, 0)::float as n_distinct,
                        COALESCE(st.null_frac, 0.0)::float as null_frac
                    FROM information_schema.columns c
                    LEFT JOIN pg_stats st ON st.schemaname = c.table_schema AND st.tablename = c.table_name AND st.attname = c.column_name
                    WHERE c.table_schema = s.schemaname AND c.table_name = s.relname
                      AND c.column_name NOT IN (
                          SELECT a2.attname
                          FROM pg_class tbl2
                          JOIN pg_namespace ns2 ON ns2.oid = tbl2.relnamespace
                          JOIN pg_index i2 ON i2.indrelid = tbl2.oid
                          JOIN pg_attribute a2 ON a2.attrelid = tbl2.oid AND a2.attnum = i2.indkey[0]
                          WHERE ns2.nspname = c.table_schema AND tbl2.relname = c.table_name
                            AND a2.attnum > 0 AND NOT a2.attisdropped
                      )
                    ORDER BY
                        CASE
                            WHEN c.column_name ~* '(_id|_uuid)$' THEN 10
                            WHEN c.column_name ~* '(_type|status|state)$' THEN 8
                            WHEN c.column_name ~* '(created_at|updated_at|_at|_date)$' THEN 6
                            ELSE 1
                        END DESC,
                        COALESCE(st.null_frac, 0.0) ASC,
                        abs(COALESCE(st.n_distinct, 0)) DESC,
                        c.ordinal_position ASC
                    LIMIT 4
                ) cols
            ) AS candidate_columns
        FROM pg_stat_user_tables s
        WHERE s.seq_scan > 20
          AND s.n_live_tup > 10000
          AND s.seq_tup_read > 100000
        ORDER BY s.seq_tup_read DESC;
    """
    with conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()
        return _rows_to_dicts(rows)


def get_stale_stats_candidates(conn) -> List[Dict[str, Any]]:
    """Query tables with high row modification counts relative to analyzed statistics.

    Filters for tables where n_mod_since_analyze > 10000 and
    (100.0 * n_mod_since_analyze / NULLIF(n_live_tup, 0)) > 5.0 (5%).

    Returns:
        List of dicts with schemaname, relname, n_live_tup,
        n_mod_since_analyze, last_analyze, and last_autoanalyze.
    """
    query = """
        SELECT
            schemaname,
            relname,
            n_live_tup,
            n_mod_since_analyze,
            last_analyze,
            last_autoanalyze
        FROM pg_stat_user_tables
        WHERE n_mod_since_analyze > 10000
          AND (100.0 * n_mod_since_analyze / NULLIF(n_live_tup, 0)) > 5.0
        ORDER BY n_mod_since_analyze DESC;
    """
    with conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()
        return _rows_to_dicts(rows)


def collect_full_telemetry(db_url: Optional[str] = None) -> Dict[str, Any]:
    """Execute all 4 catalog diagnostic checks using a safe read-only connection.

    Returns:
        Consolidated, JSON-serializable dictionary with telemetry data.
    """
    with get_readonly_connection(db_url) as conn:
        unused_indexes = get_unused_indexes(conn)
        vacuum_bloat = get_vacuum_bloat_candidates(conn)
        missing_indexes = get_missing_index_candidates(conn)
        stale_stats = get_stale_stats_candidates(conn)

    telemetry = {
        "collected_at": datetime.utcnow().isoformat() + "Z",
        "unused_indexes": unused_indexes,
        "vacuum_bloat_candidates": vacuum_bloat,
        "missing_index_candidates": missing_indexes,
        "stale_stats_candidates": stale_stats,
        "summary": {
            "total_unused_indexes": len(unused_indexes),
            "total_vacuum_bloat_candidates": len(vacuum_bloat),
            "total_missing_index_candidates": len(missing_indexes),
            "total_stale_stats_candidates": len(stale_stats),
        },
    }

    # Verify JSON serializability
    json.dumps(telemetry)
    return telemetry


if __name__ == "__main__":
    import pprint
    print("[INFO] Collecting full telemetry from local database...")
    result = collect_full_telemetry()
    pprint.pprint(result)
