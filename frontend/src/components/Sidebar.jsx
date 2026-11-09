import React, { useRef, useState } from 'react';
import { Database, Upload, Play, RotateCcw, Key, Shield, Sparkles, Binary, Cpu, Code2, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

export default function Sidebar({
  sourceMode,
  setSourceMode,
  dbUrl,
  setDbUrl,
  provider,
  setProvider,
  apiKey,
  setApiKey,
  onRunDiagnostics,
  onResetSandbox,
  onUploadSnapshot,
  onLoadDemoSnapshot,
  isLoading,
  isReseeding,
}) {
  const fileInputRef = useRef(null);
  const [showSqlDrawer, setShowSqlDrawer] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);

  const cleanKey = (key) => {
    if (!key) return '';
    let k = String(key).trim();
    if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
      k = k.slice(1, -1).trim();
    }
    if (k.toLowerCase().startsWith('bearer ')) {
      k = k.slice(7).trim();
    }
    if (k.startsWith('export ')) {
      k = k.slice(7).trim();
    }
    if (k.includes('=') && !k.startsWith('gsk_') && !k.startsWith('sk-') && !k.startsWith('AIza')) {
      const parts = k.split('=');
      k = parts[parts.length - 1].trim().replace(/['"]/g, '');
    }
    return k.trim();
  };

  const getDetectedEngine = (key, explicitProvider) => {
    const k = cleanKey(key);
    if (explicitProvider && explicitProvider !== 'auto') {
      if (explicitProvider === 'gemini') return { isFallback: false, provider: 'gemini', label: 'Active Engine: Google Gemini 2.5 Flash' };
      if (explicitProvider === 'groq') return { isFallback: false, provider: 'groq', label: 'Active Engine: Groq Llama-3.3-70B' };
      if (explicitProvider === 'anthropic') return { isFallback: false, provider: 'anthropic', label: 'Active Engine: Anthropic Claude 3.5 Sonnet' };
      if (explicitProvider === 'openai') return { isFallback: false, provider: 'openai', label: 'Active Engine: OpenAI GPT-4o-mini' };
      if (explicitProvider === 'deterministic') return { isFallback: true, provider: 'deterministic', label: 'Active Engine: Deterministic Fallback' };
    }

    if (!k || k === 'your_llm_api_key_here') {
      return { isFallback: true, provider: 'deterministic', label: 'Active Engine: Deterministic Fallback' };
    }
    if (k.startsWith('gsk_')) {
      return { isFallback: false, provider: 'groq', label: 'Active Engine: Groq Llama-3.3-70B' };
    }
    if (
      k.startsWith('AIza') ||
      k.startsWith('aiza') ||
      k.startsWith('AI') ||
      k.startsWith('gm-') ||
      k.startsWith('gemini') ||
      k.startsWith('ya29.') ||
      (k.length === 39 && /^[A-Za-z0-9_-]+$/.test(k))
    ) {
      return { isFallback: false, provider: 'gemini', label: 'Active Engine: Google Gemini 2.5 Flash' };
    }
    if (k.startsWith('sk-ant-')) {
      return { isFallback: false, provider: 'anthropic', label: 'Active Engine: Anthropic Claude 3.5 Sonnet' };
    }
    if (k.startsWith('sk-')) {
      return { isFallback: false, provider: 'openai', label: 'Active Engine: OpenAI GPT-4o-mini' };
    }
    return { isFallback: true, provider: 'deterministic', label: 'Active Engine: Deterministic Fallback' };
  };

  const detectedEngine = getDetectedEngine(apiKey, provider);

  const extractionSql = `-- Safe Read-Only Production Telemetry Extraction Query
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

  const copyExtractionSql = () => {
    navigator.clipboard.writeText(extractionSql);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const json = JSON.parse(event.target.result);
          onUploadSnapshot(json, file.name);
        } catch (err) {
          alert('Failed to parse telemetry.json: ' + err.message);
        }
      };
      reader.readAsText(file);
    }
  };

  return (
    <aside className="w-full md:w-80 shrink-0 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:self-start overflow-y-auto border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 flex flex-col justify-between transition-colors z-20">
      <div className="space-y-6">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-zinc-500 mb-3">
            Configuration & Target
          </h2>

          {/* Mode Switcher */}
          <div className="grid grid-cols-2 p-1 bg-slate-100 dark:bg-zinc-900 rounded-lg text-xs font-medium mb-4">
            <button
              type="button"
              onClick={() => setSourceMode('live')}
              className={`py-1.5 px-2 rounded-md flex items-center justify-center gap-1.5 transition-all duration-150 active:scale-95 ${
                sourceMode === 'live'
                  ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-sm'
                  : 'text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              Live URI
            </button>
            <button
              type="button"
              onClick={() => setSourceMode('snapshot')}
              className={`py-1.5 px-2 rounded-md flex items-center justify-center gap-1.5 transition-all duration-150 active:scale-95 ${
                sourceMode === 'snapshot'
                  ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-sm'
                  : 'text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              Air-Gapped
            </button>
          </div>

          {sourceMode === 'live' ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-700 dark:text-zinc-300">
                PostgreSQL Connection URI
              </label>
              <input
                type="text"
                value={dbUrl}
                onChange={(e) => setDbUrl(e.target.value)}
                placeholder="postgresql://postgres:postgres@localhost:5433/perf_sandbox"
                className="w-full text-xs font-mono px-3 py-2 rounded-md bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
              />
              <p className="text-[11px] text-slate-400 dark:text-zinc-500">
                Target database connection string. Read-only session enforced.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-700 dark:text-zinc-300">
                Telemetry Snapshot (JSON)
              </label>
              <input
                type="file"
                accept=".json"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full text-xs font-medium px-3 py-3 border border-dashed border-slate-300 dark:border-zinc-700 rounded-lg hover:border-slate-400 dark:hover:border-zinc-600 bg-slate-50 dark:bg-zinc-900/50 flex flex-col items-center justify-center gap-1.5 text-slate-600 dark:text-zinc-300 transition-colors"
              >
                <Upload className="w-4 h-4 text-slate-400" />
                <span>Upload telemetry.json</span>
              </button>
              <div className="flex items-center justify-between text-[11px] text-slate-400 dark:text-zinc-500 pt-1">
                <span>From air-gapped production DB</span>
                <button
                  type="button"
                  onClick={() => setShowSqlDrawer(!showSqlDrawer)}
                  className="text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5 text-[11px] font-medium cursor-pointer"
                >
                  <Code2 className="w-3 h-3" />
                  <span>{showSqlDrawer ? 'Hide SQL' : 'View SQL'}</span>
                </button>
              </div>

              {showSqlDrawer && (
                <div className="p-2.5 rounded-md bg-slate-950 text-zinc-200 font-mono text-[11px] border border-zinc-800 space-y-2 mt-2 animate-slide-down">
                  <div className="flex items-center justify-between text-zinc-400 text-[10px]">
                    <span>Air-Gapped Telemetry SQL</span>
                    <button
                      type="button"
                      onClick={copyExtractionSql}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] cursor-pointer"
                    >
                      {copiedSql ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                      <span>{copiedSql ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="overflow-x-auto max-h-48 whitespace-pre text-[10px] leading-tight text-zinc-300">
                    <code>{extractionSql}</code>
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Reasoning Engine & Auto-Detected Provider */}
        <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-zinc-900">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-zinc-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-slate-400" />
                Reasoning Provider
              </span>
              <span className="text-[10px] text-slate-500 font-normal">Auto or Manual</span>
            </label>
            <select
              value={provider || 'auto'}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full text-xs px-3 py-1.5 rounded-md bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
            >
              <option value="auto">Auto-Detect from API Key (Recommended)</option>
              <option value="gemini">Google Gemini (gemini-2.5-flash / free)</option>
              <option value="groq">Groq Llama-3.3-70B (free tier)</option>
              <option value="anthropic">Anthropic Claude (claude-3-5-sonnet)</option>
              <option value="openai">OpenAI (gpt-4o-mini)</option>
              <option value="deterministic">Deterministic Offline Rule Engine</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-zinc-300 flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-slate-400" />
              LLM API Key (Supports Claude, Groq gsk_*, Gemini AIza*, or OpenAI)
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                const val = e.target.value;
                setApiKey(val);
                const detected = getDetectedEngine(val, 'auto');
                if (!detected.isFallback && provider === 'auto') {
                  setProvider(detected.provider);
                }
              }}
              placeholder="Paste gsk_*, AIza*, sk-ant-*, or sk-* key..."
              className="w-full text-xs font-mono px-3 py-2 rounded-md bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>

          {/* Status Badge */}
          {!detectedEngine.isFallback ? (
            <div className="flex items-center gap-2 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1.5 rounded border border-emerald-500/20 transition-all">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <Sparkles className="w-3 h-3 shrink-0" />
              <span>{detectedEngine.label}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800/60 px-2.5 py-1.5 rounded border border-slate-200 dark:border-zinc-700 transition-all">
              <Binary className="w-3 h-3 text-slate-500 dark:text-zinc-400 shrink-0" />
              <span>{detectedEngine.label}</span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="space-y-2 pt-2">
          {sourceMode === 'live' && typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' ? (
            <button
              type="button"
              disabled
              title="Live ingress is disabled in the hosted cloud demo. Run locally with Docker for live database analysis."
              className="w-full flex items-center justify-center gap-2 py-2 px-3 text-[11px] font-medium rounded-md text-slate-500 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 cursor-not-allowed opacity-80 text-center"
            >
              Live Ingress Disabled in Cloud Demo (Run locally with Docker)
            </button>
          ) : (
            <button
              type="button"
              onClick={onRunDiagnostics}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md text-white bg-blue-600 hover:bg-blue-700 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all duration-150 shadow-sm hover:shadow-md cursor-pointer"
            >
              <Play className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              {isLoading ? 'Running Diagnostics...' : 'Run Catalog Diagnostics'}
            </button>
          )}

          <button
            type="button"
            onClick={onLoadDemoSnapshot}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md text-amber-900 dark:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all duration-150 cursor-pointer shadow-sm"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
            Load Demo Sandbox Snapshot
          </button>

          {sourceMode === 'live' && typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (
            <button
              type="button"
              onClick={onResetSandbox}
              disabled={isReseeding || isLoading}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium rounded-md text-slate-700 dark:text-zinc-300 bg-slate-100 dark:bg-zinc-900 hover:bg-slate-200 dark:hover:bg-zinc-800 border border-slate-200 dark:border-zinc-800 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all duration-150 cursor-pointer"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${isReseeding ? 'animate-spin' : ''}`} />
              {isReseeding ? 'Resetting Sandbox...' : 'Reset Sandbox Telemetry'}
            </button>
          )}
        </div>
      </div>

      {/* Safety Guardrails */}
      <div className="pt-6 border-t border-slate-100 dark:border-zinc-900 mt-6">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-2">
          <Shield className="w-3.5 h-3.5 text-emerald-500" />
          Safety Guardrails
        </div>
        <ul className="text-[11px] space-y-1.5 text-slate-500 dark:text-zinc-400">
          <li className="flex items-start gap-1.5">
            <span className="font-mono text-slate-700 dark:text-zinc-300 font-semibold">•</span>
            <span><code>default_transaction_read_only = on</code></span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="font-mono text-slate-700 dark:text-zinc-300 font-semibold">•</span>
            <span><code>statement_timeout = 5000ms</code></span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="font-mono text-slate-700 dark:text-zinc-300 font-semibold">•</span>
            <span>Zero table locks (<code>CONCURRENTLY</code>)</span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="font-mono text-slate-700 dark:text-zinc-300 font-semibold">•</span>
            <span>Knowledge Base MVCC Grounding</span>
          </li>
        </ul>
      </div>
    </aside>
  );
}
