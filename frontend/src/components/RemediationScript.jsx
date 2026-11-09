import React, { useState } from 'react';
import { Copy, Check, Download, FileCode, AlertCircle } from 'lucide-react';

export default function RemediationScript({ sqlScript }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(sqlScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([sqlScript], { type: 'text/x-sql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'remediation.sql';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!sqlScript) return null;

  return (
    <div className="rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 p-5 shadow-sm transition-all duration-200 hover:border-slate-300 dark:hover:border-zinc-700 hover:shadow-sm space-y-4 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
            <FileCode className="w-4 h-4 text-blue-500" />
            Production Remediation Script
          </h3>
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
            Sequential, non-blocking DDL and autovacuum tuning statements.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 transition-all duration-150 active:scale-95 cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied' : 'Copy SQL'}</span>
          </button>

          <button
            type="button"
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 active:scale-95 transition-all duration-150 shadow-sm hover:shadow-md cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download remediation.sql</span>
          </button>
        </div>
      </div>

      <div className="rounded-md bg-slate-950 p-4 border border-zinc-800 overflow-x-auto text-zinc-200 font-mono text-xs leading-relaxed max-h-96">
        <pre>
          <code>{sqlScript}</code>
        </pre>
      </div>

      <div className="flex items-start gap-2 text-[11px] text-slate-500 dark:text-zinc-400">
        <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
        <span>
          Note: <code>CONCURRENTLY</code> statements cannot run inside a multi-statement transaction block (<code>BEGIN...COMMIT</code>). Execute statements individually.
        </span>
      </div>
    </div>
  );
}

