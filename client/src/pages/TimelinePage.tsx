import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { api, StateEvent } from '../api/client';
import { formatDatetime } from '../utils/time';

const PAGE_SIZE = 50;

function eventTypeColor(eventType: string): string {
  const prefix = eventType.split('.')[0];
  switch (prefix) {
    case 'scan':    return 'text-blue-400';
    case 'task':    return 'text-green-400';
    case 'service': return 'text-yellow-400';
    case 'file':    return 'text-gray-400';
    default:        return 'text-gray-400';
  }
}

function PayloadSummary({ payload }: { payload: unknown }) {
  if (!payload || typeof payload !== 'object') return null;
  const entries = Object.entries(payload as Record<string, unknown>).slice(0, 5);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
      {entries.map(([k, v]) => (
        <span key={k} className="text-xs text-gray-500">
          <span className="text-gray-600">{k}:</span>{' '}
          {String(v).slice(0, 60)}
        </span>
      ))}
    </div>
  );
}

export function TimelinePage() {
  const [events, setEvents]       = useState<StateEvent[]>([]);
  const [total, setTotal]         = useState(0);
  const [offset, setOffset]       = useState(0);
  const [loading, setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Filters
  const [domain, setDomain]       = useState('');
  const [eventType, setEventType] = useState('');
  const [since, setSince]         = useState('');
  const [until, setUntil]         = useState('');

  const fetchTimeline = useCallback(async (currentOffset: number, replace: boolean) => {
    if (replace) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const res = await api.getTimeline({
        domain:     domain || undefined,
        event_type: eventType || undefined,
        since:      since || undefined,
        until:      until || undefined,
        limit:      PAGE_SIZE,
        offset:     currentOffset,
      });
      if (replace) {
        setEvents(res.events);
      } else {
        setEvents((prev) => [...prev, ...res.events]);
      }
      setTotal(res.total);
      setOffset(currentOffset + res.events.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [domain, eventType, since, until]);

  // Re-fetch when filters change
  useEffect(() => {
    setOffset(0);
    fetchTimeline(0, true);
  }, [fetchTimeline]);

  function handleLoadMore() {
    fetchTimeline(offset, false);
  }

  if (loading) {
    return <Layout><LoadingSpinner /></Layout>;
  }

  if (error) {
    return <Layout><ErrorState message={error} onRetry={() => fetchTimeline(0, true)} /></Layout>;
  }

  return (
    <Layout>
      <div className="p-8 space-y-6">
        <h1 className="text-2xl font-semibold text-gray-100">State Timeline</h1>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="Domain filter…"
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600 w-40"
          />
          <input
            type="text"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            placeholder="Event type filter…"
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600 w-44"
          />
          <input
            type="datetime-local"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-600"
          />
          <span className="text-gray-600 text-sm">→</span>
          <input
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-600"
          />
          {(domain || eventType || since || until) && (
            <button
              onClick={() => { setDomain(''); setEventType(''); setSince(''); setUntil(''); }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto text-xs text-gray-500">{total} event{total !== 1 ? 's' : ''}</span>
        </div>

        {/* Timeline */}
        {events.length === 0 ? (
          <EmptyState
            message="No events recorded yet. Run a scan to start."
            hint="Events are recorded whenever Substrate scans your environment."
          />
        ) : (
          <div className="space-y-2">
            {events.map((evt) => (
              <div
                key={evt.id}
                className="bg-gray-900 border border-gray-800 rounded-lg px-5 py-3"
              >
                <div className="flex items-start gap-4">
                  <span className={`font-mono text-sm font-medium ${eventTypeColor(evt.event_type)}`}>
                    {evt.event_type}
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs border bg-gray-800 text-gray-400 border-gray-700">
                    {evt.domain}
                  </span>
                  <span className="ml-auto text-xs text-gray-500 flex-shrink-0">
                    {formatDatetime(evt.occurred_at)}
                  </span>
                </div>
                <PayloadSummary payload={evt.payload} />
              </div>
            ))}

            {offset < total && (
              <div className="pt-4 flex justify-center">
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="px-5 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-sm text-gray-200 rounded-md border border-gray-700 transition-colors"
                >
                  {loadingMore ? 'Loading…' : `Load more (${total - offset} remaining)`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
