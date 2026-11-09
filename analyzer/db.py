"""Database connection management and safe read-only query utilities for PostgreSQL."""

import os
from contextlib import contextmanager
from typing import Generator, Optional
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

DEFAULT_DB_URL = "postgresql://postgres:postgres@localhost:5433/perf_sandbox"


def get_default_db_url() -> str:
    """Retrieve database URL from environment or fallback default."""
    return os.getenv("DATABASE_URL", DEFAULT_DB_URL)


@contextmanager
def get_readonly_connection(db_url: Optional[str] = None) -> Generator[psycopg2.extensions.connection, None, None]:
    """Provide a safe read-only PostgreSQL connection with strict timeout limits.

    Safety constraints enforced:
    - default_transaction_read_only = on (prevents any data/schema mutations)
    - statement_timeout = 5000 (5-second timeout prevents long locks / stalls)
    - cursor_factory = RealDictCursor (returns clean dict-like records)
    """
    url = db_url or get_default_db_url()
    conn = psycopg2.connect(url, cursor_factory=RealDictCursor)
    try:
        # Enforce read-only session and 5000ms query timeout
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;")
            cur.execute("SET default_transaction_read_only = on;")
            cur.execute("SET statement_timeout = 5000;")
        yield conn
    finally:
        conn.close()
