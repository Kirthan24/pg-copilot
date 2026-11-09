import React from 'react';
import { Sun, Moon, Database, FileJson, ShieldCheck } from 'lucide-react';

export default function Navbar({ isDark, onToggleTheme, sourceMode, effectiveUri, snapshotName }) {
  const targetLabel = sourceMode === 'snapshot'
    ? `Snapshot: ${snapshotName || 'telemetry.json'}`
    : effectiveUri ? effectiveUri.split('@').pop() : 'Sandbox (Port 5433/5432)';

  return (
    <header className="h-14 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 flex items-center justify-between sticky top-0 z-30 transition-colors">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-lg tracking-tight text-slate-900 dark:text-zinc-100 font-mono">
            pg-copilot
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 font-medium">
            DBRE Advisor
          </span>
        </div>

        <div className="hidden sm:flex items-center gap-1.5 ml-4 pl-4 border-l border-slate-200 dark:border-zinc-800">
          {sourceMode === 'snapshot' ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 transition-all">
              <span className="relative flex h-2 w-2 mr-0.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              <FileJson className="w-3.5 h-3.5" />
              <span>{targetLabel}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 transition-all">
              <span className="relative flex h-2 w-2 mr-0.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <Database className="w-3.5 h-3.5" />
              <span>{targetLabel}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden md:flex items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
          <span>Read-Only Session Enforced</span>
        </div>

        <button
          onClick={onToggleTheme}
          aria-label="Toggle theme"
          className="p-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-300 transition-all duration-150 hover:scale-105 active:scale-95 cursor-pointer"
        >
          {isDark ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-slate-700" />}
        </button>
      </div>
    </header>
  );
}

