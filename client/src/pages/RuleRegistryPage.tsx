import { useState, useEffect, useCallback, useRef } from 'react';
import { Layout } from '../components/Layout';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { api, RuleBundle } from '../api/client';

interface RegistryStats {
  total_rules: number;
  built_in: number;
  plugin: number;
  enabled: number;
  disabled: number;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ id: string; reason: string }>;
}

interface ValidateResult {
  valid: boolean;
  errors: string[];
}

export function RuleRegistryPage() {
  const [stats, setStats]         = useState<RegistryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError]     = useState<string | null>(null);

  const [exporting, setExporting]   = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const fileInputRef                = useRef<HTMLInputElement>(null);
  const [importing, setImporting]   = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError]   = useState<string | null>(null);

  const [validateJson, setValidateJson]       = useState('');
  const [validating, setValidating]           = useState(false);
  const [validateResult, setValidateResult]   = useState<ValidateResult | null>(null);
  const [validateError, setValidateError]     = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await api.getRuleRegistryStats();
      setStats(res);
    } catch (e) {
      setStatsError((e as Error).message);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await api.exportRules();
      const blob = new Blob([JSON.stringify(res.rules, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'substrate-rules.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  async function handleImport() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    try {
      const text = await file.text();
      const rules = JSON.parse(text) as RuleBundle[];
      const res = await api.importRules(rules);
      setImportResult(res);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await fetchStats();
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function handleValidate() {
    setValidating(true);
    setValidateResult(null);
    setValidateError(null);
    try {
      const rule = JSON.parse(validateJson) as RuleBundle;
      const res = await api.validateRule(rule);
      setValidateResult(res);
    } catch (e) {
      if (e instanceof SyntaxError) {
        setValidateError('Invalid JSON: ' + e.message);
      } else {
        setValidateError((e as Error).message);
      }
    } finally {
      setValidating(false);
    }
  }

  return (
    <Layout>
      <div className="p-8 space-y-10">
        <h1 className="text-2xl font-semibold text-gray-100">Rule Registry</h1>

        {/* Stats */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Registry Stats</h2>
          {statsLoading ? (
            <LoadingSpinner />
          ) : statsError ? (
            <ErrorState message={statsError} onRetry={fetchStats} />
          ) : stats ? (
            <div className="grid grid-cols-5 gap-4">
              {[
                { label: 'Total Rules', value: stats.total_rules },
                { label: 'Built-in',    value: stats.built_in },
                { label: 'Plugin',      value: stats.plugin },
                { label: 'Enabled',     value: stats.enabled },
                { label: 'Disabled',    value: stats.disabled },
              ].map(({ label, value }) => (
                <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-5">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
                  <p className="mt-1 text-2xl font-semibold text-gray-100">{value}</p>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {/* Export */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Export</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-3">
            <p className="text-sm text-gray-400">Download all rules as a JSON file.</p>
            {exportError && <p className="text-xs text-red-400">{exportError}</p>}
            <button
              onClick={handleExport}
              disabled={exporting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
            >
              {exporting ? 'Exporting...' : 'Export Rules'}
            </button>
          </div>
        </section>

        {/* Import */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Import</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-3">
            <p className="text-sm text-gray-400">Upload a JSON file to import rules.</p>
            <div className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="text-sm text-gray-400 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:border-gray-700 file:bg-gray-800 file:text-gray-300 file:text-xs file:cursor-pointer hover:file:bg-gray-700"
              />
              <button
                onClick={handleImport}
                disabled={importing}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
            {importError && <p className="text-xs text-red-400">{importError}</p>}
            {importResult && (
              <div className="bg-gray-800 border border-gray-700 rounded-md p-4 space-y-2">
                <div className="flex items-center gap-6 text-sm">
                  <span className="text-green-400">Imported: {importResult.imported}</span>
                  <span className="text-yellow-400">Skipped: {importResult.skipped}</span>
                  {importResult.errors.length > 0 && (
                    <span className="text-red-400">Errors: {importResult.errors.length}</span>
                  )}
                </div>
                {importResult.errors.length > 0 && (
                  <ul className="space-y-1">
                    {importResult.errors.map((err) => (
                      <li key={err.id} className="text-xs text-red-400 font-mono">
                        {err.id}: {err.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Validate */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Validate Rule</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-3">
            <p className="text-sm text-gray-400">Paste a rule JSON object to validate it against the schema.</p>
            <textarea
              value={validateJson}
              onChange={(e) => { setValidateJson(e.target.value); setValidateResult(null); setValidateError(null); }}
              placeholder={'{\n  "id": "my-rule",\n  "name": "My Rule",\n  ...\n}'}
              rows={8}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 font-mono focus:outline-none focus:ring-1 focus:ring-blue-600 resize-y"
            />
            {validateError && <p className="text-xs text-red-400">{validateError}</p>}
            {validateResult && (
              <div className={`bg-gray-800 border rounded-md p-4 space-y-2 ${validateResult.valid ? 'border-green-700' : 'border-red-700'}`}>
                <p className={`text-sm font-medium ${validateResult.valid ? 'text-green-400' : 'text-red-400'}`}>
                  {validateResult.valid ? 'Valid rule' : 'Invalid rule'}
                </p>
                {validateResult.errors.length > 0 && (
                  <ul className="space-y-1">
                    {validateResult.errors.map((err, i) => (
                      <li key={i} className="text-xs text-red-400">{err}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <button
              onClick={handleValidate}
              disabled={validating || !validateJson.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
            >
              {validating ? 'Validating...' : 'Validate'}
            </button>
          </div>
        </section>
      </div>
    </Layout>
  );
}
