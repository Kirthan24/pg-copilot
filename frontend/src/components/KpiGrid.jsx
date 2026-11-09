import React from 'react';
import { Activity, Layers, Trash2, Search } from 'lucide-react';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function KpiGrid({ report, telemetry }) {
  const healthScore = report?.health_score ?? 100;
  const unusedIndexes = telemetry?.unused_indexes || [];
  const vacuumBloat = telemetry?.vacuum_bloat_candidates || [];
  const missingIndexes = telemetry?.missing_index_candidates || [];

  const totalWastedBytes = unusedIndexes.reduce((sum, u) => sum + (u.index_size_bytes || 0), 0);
  const totalDeadTuples = vacuumBloat.reduce((sum, b) => sum + (b.n_dead_tup || 0), 0);
  const seqScanCount = missingIndexes.length;

  const scoreBadge = healthScore >= 80
    ? { label: 'Optimal', style: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20' }
    : healthScore >= 50
    ? { label: 'Needs Attention', style: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20' }
    : { label: 'Degraded', style: 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20' };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* 1. Health Score */}
      <div
        className="p-4 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md hover:border-slate-300 dark:hover:border-zinc-700 cursor-default group animate-fade-in"
        style={{ animationDelay: '0ms' }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
            DB Health Score
          </span>
          <Activity className="w-4 h-4 text-slate-400 dark:text-zinc-500 group-hover:text-blue-500 transition-colors" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-slate-900 dark:text-zinc-100">
            {healthScore}/100
          </span>
        </div>
        <div className="mt-2.5">
          <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors ${scoreBadge.style}`}>
            {scoreBadge.label}
          </span>
        </div>
      </div>

      {/* 2. Wasted Index Space */}
      <div
        className="p-4 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md hover:border-slate-300 dark:hover:border-zinc-700 cursor-default group animate-fade-in"
        style={{ animationDelay: '60ms' }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
            Wasted Index Space
          </span>
          <Layers className="w-4 h-4 text-slate-400 dark:text-zinc-500 group-hover:text-amber-500 transition-colors" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-slate-900 dark:text-zinc-100">
            {formatBytes(totalWastedBytes)}
          </span>
        </div>
        <div className="mt-2.5">
          <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors ${
            unusedIndexes.length > 0
              ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
              : 'text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700'
          }`}>
            {unusedIndexes.length} unused {unusedIndexes.length === 1 ? 'index' : 'indexes'}
          </span>
        </div>
      </div>

      {/* 3. Dead Tuples Detected */}
      <div
        className="p-4 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md hover:border-slate-300 dark:hover:border-zinc-700 cursor-default group animate-fade-in"
        style={{ animationDelay: '120ms' }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
            Dead Tuples Detected
          </span>
          <Trash2 className="w-4 h-4 text-slate-400 dark:text-zinc-500 group-hover:text-red-500 transition-colors" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-slate-900 dark:text-zinc-100">
            {totalDeadTuples.toLocaleString()}
          </span>
        </div>
        <div className="mt-2.5">
          <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors ${
            vacuumBloat.length > 0
              ? 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20'
              : 'text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700'
          }`}>
            {vacuumBloat.length} bloated {vacuumBloat.length === 1 ? 'table' : 'tables'}
          </span>
        </div>
      </div>

      {/* 4. High Seq-Scan Tables */}
      <div
        className="p-4 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md hover:border-slate-300 dark:hover:border-zinc-700 cursor-default group animate-fade-in"
        style={{ animationDelay: '180ms' }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
            Seq-Scan Hotspots
          </span>
          <Search className="w-4 h-4 text-slate-400 dark:text-zinc-500 group-hover:text-red-500 transition-colors" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-slate-900 dark:text-zinc-100">
            {seqScanCount}
          </span>
        </div>
        <div className="mt-2.5">
          <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors ${
            seqScanCount > 0
              ? 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20'
              : 'text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700'
          }`}>
            {seqScanCount > 0 ? `${seqScanCount} unindexed tables` : 'No hotspots'}
          </span>
        </div>
      </div>
    </div>
  );
}

