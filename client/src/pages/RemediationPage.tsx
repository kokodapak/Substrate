import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { api, Finding, AgentAction } from '../api/client';
import { relativeTime } from '../utils/time';

const ACTIVE_STATUSES = new Set(['claimed', 'done', 'skipped']);

function outcomeClasses(outcome: string): string {
  switch (outcome.toLowerCase()) {
    case 'success': return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'failure': return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'partial': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    default:        return 'bg-gray-700/50 text-gray-400 border-gray-600/30';
  }
}

function AgentActionsPanel({ findingId }: { findingId: string }) {
  const [actions, setActions]   = useState<AgentAction[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getTaskActions(findingId)
      .then((res) => { if (!cancelled) { setActions(res.actions); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError((e as Error).message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [findingId]);

  return (
    <div className="border-t border-gray-800 px-5 py-4 bg-gray-950/50">
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Agent Actions</h3>
      {loading ? (
        <p className="text-xs text-gray-500">Loading...</p>
      ) : error ? (
        <p className="text-xs text-red-400">Error: {error}</p>
      ) : actions.length === 0 ? (
        <p className="text-xs text-gray-500">No actions logged yet.</p>
      ) : (
        <div className="space-y-2">
          {actions.map((action) => (
            <div key={action.id} className="flex items-start gap-3 text-xs">
              <span className="inline-flex items-center px-2 py-0.5 rounded border bg-gray-800/80 text-gray-300 border-gray-700 font-mono flex-shrink-0">
                {action.action_type}
              </span>
              <span className="text-gray-400 truncate flex-1">{action.target}</span>
              <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium flex-shrink-0 ${outcomeClasses(action.outcome)}`}>
                {action.outcome}
              </span>
              <span className="text-gray-600 flex-shrink-0 w-20 text-right">{relativeTime(action.occurred_at)}</span>
              {action.notes && (
                <span className="text-gray-500 italic truncate max-w-xs">{action.notes}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SEVERITIES = ['All', 'Critical', 'High', 'Medium', 'Low'] as const;
const STATUSES   = ['All', 'Open', 'Acknowledged', 'Resolved'] as const;

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const ai = SEVERITY_ORDER[a.severity?.toLowerCase() ?? ''] ?? 99;
    const bi = SEVERITY_ORDER[b.severity?.toLowerCase() ?? ''] ?? 99;
    return ai - bi;
  });
}

export function RemediationPage() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const [severity, setSeverity]     = useState<string>('All');
  const [status, setStatus]         = useState<string>('All');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchFindings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getFindings();
      setFindings(res.findings);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFindings(); }, [fetchFindings]);

  if (loading) {
    return <Layout><LoadingSpinner /></Layout>;
  }

  if (error) {
    return <Layout><ErrorState message={error} onRetry={fetchFindings} /></Layout>;
  }

  const filtered = sortBySeverity(
    findings.filter((f) => {
      const matchSev = severity === 'All' || f.severity?.toLowerCase() === severity.toLowerCase();
      const matchSt  = status   === 'All' || f.status?.toLowerCase()   === status.toLowerCase();
      return matchSev && matchSt;
    })
  );

  return (
    <Layout>
      <div className="p-8 space-y-6">
        <h1 className="text-2xl font-semibold text-gray-100">Remediation Queue</h1>

        {/* Filter bar */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-wider">Severity</span>
            <div className="flex gap-1">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverity(s)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    severity === s
                      ? 'bg-gray-700 text-gray-100'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-wider">Status</span>
            <div className="flex gap-1">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    status === s
                      ? 'bg-gray-700 text-gray-100'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Findings list */}
        {filtered.length === 0 ? (
          <EmptyState
            message="No findings for this snapshot."
            hint="Adjust filters or trigger a new scan from the Overview page."
          />
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {filtered.map((f) => {
              const isSelected = selectedId === f.id;
              const showActions = isSelected && ACTIVE_STATUSES.has((f.status ?? '').toLowerCase());
              return (
                <div key={f.id}>
                  <div
                    className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-800/50 transition-colors"
                    onClick={() => setSelectedId((prev) => prev === f.id ? null : f.id)}
                  >
                    <StatusBadge value={f.severity} type="severity" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200">{f.title}</p>
                      <p className="text-xs text-gray-500 font-mono mt-0.5">{f.rule_id}</p>
                    </div>
                    <StatusBadge value={f.status} type="status" />
                    <span className="text-xs text-gray-500 w-20 text-right">
                      {relativeTime(f.created_at)}
                    </span>
                    <button
                      disabled
                      title="Coming soon"
                      className="px-3 py-1 rounded text-xs text-gray-600 border border-gray-700 cursor-not-allowed"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Acknowledge
                    </button>
                    <span className="text-gray-600 text-xs">{isSelected ? '▲' : '▼'}</span>
                  </div>
                  {showActions && <AgentActionsPanel findingId={f.id} />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
