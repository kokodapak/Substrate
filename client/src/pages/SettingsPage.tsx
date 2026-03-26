import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { api, Rule } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

export function SettingsPage() {
  const { apiKey, setApiKey } = useAuth();

  const [rules, setRules]     = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // API key change state
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyInput, setKeyInput]         = useState('');

  // Per-rule toggle in-flight set
  const [togglingIds, setTogglingIds]   = useState<Set<string>>(new Set());
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});

  const fetchRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getRules();
      setRules(res.rules);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  function handleSaveKey() {
    if (keyInput.trim()) {
      setApiKey(keyInput.trim());
      setKeyInput('');
      setShowKeyInput(false);
    }
  }

  async function handleToggleRule(rule: Rule) {
    setTogglingIds((prev) => new Set(prev).add(rule.id));
    setToggleErrors((prev) => { const n = { ...prev }; delete n[rule.id]; return n; });
    try {
      const updated = await api.updateRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => r.id === updated.id ? updated : r));
    } catch (e) {
      setToggleErrors((prev) => ({ ...prev, [rule.id]: (e as Error).message }));
    } finally {
      setTogglingIds((prev) => { const n = new Set(prev); n.delete(rule.id); return n; });
    }
  }

  const maskedKey = apiKey.length > 4
    ? '••••••••' + apiKey.slice(-4)
    : '••••';

  if (loading) {
    return <Layout><LoadingSpinner /></Layout>;
  }

  if (error) {
    return <Layout><ErrorState message={error} onRetry={fetchRules} /></Layout>;
  }

  return (
    <Layout>
      <div className="p-8 space-y-10">
        <h1 className="text-2xl font-semibold text-gray-100">Settings</h1>

        {/* API Key section */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">API Key</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-4">
              <span className="font-mono text-gray-300 text-sm">{maskedKey}</span>
              <button
                onClick={() => setShowKeyInput((v) => !v)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm text-gray-200 rounded border border-gray-600 transition-colors"
              >
                {showKeyInput ? 'Cancel' : 'Change API Key'}
              </button>
            </div>

            {showKeyInput && (
              <div className="flex items-center gap-3">
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Enter new API key"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600"
                />
                <button
                  onClick={handleSaveKey}
                  disabled={!keyInput.trim()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors"
                >
                  Save
                </button>
              </div>
            )}

            <p className="text-xs text-gray-500">
              Substrate is a local, self-hosted tool. All configuration is in your .env file.
              The API key is stored in your browser's localStorage.
            </p>
          </div>
        </section>

        {/* Rules section */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Rules ({rules.length})
          </h2>

          {rules.length === 0 ? (
            <EmptyState message="No rules configured." hint="Add rules to your Substrate configuration." />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {rules.map((rule) => {
                const toggling = togglingIds.has(rule.id);
                const toggleErr = toggleErrors[rule.id];
                return (
                  <div key={rule.id} className="flex items-start gap-4 px-5 py-4">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-200">{rule.name}</span>
                        <StatusBadge value={rule.severity} type="severity" />
                        {rule.built_in && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs border bg-gray-800 text-gray-500 border-gray-700">
                            built-in
                          </span>
                        )}
                      </div>
                      {rule.description && (
                        <p className="text-xs text-gray-500">{rule.description}</p>
                      )}
                      {toggleErr && (
                        <p className="text-xs text-red-400">{toggleErr}</p>
                      )}
                    </div>

                    {/* Toggle switch */}
                    <button
                      role="switch"
                      aria-checked={rule.enabled}
                      onClick={() => handleToggleRule(rule)}
                      disabled={toggling}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full border transition-colors focus:outline-none disabled:opacity-50 mt-0.5 ${
                        rule.enabled
                          ? 'bg-blue-600 border-blue-600'
                          : 'bg-gray-700 border-gray-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                          rule.enabled ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
}
