const BASE_URL = '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const apiKey = localStorage.getItem('substrate_api_key') ?? '';
  const res = await fetch(BASE_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status, body: err });
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScanResult {
  snapshot_version: number;
  services_discovered: number;
  files_discovered: number;
  findings_produced: number;
  tasks_promoted: number;
  duration_ms: number;
}

export interface Service {
  id: string;
  name: string;
  type: string | null;
  status: string | null;
  image: string | null;
  ports: string[];
  env_key_names: string[];
}

export interface ServicesResponse {
  snapshot_version: number | null;
  services: Service[];
}

export interface FileConfig {
  id: string;
  path: string;
  type: string | null;
  allowed: boolean;
}

export interface FilesResponse {
  snapshot_version: number | null;
  files: FileConfig[];
}

export interface GraphNode {
  id: string;
  snapshot_id: string | null;
  domain: string;
  node_key: string;
  node_data: unknown;
}

export interface GraphSnapshot {
  id: string;
  version: number;
  graph_data: unknown;
  domains: string[];
  created_at: string | null;
}

export interface GraphResponse {
  snapshot: GraphSnapshot | null;
  nodes: GraphNode[];
}

export interface GraphDiffResponse {
  from_version: number;
  to_version: number;
  added: GraphNode[];
  removed: GraphNode[];
  changed: GraphNode[];
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  severity: string | null;
  enabled: boolean;
  condition_source: string;
  recommended_action: string;
  built_in: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface RulesResponse {
  rules: Rule[];
}

export interface Finding {
  id: string;
  rule_id: string | null;
  severity: string | null;
  title: string;
  detail: string;
  recommended_action: string;
  status: string | null;
  created_at: string | null;
}

export interface FindingsResponse {
  snapshot_version: number | null;
  findings: Finding[];
}

export interface AccessResponse {
  botignore: string;
  botinclude: string;
}

export interface AccessPreviewResponse {
  target: string;
  domain: string;
  allowed: boolean;
  matched_rule: string | null;
}

export interface StateEvent {
  id: string;
  event_type: string;
  domain: string;
  payload: unknown;
  occurred_at: string | null;
}

export interface StateResponse {
  current: {
    service_count: number;
    finding_count: number;
    critical_count: number;
    last_scan_at: string | null;
  };
  recent_events: StateEvent[];
}

export interface TimelineResponse {
  events: StateEvent[];
  total: number;
  limit: number;
  offset: number;
}

// ─── API Functions ────────────────────────────────────────────────────────────

export const api = {
  scan(): Promise<ScanResult> {
    return request<ScanResult>('/api/scan', { method: 'POST' });
  },

  getServices(): Promise<ServicesResponse> {
    return request<ServicesResponse>('/api/services');
  },

  getFiles(): Promise<FilesResponse> {
    return request<FilesResponse>('/api/files');
  },

  getGraph(): Promise<GraphResponse> {
    return request<GraphResponse>('/api/graph');
  },

  getGraphDiff(from: number, to?: number): Promise<GraphDiffResponse> {
    const params = new URLSearchParams({ from: String(from) });
    if (to !== undefined) params.set('to', String(to));
    return request<GraphDiffResponse>(`/api/graph/diff?${params.toString()}`);
  },

  getRules(): Promise<RulesResponse> {
    return request<RulesResponse>('/api/rules');
  },

  updateRule(
    id: string,
    body: { enabled?: boolean; recommended_action?: string }
  ): Promise<Rule> {
    return request<Rule>(`/api/rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  getFindings(params?: { severity?: string; status?: string }): Promise<FindingsResponse> {
    const qs = new URLSearchParams();
    if (params?.severity) qs.set('severity', params.severity);
    if (params?.status) qs.set('status', params.status);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<FindingsResponse>(`/api/findings${query}`);
  },

  getAccess(): Promise<AccessResponse> {
    return request<AccessResponse>('/api/access');
  },

  updateBotignore(content: string): Promise<void> {
    return request<void>('/api/access/botignore', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  updateBotinclude(content: string): Promise<void> {
    return request<void>('/api/access/botinclude', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  previewAccess(target: string, domain: string): Promise<AccessPreviewResponse> {
    const qs = new URLSearchParams({ target, domain });
    return request<AccessPreviewResponse>(`/api/access/preview?${qs.toString()}`);
  },

  getState(): Promise<StateResponse> {
    return request<StateResponse>('/api/state');
  },

  getTimeline(params?: {
    domain?: string;
    event_type?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): Promise<TimelineResponse> {
    const qs = new URLSearchParams();
    if (params?.domain) qs.set('domain', params.domain);
    if (params?.event_type) qs.set('event_type', params.event_type);
    if (params?.since) qs.set('since', params.since);
    if (params?.until) qs.set('until', params.until);
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<TimelineResponse>(`/api/timeline${query}`);
  },
};
