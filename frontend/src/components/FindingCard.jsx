import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Check, Terminal, ShieldAlert } from 'lucide-react';

export default function FindingCard({ finding }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const severityStyles = {
    CRITICAL: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
    WARNING: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    INFO: 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-700',
  };

  const copySql = () => {
    navigator.clipboard.writeText(finding.recommended_sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const badgeStyle = severityStyles[finding.severity] || severityStyles.INFO;

  return (
    <div className="rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 p-5 shadow-sm transition-all duration-200 hover:border-slate-300 dark:hover:border-zinc-700 hover:shadow-sm space-y-3.5 animate-fade-in">
      {/* 1. Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-zinc-800/80">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded tracking-wider uppercase border transition-colors ${badgeStyle}`}>
            {finding.severity}
          </span>
          <span className="text-[10px] font-medium px-2 py-0.5 rounded tracking-wider uppercase bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700">
            {finding.category}
          </span>
        </div>
        <div className="font-mono text-xs font-semibold px-2 py-1 rounded bg-slate-100/80 dark:bg-zinc-950 text-slate-900 dark:text-zinc-200 border border-slate-200/60 dark:border-zinc-800 shadow-2xs">
          {finding.target_object}
        </div>
      </div>

      {/* 2. Body: Root Cause */}
      <div className="text-xs text-slate-700 dark:text-zinc-300 leading-relaxed">
        <span className="font-semibold text-slate-900 dark:text-zinc-100 mr-1.5">Root Cause:</span>
        {finding.root_cause_analysis}
      </div>

      {/* 3. Footer Strip: Locking & Concurrency */}
      <div className="border-l-2 border-blue-500 dark:border-blue-400 pl-3 py-1 text-xs text-slate-600 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-950/40 rounded-r">
        <span className="font-medium text-slate-800 dark:text-zinc-200 mr-1">Locking & Concurrency:</span>
        {finding.locking_impact}
      </div>

      {/* 4. SQL Expander */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 flex items-center gap-1 transition-colors cursor-pointer"
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>{isExpanded ? 'Hide Remediation DDL' : 'View Remediation DDL'}</span>
          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>

        {isExpanded && (
          <div className="mt-2.5 relative rounded-md bg-slate-950 text-zinc-200 p-3.5 font-mono text-xs border border-zinc-800 animate-slide-down shadow-sm">
            <button
              onClick={copySql}
              aria-label="Copy SQL"
              className="absolute top-2.5 right-2.5 p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-all active:scale-90 cursor-pointer"
              title="Copy SQL"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <pre className="overflow-x-auto whitespace-pre-wrap pr-8">
              <code>{finding.recommended_sql}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

