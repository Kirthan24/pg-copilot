#!/usr/bin/env python3
"""Seed dirty database script for pg-copilot.

Simulates a degraded production PostgreSQL database for testing and demonstration:
1. Table `orders` (100k rows) with 2 redundant unused indexes.
2. Dead tuple bloat on `orders` (40k updates + 15k deletes, >35% dead tuples, no vacuum).
3. Missing index / high sequential scans on `audit_logs` (80k rows, 60 sequential scan queries).
4. Stale statistics on `inventory` (50k rows, ANALYZE, then 25k inserts so n_mod_since_analyze spikes).
"""

import os
import sys
import time
import psycopg2
from dotenv import load_dotenv

load_dotenv()


def get_db_connection():
    """Connect to PostgreSQL, prioritizing CLI args, env var, or local defaults."""
    candidate_urls = []

    # 1. CLI argument if passed
    if len(sys.argv) > 1 and sys.argv[1].startswith("postgresql://"):
        candidate_urls.append(sys.argv[1])

    # 2. Environment variable
    env_url = os.getenv("DATABASE_URL")
    if env_url:
        candidate_urls.append(env_url)

    # 3. Default fallback ports (5433 then 5432)
    candidate_urls.extend([
        "postgresql://postgres:postgres@localhost:5433/perf_sandbox",
        "postgresql://postgres:postgres@localhost:5432/perf_sandbox",
    ])

    # Deduplicate while preserving order
    seen = set()
    unique_urls = [u for u in candidate_urls if not (u in seen or seen.add(u))]

    last_err = None
    for url in unique_urls:
        try:
            conn = psycopg2.connect(url)
            conn.autocommit = True
            safe_target = url.split("@")[-1] if "@" in url else url
            print(f"[INFO] Connected successfully to PostgreSQL at {safe_target}")
            return conn, url
        except Exception as e:
            last_err = e
            continue

    print(f"[ERROR] Could not connect to PostgreSQL. Tried: {unique_urls}")
    print(f"[ERROR] Last error: {last_err}")
    sys.exit(1)


def flush_pg_stats(cur):
    """Force flush PostgreSQL cumulative stats to shared views (PG 15+)."""
    try:
        cur.execute("SELECT pg_stat_force_next_flush();")
    except Exception:
        pass


def seed_orders(cur):
    """Scenario 1 & 2: Seed orders (100k rows), unused indexes, and induce dead tuple bloat."""
    print("\n" + "=" * 60)
    print("[SCENARIO 1] Creating table 'orders' and inserting 100,000 rows...")
    print("=" * 60)

    start = time.time()
    cur.execute("DROP TABLE IF EXISTS orders CASCADE;")
    cur.execute("""
        CREATE TABLE orders (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL,
            amount NUMERIC(10, 2) NOT NULL,
            status VARCHAR(50) NOT NULL,
            created_at TIMESTAMP NOT NULL
        );
    """)

    cur.execute("""
        INSERT INTO orders (user_id, amount, status, created_at)
        SELECT
            floor(random() * 10000 + 1)::int,
            round((random() * 500 + 5)::numeric, 2),
            (ARRAY['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'REFUNDED'])[floor(random() * 5 + 1)::int],
            NOW() - (random() * interval '90 days')
        FROM generate_series(1, 100000) s(i);
    """)
    print(f"[INFO] Inserted 100,000 orders in {time.time() - start:.2f}s")

    print("[INFO] Creating redundant unused indexes on 'orders'...")
    cur.execute("CREATE INDEX idx_orders_unused_status ON orders (status);")
    cur.execute("CREATE INDEX idx_orders_unused_created ON orders (created_at);")
    print("[INFO] Created indexes 'idx_orders_unused_status' and 'idx_orders_unused_created' (unused).")

    print("\n" + "=" * 60)
    print("[SCENARIO 2] Inducing dead tuple bloat on 'orders' (40k updates, 15k deletes)...")
    print("=" * 60)

    start = time.time()
    # 40,000 updates to create 40,000 dead tuple versions
    cur.execute("""
        UPDATE orders
        SET amount = round((amount * 1.05)::numeric, 2)
        WHERE id IN (SELECT id FROM orders LIMIT 40000);
    """)
    print("[INFO] Updated amount on 40,000 rows.")

    # 15,000 deletes to create 15,000 more dead tuples
    cur.execute("""
        DELETE FROM orders
        WHERE id IN (SELECT id FROM orders ORDER BY id DESC LIMIT 15000);
    """)
    print("[INFO] Deleted 15,000 rows.")
    print(f"[INFO] Dead tuple bloat induced in {time.time() - start:.2f}s (VACUUM skipped).")


def seed_audit_logs(cur):
    """Scenario 3: Seed audit_logs (80k rows, no indexes) and run 60 seq scans."""
    print("\n" + "=" * 60)
    print("[SCENARIO 3] Creating table 'audit_logs' (80,000 rows) with NO secondary indexes...")
    print("=" * 60)

    start = time.time()
    cur.execute("DROP TABLE IF EXISTS audit_logs CASCADE;")
    cur.execute("""
        CREATE TABLE audit_logs (
            id SERIAL PRIMARY KEY,
            event_type VARCHAR(50) NOT NULL,
            payload TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL
        );
    """)

    cur.execute("""
        INSERT INTO audit_logs (event_type, payload, created_at)
        SELECT
            (ARRAY['LOGIN_SUCCESS', 'LOGIN_FAILED', 'PASSWORD_RESET', 'LOGOUT', 'TOKEN_REFRESH'])[floor(random() * 5 + 1)::int],
            '{"ip": "192.168.1.' || floor(random() * 254 + 1)::text || '", "action": "auth_event"}',
            NOW() - (random() * interval '30 days')
        FROM generate_series(1, 80000) s(i);
    """)
    print(f"[INFO] Inserted 80,000 audit log rows in {time.time() - start:.2f}s.")

    print("[INFO] Executing 60 sequential scan queries (WHERE event_type = 'LOGIN_FAILED')...")
    scan_start = time.time()
    for i in range(1, 61):
        cur.execute("SELECT COUNT(*) FROM audit_logs WHERE event_type = 'LOGIN_FAILED';")
        cur.fetchone()
        if i % 15 == 0:
            print(f"  -> Completed {i}/60 sequential scan queries...")
    print(f"[INFO] 60 sequential scans executed in {time.time() - scan_start:.2f}s.")


def seed_inventory(cur):
    """Scenario 4: Seed inventory (50k rows), ANALYZE, then insert 25k more to stale stats."""
    print("\n" + "=" * 60)
    print("[SCENARIO 4] Creating table 'inventory' and inserting initial 50,000 rows...")
    print("=" * 60)

    start = time.time()
    cur.execute("DROP TABLE IF EXISTS inventory CASCADE;")
    cur.execute("""
        CREATE TABLE inventory (
            id SERIAL PRIMARY KEY,
            sku VARCHAR(50) NOT NULL,
            quantity INT NOT NULL,
            warehouse_id INT NOT NULL,
            last_restocked TIMESTAMP NOT NULL
        );
    """)

    cur.execute("""
        INSERT INTO inventory (sku, quantity, warehouse_id, last_restocked)
        SELECT
            'SKU-' || lpad(i::text, 6, '0'),
            floor(random() * 1000)::int,
            floor(random() * 10 + 1)::int,
            NOW() - (random() * interval '60 days')
        FROM generate_series(1, 50000) s(i);
    """)
    print(f"[INFO] Inserted 50,000 inventory items in {time.time() - start:.2f}s.")

    print("[INFO] Running 'ANALYZE inventory;' to snapshot statistics...")
    cur.execute("ANALYZE inventory;")
    flush_pg_stats(cur)
    print("[INFO] Table analyzed.")

    print("[INFO] Immediately inserting 25,000 additional rows without re-analyzing...")
    start_insert = time.time()
    cur.execute("""
        INSERT INTO inventory (sku, quantity, warehouse_id, last_restocked)
        SELECT
            'SKU-' || lpad((50000 + i)::text, 6, '0'),
            floor(random() * 1000)::int,
            floor(random() * 10 + 1)::int,
            NOW() - (random() * interval '5 days')
        FROM generate_series(1, 25000) s(i);
    """)
    print(f"[INFO] Inserted 25,000 rows in {time.time() - start_insert:.2f}s (n_mod_since_analyze spiked).")


def verify_seeding(cur):
    """Query PostgreSQL system catalogs and print verification table."""
    flush_pg_stats(cur)
    time.sleep(0.1)
    flush_pg_stats(cur)

    print("\n" + "=" * 60)
    print("[VERIFICATION] Fetching PostgreSQL Catalog & Stat Metrics...")
    print("=" * 60)

    # 1. Table Stats
    cur.execute("""
        SELECT
            relname,
            seq_scan,
            seq_tup_read,
            idx_scan,
            n_live_tup,
            n_dead_tup,
            CASE
                WHEN (n_live_tup + n_dead_tup) > 0
                THEN round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2)
                ELSE 0.0
            END AS dead_pct,
            n_mod_since_analyze,
            last_analyze
        FROM pg_stat_user_tables
        WHERE relname IN ('orders', 'audit_logs', 'inventory')
        ORDER BY relname;
    """)
    table_stats = cur.fetchall()

    print("\n--- Table Statistics (pg_stat_user_tables) ---")
    headers = ["Table", "Live Tuples", "Dead Tuples", "Dead %", "Seq Scans", "Seq Tuples Read", "Mod Since Analyze"]
    row_format = "{:<12} | {:<12} | {:<12} | {:<8} | {:<10} | {:<16} | {:<18}"
    print(row_format.format(*headers))
    print("-" * 100)
    for row in table_stats:
        relname, seq_scan, seq_tup_read, idx_scan, n_live, n_dead, dead_pct, n_mod, last_an = row
        print(row_format.format(
            str(relname),
            f"{n_live:,}" if n_live is not None else "0",
            f"{n_dead:,}" if n_dead is not None else "0",
            f"{dead_pct}%",
            f"{seq_scan:,}" if seq_scan is not None else "0",
            f"{seq_tup_read:,}" if seq_tup_read is not None else "0",
            f"{n_mod:,}" if n_mod is not None else "0"
        ))

    # 2. Unused Indexes
    cur.execute("""
        SELECT
            relname,
            indexrelname,
            idx_scan,
            idx_tup_read,
            idx_tup_fetch
        FROM pg_stat_user_indexes
        WHERE relname = 'orders'
        ORDER BY indexrelname;
    """)
    index_stats = cur.fetchall()

    print("\n--- Index Statistics (pg_stat_user_indexes for 'orders') ---")
    idx_format = "{:<12} | {:<28} | {:<10} | {:<12} | {:<12}"
    print(idx_format.format("Table", "Index Name", "Idx Scans", "Tuples Read", "Tuples Fetch"))
    print("-" * 85)
    for row in index_stats:
        relname, idxname, idx_scan, idx_read, idx_fetch = row
        print(idx_format.format(
            str(relname),
            str(idxname),
            f"{idx_scan:,}" if idx_scan is not None else "0",
            f"{idx_read:,}" if idx_read is not None else "0",
            f"{idx_fetch:,}" if idx_fetch is not None else "0"
        ))

    print("\n[SUCCESS] All 4 degraded scenarios successfully seeded and verified!\n")


def main():
    conn, _ = get_db_connection()
    cur = conn.cursor()

    total_start = time.time()
    try:
        # Reset stats for clean baseline before seeding
        try:
            cur.execute("SELECT pg_stat_reset();")
        except Exception:
            pass

        seed_orders(cur)
        seed_audit_logs(cur)
        seed_inventory(cur)
        verify_seeding(cur)
    finally:
        cur.close()
        conn.close()

    print(f"[DONE] Total seeding execution time: {time.time() - total_start:.2f}s")


if __name__ == "__main__":
    main()
