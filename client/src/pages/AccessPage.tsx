import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { api } from '../api/client';

const DOMAINS = ['file', 'service', 'env', 'any'] as const;

export function AccessPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [botignoreText, setBotignoreText] = useState('');
  const [botincludeText, setBotincludeText] = useState('');

  const [savingIgnore, setSavingIgnore]   = useState(false);
  const [savingInclude, setSavingInclude] = useState(false);
  const [ignoreMsg, setIgnoreMsg]         = useState<string | null>(null);
  const [includeMsg, setIncludeMsg]       = useState<string | null>(null);

  // Preview tool state
  const [previewTarget, setPreviewTarget] = useState('');
  const [previewDomain, setPreviewDomain] = useState<string>('file');
  const [previewing, setPreviewing]       = useState(false);
  const [previewResult, setPreviewResult] = useState<{ allowed: boolean; matched_rule: string | null } | null>(null);
  const [previewError, setPreviewError]   = useState<string | null>(null);

  const fetchAccess = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getAccess();
      setBotignoreText(res.botignore);
      setBotincludeText(res.botinclude);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAccess(); }, [fetchAccess]);

  async function handleSaveBotignore() {
    setSavingIgnore(true);
    setIgnoreMsg(null);
    try {
      await api.updateBotignore(botignoreText);
      setIgnoreMsg('Saved.');
    } catch (e) {
      setIgnoreMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSavingIgnore(false);
    }
  }

  async function handleSaveBotinclude() {
    setSavingInclude(true);
    setIncludeMsg(null);
    try {
      await api.updateBotinclude(botincludeText);
      setIncludeMsg('Saved.');
    } catch (e) {
      setIncludeMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSavingInclude(false);
    }
  }

  async function handlePreview() {
    if (!previewTarget.trim()) return;
    setPreviewing(true);
    setPreviewResult(null);
    setPreviewError(null);
    try {
      const res = await api.previewAccess(previewTarget.trim(), previewDomain);
      setPreviewResult({ allowed: res.allowed, matched_rule: res.matched_rule });
    } catch (e) {
      setPreviewError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  if (loading) {
    return <Layout><LoadingSpinner /></Layout>;
  }

  if (error) {
    return <Layout><ErrorState message={error} onRetry={fetchAccess} /></Layout>;
  }

  return (
    <Layout>
      <div className="p-8 space-y-8">
        <h1 className="text-2xl font-semibold text-gray-100">Access Control</h1>

        {/* File editors */}
        <div className="grid grid-cols-2 gap-6">
          {/* .botignore */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">.botignore</h2>
              <div className="flex items-center gap-3">
                {ignoreMsg && (
                  <span className={`text-xs ${ignoreMsg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                    {ignoreMsg}
                  </span>
                )}
                <button
                  onClick={handleSaveBotignore}
                  disabled={savingIgnore}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm text-gray-200 rounded border border-gray-600 transition-colors"
                >
                  {savingIgnore ? 'Saving…' : 'Save .botignore'}
                </button>
              </div>
            </div>
            <textarea
              value={botignoreText}
              onChange={(e) => setBotignoreText(e.target.value)}
              rows={16}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-600 resize-none"
              placeholder="# Patterns to deny&#10;file:/secrets/*&#10;env:AWS_*"
            />
            <p className="text-xs text-gray-500">
              One rule per line. Format: <code className="text-gray-400">domain:pattern</code> or bare <code className="text-gray-400">pattern</code>.
            </p>
          </div>

          {/* .botinclude */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">.botinclude</h2>
              <div className="flex items-center gap-3">
                {includeMsg && (
                  <span className={`text-xs ${includeMsg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                    {includeMsg}
                  </span>
                )}
                <button
                  onClick={handleSaveBotinclude}
                  disabled={savingInclude}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm text-gray-200 rounded border border-gray-600 transition-colors"
                >
                  {savingInclude ? 'Saving…' : 'Save .botinclude'}
                </button>
              </div>
            </div>
            <textarea
              value={botincludeText}
              onChange={(e) => setBotincludeText(e.target.value)}
              rows={16}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-600 resize-none"
              placeholder="# Patterns to allow&#10;file:/public/*&#10;service:*"
            />
            <p className="text-xs text-gray-500">
              One rule per line. Format: <code className="text-gray-400">domain:pattern</code> or bare <code className="text-gray-400">pattern</code>.
            </p>
          </div>
        </div>

        {/* Preview tool */}
        <section className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-sm font-medium text-gray-300">Access Preview</h2>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={previewTarget}
              onChange={(e) => setPreviewTarget(e.target.value)}
              placeholder="/path/to/file or service-name"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600"
              onKeyDown={(e) => e.key === 'Enter' && handlePreview()}
            />
            <select
              value={previewDomain}
              onChange={(e) => setPreviewDomain(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-600"
            >
              {DOMAINS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <button
              onClick={handlePreview}
              disabled={previewing || !previewTarget.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
            >
              {previewing ? 'Checking…' : 'Check Access'}
            </button>
          </div>

          {previewError && (
            <p className="text-sm text-red-400">{previewError}</p>
          )}

          {previewResult && (
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center px-3 py-1 rounded text-sm font-medium border ${
                  previewResult.allowed
                    ? 'bg-green-500/20 text-green-400 border-green-500/30'
                    : 'bg-red-500/20 text-red-400 border-red-500/30'
                }`}
              >
                {previewResult.allowed ? 'ALLOW' : 'DENY'}
              </span>
              {previewResult.matched_rule && (
                <span className="text-sm text-gray-400 font-mono">
                  matched: {previewResult.matched_rule}
                </span>
              )}
              {!previewResult.matched_rule && (
                <span className="text-sm text-gray-500">no rule matched (default policy applied)</span>
              )}
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
}
