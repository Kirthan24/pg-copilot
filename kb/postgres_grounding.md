# PostgreSQL Engine Internals, Concurrency & DBRE Knowledge Base

This reference document serves as the authoritative grounding source of truth for the DBRE AI reasoning agent. All diagnostic findings, root-cause assessments, and remediation DDL must strictly adhere to the mechanical models and production safety rules described herein.

---

## 1. PostgreSQL MVCC Architecture & Table Bloat

### 1.1 Tuple Header & Row Lifecycle
PostgreSQL implements Multi-Version Concurrency Control (MVCC) at the storage engine level. Each heap tuple is prefixed with a 23-byte header containing transaction metadata:
- `t_xmin`: The Transaction ID (XID) of the inserting transaction.
- `t_xmax`: The XID of the updating or deleting transaction (0 if currently live and unmodified).
- `t_cid`: The Command ID within the transaction that performed the modification.
- `t_ctid`: The physical disk pointer `(block_number, offset)` pointing to the current or newer version of this row.

### 1.2 Write Mechanics (Out-of-Place Updates)
PostgreSQL **never overwrites row versions in-place** on disk:
- **`UPDATE`**: Inserts an entirely new tuple with `t_xmin = current_xid` and writes the new tuple's physical `ctid` into the old tuple's header, setting the old tuple's `t_xmax = current_xid`.
- **`DELETE`**: Does not immediately free disk space. It sets `t_xmax = current_xid` on the target tuple.
- **Dead Tuples**: A tuple version becomes dead when its `t_xmax` is older than the oldest active transaction snapshot (`OldestXmin`). Dead tuples cannot be seen by any running or future transaction, yet continue occupying physical space inside 8 KB heap blocks.

### 1.3 Heap Bloat & Buffer Pool Pollution
1. **Physical Bloat**: When dead tuples are not reclaimed, new writes cannot reuse page slots and must append new 8 KB pages to the heap file.
2. **Buffer Cache Degradation**: Sequential scans and index scans must pull bloated disk pages containing dead tuples into `shared_buffers`, polluting RAM and evicting active working-set data.
3. **Visibility Maps (VM)**: Each heap table has an accompanying Visibility Map (`_vm`) tracking two bits per page:
   - *All-visible*: All tuples on the page are visible to all current and future transactions. Allows the planner to perform **Index-Only Scans** without visiting heap blocks.
   - *All-frozen*: All tuples on the page are frozen (`FrozenTransactionId`). Skips pages during aggressive vacuum freezes.

---

## 2. Lock Hierarchy & Concurrency Matrix

Production databases must avoid table-level locks that queue incoming OLTP transactions.

| Lock Mode | Acquired By | Conflicts With |
| :--- | :--- | :--- |
| **`AccessShareLock`** | `SELECT` | `AccessExclusiveLock` |
| **`RowShareLock`** | `SELECT ... FOR UPDATE / FOR SHARE` | `ExclusiveLock`, `AccessExclusiveLock` |
| **`RowExclusiveLock`** | `INSERT`, `UPDATE`, `DELETE` | `ShareLock`, `ShareRowExclusiveLock`, `ExclusiveLock`, `AccessExclusiveLock` |
| **`ShareUpdateExclusiveLock`** | **`VACUUM` (standard), `ANALYZE`, `CREATE/DROP INDEX CONCURRENTLY`, `ALTER TABLE ... SET (...)`** | `ShareUpdateExclusiveLock`, `ShareLock`, `ShareRowExclusiveLock`, `ExclusiveLock`, `AccessExclusiveLock` |
| **`ShareLock`** | `CREATE INDEX` (without `CONCURRENTLY`) | `RowExclusiveLock`, `ShareUpdateExclusiveLock`, `ShareRowExclusiveLock`, `ExclusiveLock`, `AccessExclusiveLock` |
| **`AccessExclusiveLock`** | **`VACUUM FULL`, `DROP TABLE`, `DROP INDEX` (blocking), `ALTER TABLE ... ADD COLUMN` (some types)** | **ALL lock modes (blocks SELECT, INSERT, UPDATE, DELETE)** |

### Critical Production Rules:
1. **Never recommend `VACUUM FULL`**: It acquires `AccessExclusiveLock` and rewrites the entire table to a new disk file. It blocks all concurrent application queries, causing connection pool exhaustion and application downtime.
2. **Always recommend `VACUUM (VERBOSE, ANALYZE)`**: Acquires only `ShareUpdateExclusiveLock`. Reads and writes (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) proceed without queuing.
3. **Always use `CONCURRENTLY` for Index Operations**:
   - `DROP INDEX CONCURRENTLY IF EXISTS ...`: Avoids `AccessExclusiveLock` on the parent table.
   - `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`: Builds the B-tree in 2 transactional passes without blocking writes.
   - **Transaction Block Rule**: `CONCURRENTLY` operations **cannot run inside an explicit transaction block (`BEGIN ... COMMIT`)**. They must be executed as standalone statements.

---

## 3. Autovacuum Tuning & Scale Factor Formulas

### 3.1 Trigger Threshold Formulas
PostgreSQL daemon wakes up every `autovacuum_naptime` (default 1 minute) and evaluates whether a relation needs vacuuming or analyzing:

$$\text{Vacuum Threshold} = \text{autovacuum\_vacuum\_threshold} + (\text{autovacuum\_vacuum\_scale\_factor} \times \text{reltuples})$$

$$\text{Analyze Threshold} = \text{autovacuum\_analyze\_threshold} + (\text{autovacuum\_analyze\_scale\_factor} \times \text{reltuples})$$

### 3.2 The Large-Table Autovacuum Problem
Default PostgreSQL settings:
- `autovacuum_vacuum_scale_factor = 0.20` (20%)
- `autovacuum_vacuum_threshold = 50`

**Failure Mode**: On a 10,000,000-row OLTP table, autovacuum will not trigger until **2,000,050 rows** have been updated or deleted. By that time, the table has bloated by gigabytes, saturating disk I/O and latency.

### 3.3 Recommended Per-Table Storage Parameters
For high-write tables, tune autovacuum parameters directly on the relation:

```sql
ALTER TABLE schema.table_name SET (
    autovacuum_vacuum_scale_factor = 0.05,     -- Trigger at 5% dead tuples instead of 20%
    autovacuum_vacuum_threshold = 500,         -- Base threshold
    autovacuum_vacuum_cost_limit = 1000,       -- Double I/O throughput allowance before sleeping
    autovacuum_vacuum_cost_delay = 2           -- Reduce sleep interval
);
```

For tables with high modification rates and query plan regressions:
```sql
ALTER TABLE schema.table_name SET (
    autovacuum_analyze_scale_factor = 0.05,    -- Refresh statistics at 5% modifications
    autovacuum_analyze_threshold = 250
);
```

---

## 4. Query Optimizer Statistics & Sequential Scan Diagnostics

### 4.1 Cost-Based Optimizer (CBO) & `pg_statistic`
The query planner estimates query cost based on statistics generated during `ANALYZE`:
- `n_distinct`: Number of distinct values in each column.
- `most_common_vals` (MCV) & `most_common_freqs` (MCF): Frequency distribution of top values.
- `histogram_bounds`: Divides remaining values into equal-frequency buckets.

### 4.2 Stale Statistics Failure Mode
When `n_mod_since_analyze` is high relative to `n_live_tup`, the planner's cardinality estimates diverge from reality. Common failure scenarios:
- **Nested Loop regressing over Hash Join**: Planner estimates 10 rows matching a filter and chooses a Nested Loop, but 500,000 rows match, causing multi-minute query stalls.
- **Index Scan bypass**: Planner underestimates selectivity and falls back to a sequential table sweep.

### 4.3 Missing Index vs Sequential Scan Signatures
In `pg_stat_user_tables`:
- High `seq_scan` with `seq_tup_read >> n_live_tup` indicates the engine is repeatedly reading every row in the heap table.
- Average rows read per sequential scan: $\frac{\text{seq\_tup\_read}}{\text{seq\_scan}}$.
- If average rows read per scan is close to `n_live_tup` on large relations, composite or selective B-tree indexes are missing on queried predicate columns.

