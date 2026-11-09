import React, { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import KpiGrid from './components/KpiGrid';
import FindingCard from './components/FindingCard';
import RemediationScript from './components/RemediationScript';
import TelemetryTables from './components/TelemetryTables';
import sampleReport from './data/sample_report.json';
import { AlertTriangle, CheckCircle2, FileText, Table2, Layers } from 'lucide-react';

export default function App() {
  const [isDark, setIsDark] = useState(() => {
    return localStorage.getItem('theme') !== 'light';
  });

  const [sourceMode, setSourceMode] = useState('live');
  const [dbUrl, setDbUrl] = useState('postgresql://postgres:postgres@localhost:5433/perf_sandbox');
  const [provider, setProvider] = useState('auto');
  const [apiKey, setApiKey] = useState('');
  const [telemetry, setTelemetry] = useState(null);
  const [report, setReport] = useState(null);
  const [effectiveUri, setEffectiveUri] = useState('');
  const [snapshotName, setSnapshotName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isReseeding, setIsReseeding] = useState(false);
  const [activeTab, setActiveTab] = useState('findings');
  const [errorMessage, setErrorMessage] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  // Sync dark class on documentElement
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  const toggleTheme = () => setIsDark(!isDark);

  // Load scrubbed SaaS production telemetry snapshot (Demo Mode)
  const loadDemoSnapshot = async (showToast = true) => {
    setIsLoading(true);
    setErrorMessage(null);
    if (showToast) {
      setSuccessMessage(null);
    }
    try {
      let telemetryData = null;
      try {
        const response = await fetch('/sample_telemetry.json');
        if (response.ok) {
          telemetryData = await response.json();
        }
      } catch (fetchErr) {
        console.warn('Could not fetch /sample_telemetry.json from server:', fetchErr);
      }

      setTelemetry(telemetryData);
      setReport(sampleReport);
      setSnapshotName('sample_telemetry.json (Interactive Demo)');
      setSourceMode('snapshot');
      if (showToast) {
        setSuccessMessage('Loaded demo SaaS PostgreSQL telemetry snapshot (23 diagnostic findings).');
      }
    } catch (err) {
      setErrorMessage(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Initial load: render demo sandbox immediately so the dashboard is populated in <50ms
  useEffect(() => {
    loadDemoSnapshot(false);
  }, []);

  const runLiveDiagnostics = async (targetUrl = dbUrl) => {
    const isLocalhost = typeof window !== 'undefined' && (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    );
    const apiBase = import.meta.env.VITE_API_BASE_URL || '';

    if (!apiBase && !isLocalhost) {
      setErrorMessage(
        'Live Ingress Disabled in Cloud Demo (Run locally with Docker).'
      );
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch(`${apiBase}/api/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          db_url: targetUrl,
          api_key: apiKey ? apiKey.trim() : null,
          provider: provider === 'auto' ? null : provider,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to collect database diagnostics.');
      }
      setTelemetry(data.telemetry);
      setReport(data.report);
      setEffectiveUri(data.effective_uri);
      setSourceMode('live');
      setSuccessMessage('Live database diagnostics completed successfully.');
    } catch (err) {
      setErrorMessage(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetSandbox = async () => {
    const isLocalhost = typeof window !== 'undefined' && (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    );
    const apiBase = import.meta.env.VITE_API_BASE_URL || '';

    if (!apiBase && !isLocalhost) {
      setErrorMessage('Reset Sandbox is disabled in the cloud demo (requires local Docker sandbox).');
      return;
    }

    setIsReseeding(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch(`${apiBase}/api/reseed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db_url: dbUrl || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to reset sandbox database.');
      }
      setSuccessMessage('Sandbox database successfully reset with degraded production scenarios.');
      // Re-run diagnostics
      await runLiveDiagnostics(dbUrl);
    } catch (err) {
      setErrorMessage(err.message);
    } finally {
      setIsReseeding(false);
    }
  };

  const handleUploadSnapshot = async (jsonPayload, filename) => {
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const apiBase = import.meta.env.VITE_API_BASE_URL || '';
    const isLocalhost = typeof window !== 'undefined' && (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    );

    // If on cloud demo without a live backend URL, display a clean notification explaining local requirement
    if (!apiBase && !isLocalhost) {
      setIsLoading(false);
      setErrorMessage(
        `Cloud Demo Notice: Parsing custom snapshot '${filename}' requires a live local FastAPI backend. Run locally with Docker and 'uvicorn api.main:app' for dynamic private parsing. Interactive demo sandbox remains active.`
      );
      return;
    }

    try {
      const res = await fetch(`${apiBase}/api/diagnose-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telemetry: jsonPayload,
          api_key: apiKey ? apiKey.trim() : null,
          provider: provider === 'auto' ? null : provider,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to analyze snapshot.');
      }
      setTelemetry(data.telemetry);
      setReport(data.report);
      setSnapshotName(filename);
      setSourceMode('snapshot');
      setSuccessMessage(`Air-gapped snapshot '${filename}' loaded successfully.`);
    } catch (err) {
      setErrorMessage(
        `Custom Snapshot: Backend unreachable (${err.message}). Custom JSON parsing requires the local FastAPI service. Demo sandbox remains active.`
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 flex flex-col transition-colors">
      <Navbar
        isDark={isDark}
        onToggleTheme={toggleTheme}
        sourceMode={sourceMode}
        effectiveUri={effectiveUri}
        snapshotName={snapshotName}
      />

      <div className="flex-1 flex flex-col md:flex-row items-stretch">
        <Sidebar
          sourceMode={sourceMode}
          setSourceMode={setSourceMode}
          dbUrl={dbUrl}
          setDbUrl={setDbUrl}
          provider={provider}
          setProvider={setProvider}
          apiKey={apiKey}
          setApiKey={setApiKey}
          onRunDiagnostics={() => runLiveDiagnostics(dbUrl)}
          onResetSandbox={handleResetSandbox}
          onUploadSnapshot={handleUploadSnapshot}
          onLoadDemoSnapshot={loadDemoSnapshot}
          isLoading={isLoading}
          isReseeding={isReseeding}
        />

        <main className="flex-1 p-6 lg:p-8 space-y-6 max-w-7xl min-w-0">
          {/* Notifications / Errors */}
          {errorMessage && (
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-start gap-2.5 animate-fade-in">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Error:</span> {errorMessage}
              </div>
            </div>
          )}

          {successMessage && (
            <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs flex items-start gap-2.5 animate-fade-in">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Success:</span> {successMessage}
              </div>
            </div>
          )}

          {/* KPI Metric Cards */}
          <KpiGrid report={report} telemetry={telemetry} />

          {/* Navigation Tabs */}
          <div className="border-b border-slate-200 dark:border-zinc-800">
            <div className="flex gap-6 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab('findings')}
                className={`pb-3 flex items-center gap-2 border-b-2 transition-all duration-150 cursor-pointer ${
                  activeTab === 'findings'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
                }`}
              >
                <FileText className="w-4 h-4" />
                <span>Diagnostic Findings & Remediation</span>
                {report?.findings && (
                  <span className="px-1.5 py-0.2 rounded-full bg-slate-100 dark:bg-zinc-800 text-[10px] text-slate-600 dark:text-zinc-400 font-mono transition-colors">
                    {report.findings.length}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('telemetry')}
                className={`pb-3 flex items-center gap-2 border-b-2 transition-all duration-150 cursor-pointer ${
                  activeTab === 'telemetry'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
                }`}
              >
                <Table2 className="w-4 h-4" />
                <span>Catalog Telemetry Explorer</span>
              </button>
            </div>
          </div>

          {/* Tab 1: Findings & Remediation */}
          {activeTab === 'findings' && (
            <div className="space-y-6 animate-fade-in">
              {/* Executive Summary */}
              {report?.executive_summary && (
                <div className="p-4 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm transition-all duration-200 hover:border-slate-300 dark:hover:border-zinc-700">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-zinc-500 mb-2">
                    Executive Summary
                  </h3>
                  <p className="text-xs text-slate-700 dark:text-zinc-300 leading-relaxed">
                    {report.executive_summary}
                  </p>
                </div>
              )}

              {/* Findings List */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-slate-400" />
                    Root-Cause Findings
                  </h3>
                  <span className="text-xs text-slate-500 dark:text-zinc-400">
                    {report?.findings?.length || 0} issues detected
                  </span>
                </div>

                {report?.findings && report.findings.length > 0 ? (
                  <div className="space-y-3">
                    {report.findings.map((finding, idx) => (
                      <FindingCard key={idx} finding={finding} />
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center rounded-lg border border-dashed border-slate-200 dark:border-zinc-800 text-xs text-slate-500 dark:text-zinc-400">
                    No critical issues detected. Database is operating with optimal parameters.
                  </div>
                )}
              </div>

              {/* Consolidated Remediation Script */}
              <RemediationScript sqlScript={report?.consolidated_remediation_sql} />
            </div>
          )}

          {/* Tab 2: Catalog Telemetry Explorer */}
          {activeTab === 'telemetry' && (
            <TelemetryTables telemetry={telemetry} />
          )}
        </main>
      </div>
    </div>
  );
}

