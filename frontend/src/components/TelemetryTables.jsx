import React, { useState } from 'react';
import { Download, Database, CheckCircle2, Code2, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

const AIR_GAPPED_EXPORT_SQL = `-- Production Safe Read-Only Telemetry Extraction Query
-- Run via psql, DBeaver, pgAdmin, or Datagrip on production (safe read-only)
WITH
unused_indexes AS (
    SELECT COALESCE(json_agg(t), '[]'::json) AS data
    FROM (
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
        ORDER BY index_size_bytes DESC
    ) t
),
vacuum_bloat AS (
    SELECT COALESCE(json_agg(t), '[]'::json) AS data
    FROM (
        SELECT
            schemaname,
            relname,
            n_live_tup,
            n_dead_tup,
            round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2)::float AS dead_tup_ratio,
            last_vacuum::text,
            last_autovacuum::text
        FROM pg_stat_user_tables
        WHERE n_dead_tup > 5000
          AND (100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0)) > 5.0
        ORDER BY dead_tup_ratio DESC
    ) t
),
missing_indexes AS (
    SELECT COALESCE(json_agg(t), '[]'::json) AS data
    FROM (
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
        ORDER BY s.seq_tup_read DESC
    ) t
),
stale_stats AS (
    SELECT COALESCE(json_agg(t), '[]'::json) AS data
    FROM (
        SELECT
            schemaname,
            relname,
            n_live_tup,
            n_mod_since_analyze,
            last_analyze::text,
            last_autoanalyze::text
        FROM pg_stat_user_tables
        WHERE n_mod_since_analyze > 10000
          AND (100.0 * n_mod_since_analyze / NULLIF(n_live_tup, 0)) > 5.0
        ORDER BY n_mod_since_analyze DESC
    ) t
)
SELECT jsonb_pretty(
    json_build_object(
        'collected_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'unused_indexes', (SELECT data FROM unused_indexes),
        'vacuum_bloat_candidates', (SELECT data FROM vacuum_bloat),
        'missing_index_candidates', (SELECT data FROM missing_indexes),
        'stale_stats_candidates', (SELECT data FROM stale_stats),
        'summary', json_build_object(
            'total_unused_indexes', json_array_length((SELECT data FROM unused_indexes)),
            'total_vacuum_bloat_candidates', json_array_length((SELECT data FROM vacuum_bloat)),
            'total_missing_index_candidates', json_array_length((SELECT data FROM missing_indexes)),
            'total_stale_stats_candidates', json_array_length((SELECT data FROM stale_stats))
        )
    )::jsonb
) AS telemetry_json;`;

export default function TelemetryTables({ telemetry }) {
  const [showSql, setShowSql] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);

  const unusedIndexes = telemetry?.unused_indexes || [];
  const vacuumBloat = telemetry?.vacuum_bloat_candidates || [];
  const missingIndexes = telemetry?.missing_index_candidates || [];
  const staleStats = telemetry?.stale_stats_candidates || [];

  const handleCopySql = () => {
    navigator.clipboard.writeText(AIR_GAPPED_EXPORT_SQL);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  const handleExportJson = () => {
    const jsonStr = JSON.stringify(telemetry, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'telemetry.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* 1. Unused Secondary Indexes */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            Unused Secondary Indexes (pg_stat_user_indexes)
          </h3>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Indexes with idx_scan = 0 causing write amplification and cache overhead.
          </p>
        </div>

        {unusedIndexes.length > 0 ? (
          <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-x-auto shadow-sm">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-zinc-950/60 text-slate-500 dark:text-zinc-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200 dark:border-zinc-800">
                <tr>
                  <th className="py-2.5 px-4">Schema</th>
                  <th className="py-2.5 px-4">Table</th>
                  <th className="py-2.5 px-4">Index Name</th>
                  <th className="py-2.5 px-4 text-right">Index Scans</th>
                  <th className="py-2.5 px-4 text-right">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 text-slate-700 dark:text-zinc-300 font-mono">
                {unusedIndexes.map((idx, i) => (
                  <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-sans text-slate-500 dark:text-zinc-400">{idx.schemaname}</td>
                    <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-zinc-100">{idx.table_name}</td>
                    <td className="py-2.5 px-4 text-blue-600 dark:text-blue-400">{idx.index_name}</td>
                    <td className="py-2.5 px-4 text-right text-amber-600 dark:text-amber-400 font-bold">{idx.idx_scan}</td>
                    <td className="py-2.5 px-4 text-right text-slate-500 dark:text-zinc-400">{idx.index_size_pretty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 dark:border-zinc-800 p-4 text-xs text-slate-500 dark:text-zinc-400 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>No unused secondary indexes detected. All indexes are actively scanned.</span>
          </div>
        )}
      </div>

      {/* 2. MVCC Vacuum & Dead Tuple Bloat */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            MVCC Vacuum & Dead Tuple Bloat (pg_stat_user_tables)
          </h3>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Tables where dead tuple ratio exceeds 10% and dead rows &gt; 1,000.
          </p>
        </div>

        {vacuumBloat.length > 0 ? (
          <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-x-auto shadow-sm">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-zinc-950/60 text-slate-500 dark:text-zinc-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200 dark:border-zinc-800">
                <tr>
                  <th className="py-2.5 px-4">Schema</th>
                  <th className="py-2.5 px-4">Table</th>
                  <th className="py-2.5 px-4 text-right">Live Tuples</th>
                  <th className="py-2.5 px-4 text-right">Dead Tuples</th>
                  <th className="py-2.5 px-4 text-right">Dead Ratio</th>
                  <th className="py-2.5 px-4">Last Vacuum</th>
                  <th className="py-2.5 px-4">Last Autovacuum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 text-slate-700 dark:text-zinc-300 font-mono">
                {vacuumBloat.map((b, i) => (
                  <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-sans text-slate-500 dark:text-zinc-400">{b.schemaname}</td>
                    <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-zinc-100">{b.relname}</td>
                    <td className="py-2.5 px-4 text-right">{b.n_live_tup?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-right text-red-600 dark:text-red-400 font-bold">{b.n_dead_tup?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-right text-red-600 dark:text-red-400 font-bold">{b.dead_tup_ratio}%</td>
                    <td className="py-2.5 px-4 text-slate-500 dark:text-zinc-400 font-sans">{b.last_vacuum || 'Never'}</td>
                    <td className="py-2.5 px-4 text-slate-500 dark:text-zinc-400 font-sans">{b.last_autovacuum || 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 dark:border-zinc-800 p-4 text-xs text-slate-500 dark:text-zinc-400 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>No critical dead tuple bloat detected across user tables.</span>
          </div>
        )}
      </div>

      {/* 3. Sequential Scan Hotspots */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            Sequential Scan Hotspots (pg_stat_user_tables)
          </h3>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Large tables (&gt;10k rows) with &gt;20 sequential scans and &gt;100k tuples read.
          </p>
        </div>

        {missingIndexes.length > 0 ? (
          <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-x-auto shadow-sm">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-zinc-950/60 text-slate-500 dark:text-zinc-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200 dark:border-zinc-800">
                <tr>
                  <th className="py-2.5 px-4">Schema</th>
                  <th className="py-2.5 px-4">Table</th>
                  <th className="py-2.5 px-4 text-right">Seq Scans</th>
                  <th className="py-2.5 px-4 text-right">Tuples Read</th>
                  <th className="py-2.5 px-4 text-right">Idx Scans</th>
                  <th className="py-2.5 px-4 text-right">Avg Tuples / Scan</th>
                  <th className="py-2.5 px-4">Candidate Index Columns</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 text-slate-700 dark:text-zinc-300 font-mono">
                {missingIndexes.map((m, i) => (
                  <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-sans text-slate-500 dark:text-zinc-400">{m.schemaname}</td>
                    <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-zinc-100">{m.relname}</td>
                    <td className="py-2.5 px-4 text-right text-red-600 dark:text-red-400 font-bold">{m.seq_scan?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-right text-red-600 dark:text-red-400 font-bold">{m.seq_tup_read?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-right">{m.idx_scan?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-right text-slate-500 dark:text-zinc-400">{m.avg_tup_per_seq_scan?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 font-sans">
                      {m.candidate_columns && m.candidate_columns.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {m.candidate_columns.map((c, ci) => {
                            const name = typeof c === 'object' && c !== null ? c.column_name : c;
                            return (
                              <span key={ci} className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-mono text-[10px] border border-blue-500/20">
                                {name}
                              </span>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-slate-400 dark:text-zinc-500 text-[11px] italic">Inspect query filters</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 dark:border-zinc-800 p-4 text-xs text-slate-500 dark:text-zinc-400 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>No high-frequency sequential scan hotspots detected on large tables.</span>
          </div>
        )}
      </div>

      {/* 4. Stale Optimizer Statistics */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
            Stale Optimizer Statistics (pg_stat_user_tables)
          </h3>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Tables where modifications since analyze exceed 5,000 and 10% of live row count.
          </p>
        </div>

        {staleStats.length > 0 ? (
          <div className="rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-x-auto shadow-sm">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-zinc-950/60 text-slate-500 dark:text-zinc-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200 dark:border-zinc-800">
                <tr>
                  <th className="py-2.5 px-4">Schema</th>
                  <th className="py-2.5 px-4">Table</th>
                  <th className="py-2.5 px-4 text-right">Live Tuples</th>
                  <th className="py-2.5 px-4 text-right">Mods Since Analyze</th>
                  <th className="py-2.5 px-4">Last Analyze</th>
                  <th className="py-2.5 px-4">Last Autoanalyze</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 text-slate-700 dark:text-zinc-300 font-mono">
                {staleStats.map((s, i) => (
                  <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td className="py-2.5 px-4 font-sans text-slate-500 dark:text-zinc-400">{s.schemaname}</td>
                    <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-zinc-100">{s.relname}</td>
                    <td className="py-2.5 px-4 text-right">{s.n_live_tup?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-right text-amber-600 dark:text-amber-400 font-bold">{s.n_mod_since_analyze?.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-slate-500 dark:text-zinc-400 font-sans">{s.last_analyze || 'Never'}</td>
                    <td className="py-2.5 px-4 text-slate-500 dark:text-zinc-400 font-sans">{s.last_autoanalyze || 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 dark:border-zinc-800 p-4 text-xs text-slate-500 dark:text-zinc-400 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>All table planner statistics are up to date.</span>
          </div>
        )}
      </div>

      {/* Snapshot Export Banner */}
      <div className="p-5 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/50 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h4 className="text-xs font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
              <Database className="w-4 h-4 text-blue-500" />
              Air-Gapped Snapshot Export & Production SQL Helper
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-0.5">
              Download this telemetry snapshot as JSON, or copy the safe read-only SQL query to extract telemetry from any air-gapped production PostgreSQL database.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSql(!showSql)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 shadow-sm transition-all duration-150 active:scale-95 cursor-pointer"
            >
              <Code2 className="w-3.5 h-3.5 text-blue-500" />
              <span>{showSql ? 'Hide SQL Query' : 'View Production SQL Query'}</span>
              {showSql ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleExportJson}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-all duration-150 active:scale-95 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export telemetry.json</span>
            </button>
          </div>
        </div>

        {showSql && (
          <div className="relative rounded-md bg-slate-950 text-zinc-200 p-4 font-mono text-xs border border-zinc-800 animate-slide-down shadow-inner">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-800 text-zinc-400 text-[11px]">
              <span>Safe Read-Only Query (Enforces <code>default_transaction_read_only = on</code>, correlated subquery for <code>candidate_columns</code>)</span>
              <button
                onClick={handleCopySql}
                className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs transition-colors cursor-pointer"
              >
                {copiedSql ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedSql ? 'Copied' : 'Copy Query'}</span>
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap max-h-80 leading-relaxed">
              <code>{AIR_GAPPED_EXPORT_SQL}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

