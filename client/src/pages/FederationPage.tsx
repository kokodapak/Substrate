import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { api, Satellite } from '../api/client';
import { relativeTime } from '../utils/time';

function satelliteStatusClasses(status: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'online':  return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'error':   return 'bg-red-500/20 text-red-400 border-red-500/30';
    default:        return 'bg-gray-700/50 text-gray-400 border-gray-600/30';
  }
}

export function FederationPage() {
  const [satellites, setSatellites] = useState<Satellite[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  const [showForm, setShowForm]       = useState(false);
  const [formName, setFormName]       = useState('');
  const [formUrl, setFormUrl]         = useState('');
  const [formKey, setFormKey]         = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [syncingIds, setSyncingIds]   = useState<Set<string>>(new Set());
  const [syncErrors, setSyncErrors]   = useState<Record<string, string>>({});
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

  const fetchSatellites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getFederationSatellites();
      setSatellites(res.satellites);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSatellites(); }, [fetchSatellites]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim() || !formUrl.trim() || !formKey.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.createFederationSatellite({ name: formName.trim(), url: formUrl.trim(), agent_key: formKey.trim() });
      setFormName('');
      setFormUrl('');
      setFormKey('');
      setShowForm(false);
      await fetchSatellites();
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSync(id: string) {
    setSyncingIds((prev) => new Set(prev).add(id));
    setSyncErrors((prev) => { const n = { ...prev }; delete n[id]; return n; });
    try {
      await api.syncFederationSatellite(id);
      await fetchSatellites();
    } catch (e) {
      setSyncErrors((prev) => ({ ...prev, [id]: (e as Error).message }));
    } finally {
      setSyncingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  async function handleRemove(id: string, name: string) {
    if (!window.confirm(`Remove satellite "${name}"?`)) return;
    setRemovingIds((prev) => new Set(prev).add(id));
    try {
      await api.deleteFederationSatellite(id);
      await fetchSatellites();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemovingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  if (loading) {
    return <Layout><LoadingSpinner /></Layout>;
  }

  if (error) {
    return <Layout><ErrorState message={error} onRetry={fetchSatellites} /></Layout>;
  }

  return (
    <Layout>
      <div className="p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-100">Federation</h1>
          <button
            onClick={() => { setShowForm((v) => !v); setSubmitError(null); }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            {showForm ? 'Cancel' : 'Add Satellite'}
          </button>
        </div>

        {showForm && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">New Satellite</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Name</label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="satellite-name"
                    className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">URL</label>
                  <input
                    type="url"
                    value={formUrl}
                    onChange={(e) => setFormUrl(e.target.value)}
                    placeholder="https://satellite.example.com"
                    className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Agent Key</label>
                  <input
                    type="password"
                    value={formKey}
                    onChange={(e) => setFormKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600"
                  />
                </div>
              </div>
              {submitError && <p className="text-xs text-red-400">{submitError}</p>}
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={submitting || !formName.trim() || !formUrl.trim() || !formKey.trim()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
                >
                  {submitting ? 'Adding...' : 'Add Satellite'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setSubmitError(null); }}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-sm text-gray-200 rounded-md border border-gray-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {satellites.length === 0 ? (
          <EmptyState
            message="No satellites registered."
            hint="Add a satellite to federate findings across multiple Substrate instances."
          />
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-5 py-3 text-left text-xs text-gray-500 uppercase tracking-wider font-medium">Name</th>
                  <th className="px-5 py-3 text-left text-xs text-gray-500 uppercase tracking-wider font-medium">URL</th>
                  <th className="px-5 py-3 text-left text-xs text-gray-500 uppercase tracking-wider font-medium">Status</th>
                  <th className="px-5 py-3 text-left text-xs text-gray-500 uppercase tracking-wider font-medium">Last Sync</th>
                  <th className="px-5 py-3 text-right text-xs text-gray-500 uppercase tracking-wider font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {satellites.map((sat) => {
                  const syncing  = syncingIds.has(sat.id);
                  const removing = removingIds.has(sat.id);
                  const syncErr  = syncErrors[sat.id];
                  return (
                    <tr key={sat.id}>
                      <td className="px-5 py-4 text-gray-200 font-medium">{sat.name}</td>
                      <td className="px-5 py-4 text-gray-400 font-mono text-xs max-w-xs truncate">{sat.url}</td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${satelliteStatusClasses(sat.status)}`}>
                          {sat.status ?? 'offline'}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-xs text-gray-500">
                        {relativeTime(sat.last_sync_at)}
                        {syncErr && <p className="text-red-400 mt-0.5">{syncErr}</p>}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleSync(sat.id)}
                            disabled={syncing || removing}
                            className="px-3 py-1 rounded text-xs text-gray-300 border border-gray-700 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {syncing ? 'Syncing...' : 'Sync Now'}
                          </button>
                          <button
                            onClick={() => handleRemove(sat.id, sat.name)}
                            disabled={syncing || removing}
                            className="px-3 py-1 rounded text-xs text-red-400 border border-red-900/40 hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {removing ? 'Removing...' : 'Remove'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
