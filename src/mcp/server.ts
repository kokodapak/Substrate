#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SUBSTRATE_URL = process.env['SUBSTRATE_URL'] ?? 'http://localhost:3000';
const SUBSTRATE_ADMIN_KEY = process.env['SUBSTRATE_ADMIN_KEY'] ?? '';

async function substrateRequest(
  method: string,
  path: string,
  options: {
    agentId?: string;
    body?: unknown;
    queryParams?: Record<string, string | undefined>;
  } = {}
): Promise<unknown> {
  let url = `${SUBSTRATE_URL}${path}`;

  if (options.queryParams) {
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(options.queryParams)) {
      if (val !== undefined && val !== '') {
        params.set(key, val);
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': SUBSTRATE_ADMIN_KEY,
  };

  if (options.agentId) {
    headers['X-Agent-Id'] = options.agentId;
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (options.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const TOOLS = [
  {
    name: 'substrate_scan',
    description: 'Trigger a Substrate infrastructure scan. Returns a summary of discovered services, files, findings and tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'substrate_get_graph',
    description: 'Get the current infrastructure graph snapshot.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'substrate_get_findings',
    description: 'Get security findings. Optionally filter by severity and/or status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        severity: {
          type: 'string',
          description: 'Filter by severity: critical, high, medium, or low',
          enum: ['critical', 'high', 'medium', 'low'],
        },
        status: {
          type: 'string',
          description: 'Filter by status: open, acknowledged, or resolved',
          enum: ['open', 'acknowledged', 'resolved'],
        },
      },
    },
  },
  {
    name: 'substrate_get_context',
    description: 'Get agent context: service count, finding count, last scan timestamp.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'substrate_get_next_action',
    description: 'Claim the next pending remediation task for a given agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: {
          type: 'string',
          description: 'Unique identifier for the agent claiming the task',
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'substrate_complete_task',
    description: 'Mark a remediation task as completed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to mark as done',
        },
        agent_id: {
          type: 'string',
          description: 'The agent ID that claimed the task',
        },
        note: {
          type: 'string',
          description: 'Optional completion note (max 500 chars)',
        },
      },
      required: ['task_id', 'agent_id'],
    },
  },
  {
    name: 'substrate_get_timeline',
    description: 'Get the event timeline. Optionally filter by limit, domain, or event_type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default: 50, max: 200)',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain (e.g. agent, scan, access)',
        },
        event_type: {
          type: 'string',
          description: 'Filter by event type (e.g. task.completed, scan.started)',
        },
      },
    },
  },
];

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'substrate', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (toolName) {
        case 'substrate_scan': {
          result = await substrateRequest('POST', '/api/scan');
          break;
        }

        case 'substrate_get_graph': {
          result = await substrateRequest('GET', '/api/graph');
          break;
        }

        case 'substrate_get_findings': {
          const severity = typeof args['severity'] === 'string' ? args['severity'] : undefined;
          const status = typeof args['status'] === 'string' ? args['status'] : undefined;
          result = await substrateRequest('GET', '/api/findings', {
            queryParams: { severity, status },
          });
          break;
        }

        case 'substrate_get_context': {
          const agentId = 'mcp-agent';
          result = await substrateRequest('GET', '/agent/context', { agentId });
          break;
        }

        case 'substrate_get_next_action': {
          const agentId = args['agent_id'];
          if (typeof agentId !== 'string' || !agentId) {
            return {
              content: [{ type: 'text' as const, text: 'Error: agent_id is required' }],
              isError: true,
            };
          }
          result = await substrateRequest('GET', '/agent/next-action', { agentId });
          break;
        }

        case 'substrate_complete_task': {
          const taskId = args['task_id'];
          const agentId = args['agent_id'];
          if (typeof taskId !== 'string' || !taskId) {
            return {
              content: [{ type: 'text' as const, text: 'Error: task_id is required' }],
              isError: true,
            };
          }
          if (typeof agentId !== 'string' || !agentId) {
            return {
              content: [{ type: 'text' as const, text: 'Error: agent_id is required' }],
              isError: true,
            };
          }
          const note = typeof args['note'] === 'string' ? args['note'] : undefined;
          result = await substrateRequest('POST', `/agent/tasks/${taskId}/complete`, {
            agentId,
            body: note !== undefined ? { note } : {},
          });
          break;
        }

        case 'substrate_get_timeline': {
          const limit = typeof args['limit'] === 'number' ? String(args['limit']) : undefined;
          const domain = typeof args['domain'] === 'string' ? args['domain'] : undefined;
          const event_type = typeof args['event_type'] === 'string' ? args['event_type'] : undefined;
          result = await substrateRequest('GET', '/api/timeline', {
            queryParams: { limit, domain, event_type },
          });
          break;
        }

        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
