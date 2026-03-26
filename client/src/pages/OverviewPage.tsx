import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { api, ServicesResponse, FindingsResponse, StateResponse } from '../api/client';
import { relativeTime } from '../utils/time';

interface PageData {
  services: ServicesResponse;
  findings: FindingsResponse;
  state: StateResponse;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-100">{value}</p>
    </div>
  );
}

function serviceStatusColor(status: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'running': return 'bg-green-500';
    case 'stopped': return 'bg-gray-500';
    case 'exited':  return 'bg-red-500';
    default:        return 'bg-gray-600';
  }
}

export function OverviewPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [services, findings, state] = await Promise.all([
        api.getServices(),
        api.getFindings(),
        api.getState(),
      ]);
      setData({ services, findings, state });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleScan() {
    setScanning(true);
    setScanError(null);
    try {
      await api.scan();
      await fetchAll();
    } catch (e) {
      setScanError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  if (loading) {
    return (
      <Layout>
        <LoadingSpinner />
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <ErrorState message={error} onRetry={fetchAll} />
      </Layout>
    );
  }

  const hasData = data && (data.services.services.length > 0 || data.findings.findings.length > 0);
  const state = data?.state;
  const recentFindings = data?.findings.findings.slice(0, 5) ?? [];

  return (
    <Layout>
      <div className="p-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-100">System Overview</h1>
          <div className="flex items-center gap-3">
            {scanError && (
              <span className="text-sm text-red-400">{scanError}</span>
            )}
            <button
              onClick={handleScan}
              disabled={scanning}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
            >
              {scanning ? 'Scanning...' : 'Trigger Scan'}
            </button>
          </div>
        </div>

        {!hasData ? (
          <EmptyState
            message="No scan data yet. Click 'Trigger Scan' to start."
            hint="Substrate will discover services, files, and findings in your environment."
          />
        ) : (
          <>
            {/* Stats bar */}
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Total Services" value={state?.current.service_count ?? 0} />
              <StatCard label="Total Findings" value={state?.current.finding_count ?? 0} />
              <StatCard label="Critical Findings" value={state?.current.critical_count ?? 0} />
              <StatCard label="Last Scan" value={relativeTime(state?.current.last_scan_at ?? null)} />
            </div>

            {/* Services grid */}
            <section>
              <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">
                Services ({data.services.services.length})
              </h2>
              {data.services.services.length === 0 ? (
                <EmptyState message="No services discovered." />
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  {data.services.services.map((svc) => (
                    <div
                      key={svc.id}
                      className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-100 truncate">{svc.name}</span>
                        <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                          <span
                            className={`w-2 h-2 rounded-full ${serviceStatusColor(svc.status)}`}
                          />
                          <span className="text-xs text-gray-400">{svc.status ?? 'unknown'}</span>
                        </div>
                      </div>
                      {svc.type && (
                        <span className="inline-block text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded border border-gray-700">
                          {svc.type}
                        </span>
                      )}
                      {svc.image && (
                        <p className="text-xs text-gray-500 truncate">{svc.image}</p>
                      )}
                      {svc.ports.length > 0 && (
                        <p className="text-xs text-gray-500">
                          {svc.ports.length} port{svc.ports.length !== 1 ? 's' : ''}:{' '}
                          {svc.ports.slice(0, 3).join(', ')}
                          {svc.ports.length > 3 ? '…' : ''}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Recent findings */}
            <section>
              <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">
                Recent Findings
              </h2>
              {recentFindings.length === 0 ? (
                <EmptyState message="No findings in latest snapshot." />
              ) : (
                <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
                  {recentFindings.map((f) => (
                    <div key={f.id} className="flex items-center gap-4 px-5 py-3">
                      <StatusBadge value={f.severity} type="severity" />
                      <span className="flex-1 text-sm text-gray-200">{f.title}</span>
                      <span className="text-xs text-gray-500 font-mono">{f.rule_id}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}
