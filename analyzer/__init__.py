"""PostgreSQL catalog analyzer and health check package."""

from analyzer.db import get_readonly_connection, get_default_db_url
from analyzer.catalog_queries import (
    get_unused_indexes,
    get_vacuum_bloat_candidates,
    get_missing_index_candidates,
    get_stale_stats_candidates,
    collect_full_telemetry,
)

__all__ = [
    "get_readonly_connection",
    "get_default_db_url",
    "get_unused_indexes",
    "get_vacuum_bloat_candidates",
    "get_missing_index_candidates",
    "get_stale_stats_candidates",
    "collect_full_telemetry",
]
