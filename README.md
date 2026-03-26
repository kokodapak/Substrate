# Substrate

**Substrate gives AI agents a structured, controlled view of the system they're running on.**

It scans your Docker containers and config files, builds a versioned knowledge graph, evaluates configurable rules to surface problems, and queues findings as tasks that agents can claim and work through — one at a time, atomically, with a full audit trail.

You control exactly what the agent can see. Nothing is exposed by default. The agent never has raw access to the host.

---

## The problem

When you run an AI agent against a live system, it has no reliable way to know what's actually running. It can't tell you which containers have exited, whether the Docker socket is exposed, or what config files exist. It either guesses, asks you, or gets given unrestricted shell access.

All three outcomes are bad. Guessing produces hallucinations. Asking interrupts your workflow. Shell access is a security hole.

Substrate solves this by sitting between the agent and the system. The agent asks Substrate what's happening. Substrate tells it — from real, persisted, versioned data — and gives it one task to act on next.

---

## How it works

### Scan

Call `POST /api/scan` to trigger a full read-only scan. Substrate connects to the Docker daemon via socket, lists all containers, and scans the working directory for config files (`.env`, `docker-compose.yml`, `package.json`, etc.).

Before storing anything, every discovered item is evaluated against your access rules. Items that are denied are excluded entirely and never written to the database. Env var key names containing `SECRET`, `KEY`, `TOKEN`, `PASSWORD`, or `CREDENTIAL` are always blocked, regardless of your rules.

What passes access control is stored as a versioned **graph snapshot** — an immutable JSON record of system state at a point in time. Version numbers are integers that increment monotonically (1, 2, 3…).

### Rules

After each scan, Substrate runs every enabled rule against the new snapshot. Rules are JavaScript function bodies — pure, deterministic, sandboxed:

```js
// Is any container in an exited state?
return graphData.services && graphData.services.some(s => s.status === 'exited');
```

Rules are evaluated inside a `node:vm` context with a 1000ms timeout and no access to the host (`require`, `process`, `fs`, and `global` are all blocked). The same rule evaluated against the same snapshot always produces the same result.

When a rule fires, it creates a **finding**. Each finding is unique per `(rule_id, snapshot_id)` — running a scan twice doesn't create duplicate findings.

### Task queue

Every open finding becomes a task. Tasks are ordered by severity: critical (1), high (2), medium (3), low (4), with ties broken by age. The queue is the agent's work list.

### Agent interface

An agent calls `GET /agent/next-action` to claim the highest-priority pending task. The claim is atomic — it happens inside a SQLite `BEGIN IMMEDIATE` transaction, so two agents calling simultaneously cannot claim the same task.

The claim expires after 300 seconds. If the agent doesn't respond in time, the task reverts to pending and any agent can claim it again.

The agent calls `POST /agent/tasks/:id/complete` or `POST /agent/tasks/:id/skip` when it's done. Only the agent that claimed a task can complete or skip it.

### Access control

Two files control what can be discovered and what the agent can see:

- **`.botignore`** — gitignore-style deny patterns. Matched items are excluded from scans and never stored.
- **`.botinclude`** — explicit allow patterns. Items must match at least one allow rule or they are denied by default.

The precedence order is: auto-deny sensitive patterns → `.botignore` deny → `.botinclude` allow → default deny.

Use `GET /api/access/preview?target=/path&domain=file` to test how a given target would be evaluated before running a scan.

---

## Built-in rules

Five rules ship with Substrate:

| Rule ID | Severity | What it detects |
|---|---|---|
| `container-exited-unexpectedly` | critical | Any container in `exited` state |
| `docker-socket-exposed` | high | Any container exposing port 2375 or 2376 to the host |
| `exposed-env-file` | high | Any `.env` file explicitly allowed (visible to the agent) |
| `no-scan-data` | medium | Scan returns zero services and zero config files |
| `stopped-container` | low | Any container in `stopped` state |

All built-in rules can be disabled via `PUT /api/rules/:id`. Their logic cannot be modified — add a plugin rule instead.

---

## Use cases

### Autonomous infrastructure monitoring on a self-hosted VPS

You run a small stack on a VPS — Postgres, Redis, Nginx, a backend API. You want an agent that checks on the stack periodically and fixes simple problems without waking you up.

Substrate scans the stack every 5 minutes. When the Postgres container exits unexpectedly, it becomes a critical task in the queue. Your agent claims it, reads the reasoning ("container-exited-unexpectedly fired on snapshot v14"), checks container logs via its own tooling, restarts the container, and marks the task complete. Substrate records the whole sequence in the state event log. You see it in the timeline in the morning.

The agent never had shell access. It was told what was wrong, it acted, and it reported back.

---

### Claude Code as an infrastructure-aware development assistant

You're building a service locally. You have a `docker-compose.yml` with eight containers. You add Substrate as an MCP server in your Claude Code config. Now Claude can call `substrate_scan` and `substrate_get_findings` directly from the conversation.

When you say "why isn't my API talking to Redis?", Claude scans the system, checks the graph, and tells you that the Redis container exited 10 minutes ago — not because it hallucinated it, but because Substrate's scanner confirmed the container status from the Docker daemon.

You haven't given Claude shell access. It can only see what Substrate allows.

---

### Multi-agent bot coordination on a Mac Mini

You're running several bots on a Mac Mini — a deployment bot, a log-watching bot, and a reporting bot. All three connect to Substrate using the same agent key but different `X-Agent-Id` values (`deployment-bot`, `log-watcher`, `reporter`).

Substrate's task queue handles coordination automatically. When a critical finding appears, one bot claims it. The others get a 204 ("no tasks") and back off. There's no shared state, no Pub/Sub, no coordination logic in the bots themselves. Substrate is the single source of truth.

If the deployment bot crashes mid-task, the 300-second TTL expires, and the task reverts to pending. Any other bot can pick it up. The event log shows exactly what happened and when.

---

### Enforcing least-privilege access for a coding agent

You're running a coding agent that can read your project directory. You don't want it to see your production `.env`, your SSH keys, or anything outside the project.

Your `.botignore`:
```
# Block the whole home directory by default
/home/**

# Block all env files everywhere
*.env
.env.*

# Block SSH and secrets directories
**/.ssh/**
**/secrets/**
service:prod-*
```

Your `.botinclude`:
```
# Allow only the project directory
/home/user/my-project/**

# Allow specific dev services
service:dev-postgres
service:dev-redis
```

Now the agent's context is scoped to exactly what it needs. Use `GET /api/access/preview` to verify any path before running a scan.

---

### Custom rules for your specific stack

You run a Node.js app and want to know when its container hasn't been rebuilt since a dependency change. Drop a plugin rule in `plugins/rules/`:

```js
// plugins/rules/node-app-rules.js
module.exports = [
  {
    id: 'node-app-not-running',
    name: 'Node App Container Not Running',
    description: 'The primary Node.js application container is not in a running state.',
    severity: 'high',
    condition_source: `
      return graphData.services &&
        graphData.services.some(s => s.name === 'my-node-app' && s.status !== 'running');
    `,
    recommended_action: 'Check container logs and restart. Run: docker compose logs my-node-app',
  },
  {
    id: 'no-dev-database-in-prod',
    name: 'Development Database Container Detected',
    description: 'A container named "dev-db" or "test-db" is running, which should not be present in production.',
    severity: 'critical',
    condition_source: `
      return graphData.services &&
        graphData.services.some(s => s.name.startsWith('dev-db') || s.name.startsWith('test-db'));
    `,
    recommended_action: 'Stop and remove development database containers before deploying to production.',
  },
];
```

Restart Substrate. The rules are registered automatically. The next scan evaluates them alongside the built-ins.

---

## Installation

**Requirements:** Docker, docker-compose, git.

```bash
git clone https://github.com/kokodapak/Substrate.git
cd Substrate
cp .env.example .env
```

Generate two API keys — one for admin access (you and your dashboard), one for agents:

```bash
openssl rand -hex 32  # run this twice
```

Edit `.env`:

```env
SUBSTRATE_ADMIN_KEY=<first key>
SUBSTRATE_AGENT_KEY=<second key>
DATABASE_URL=file:./data/substrate.db
NODE_ENV=production
PORT=3000
DOCKER_SOCKET_PATH=/var/run/docker.sock
# SENTRY_DSN=https://...  (optional — error tracking)
```

The admin key grants full access to every endpoint. The agent key is what you configure in your bots — it can claim tasks and read context, but cannot modify rules or access control. Keep both keys out of version control.

```bash
docker-compose up -d
curl http://localhost:3000/health
```

Open `http://localhost:3000` for the dashboard.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SUBSTRATE_ADMIN_KEY` | yes | — | Full access. Use for the dashboard and direct API calls. |
| `SUBSTRATE_AGENT_KEY` | yes | — | Agent access. Share with bots and autonomous agents. |
| `DATABASE_URL` | yes | — | SQLite path. Use `file:./data/substrate.db`. |
| `NODE_ENV` | yes | — | `production` or `development`. |
| `PORT` | yes | — | Port the server listens on. |
| `DOCKER_SOCKET_PATH` | no | `/var/run/docker.sock` | Docker daemon socket path. |
| `SENTRY_DSN` | no | disabled | Sentry DSN. Silently disabled if not set. |
| `SUBSTRATE_PLUGINS_DIR` | no | `plugins/rules` | Directory scanned for plugin rule `.js` files at startup. |

---

## MCP integration

Substrate ships a standalone MCP server. Once configured, Claude Code and Cursor can call Substrate tools directly in conversation — no manual HTTP calls, no copy-pasting output.

Add to `~/.mcp.json` (global) or `.mcp.json` in your project:

```json
{
  "substrate": {
    "command": "node",
    "args": ["/path/to/substrate/dist/mcp/index.js"],
    "env": {
      "SUBSTRATE_URL": "http://localhost:3000",
      "SUBSTRATE_ADMIN_KEY": "your-admin-key"
    }
  }
}
```

Available tools:

| Tool | What it does |
|---|---|
| `substrate_scan` | Trigger a scan and return the summary |
| `substrate_get_graph` | Get the full current knowledge graph |
| `substrate_get_findings` | Get findings, optionally filtered by severity or status |
| `substrate_get_context` | Get the agent-oriented system summary |
| `substrate_get_next_action` | Claim the next pending task for a given agent ID |
| `substrate_complete_task` | Mark a task as done |
| `substrate_get_timeline` | Query the state event log |

---

## API reference

All endpoints require `X-Api-Key`. Admin endpoints require `SUBSTRATE_ADMIN_KEY`. Agent endpoints accept either key and additionally require `X-Agent-Id` (an arbitrary string identifying the agent instance, e.g. `"deployment-bot-1"`).

### Scanner

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/scan` | admin | Run a full scan. Synchronous. Rate limited to 1 per 10 seconds. |
| `GET` | `/api/services` | admin | All services from the latest snapshot. |
| `GET` | `/api/files` | admin | All config files from the latest snapshot with allow/block status. |

### Knowledge graph

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/graph` | admin | Full current graph snapshot. 404 if no scan has run yet. |
| `GET` | `/api/graph/diff` | admin | Structural diff between two snapshot versions. Params: `from` (required), `to` (defaults to latest). |

### Rules and findings

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/rules` | admin | All rules. Does not include `condition_source` in the response. |
| `PUT` | `/api/rules/:id` | admin | Update a rule. Built-in rules can only toggle `enabled`. |
| `GET` | `/api/findings` | admin | Findings from the latest snapshot. Filterable by `severity` and `status`. |
| `GET` | `/api/rules/plugins` | admin | Plugin rule files discovered at startup and their load status. |

### Access control

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/access` | admin | Current rules and per-domain summary. |
| `PUT` | `/api/access/botignore` | admin | Replace `.botignore` rules atomically. Returns `{ parsed_rules, blocked_nodes }`. |
| `PUT` | `/api/access/botinclude` | admin | Replace `.botinclude` rules atomically. Returns `{ parsed_rules, allowed_nodes }`. |
| `GET` | `/api/access/preview` | admin | Dry-run rules against a target. Params: `target`, `domain`. |

### Agent interface

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/agent/next-action` | agent | Claim the next task. 204 if none available. Rate limited to 10/sec per agent. |
| `GET` | `/agent/context` | agent | Current system state summary scoped to what the agent is allowed to see. |
| `POST` | `/agent/tasks/:id/complete` | agent | Complete a claimed task. Only the claiming agent can call this. |
| `POST` | `/agent/tasks/:id/skip` | agent | Skip a claimed task. Only the claiming agent can call this. |

### State and health

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/state` | admin | Current state summary and last 50 events. 404 before first scan. |
| `GET` | `/api/timeline` | admin | Paginated event log. Params: `domain`, `event_type`, `since`, `until`, `limit` (max 200), `offset`. |
| `GET` | `/health` | none | Server status, version, uptime, and DB check. Always 200. |

---

## Dashboard

The dashboard is a React SPA served from the same server at `/`. Enter your admin key on first load — it's stored in `localStorage` and sent with every API request.

**Five screens:**

- **Overview** — service cards with live status, recent findings by severity, and a Trigger Scan button
- **Remediation Queue** — all findings sorted by severity, with severity and status filters
- **Access Control** — inline editors for `.botignore` and `.botinclude`, plus a live access preview tool
- **Timeline** — the full state event log with domain and event type filters and pagination
- **Settings** — change your API key, enable or disable individual rules

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                 Substrate Server                 │
│  Express.js + TypeScript                         │
│                                                  │
│   ┌─────────────┐      ┌─────────────┐           │
│   │  Admin API  │      │  Agent API  │           │
│   │   /api/*    │      │  /agent/*   │           │
│   └──────┬──────┘      └──────┬──────┘           │
│          │                   │                   │
│   ┌──────▼───────────────────▼──────┐            │
│   │         SQLite + Drizzle ORM    │            │
│   │  graph_snapshots  graph_nodes   │            │
│   │  services         files_configs │            │
│   │  rules            findings      │            │
│   │  tasks            state_events  │            │
│   │  access_rules     state_snapshots            │
│   └─────────────────────────────────┘            │
│                                                  │
│   ┌─────────────┐   ┌──────────────┐             │
│   │   Scanner   │   │ Rule Engine  │             │
│   │  (dockerode)│   │  (node:vm)   │             │
│   └─────────────┘   └──────────────┘             │
│                                                  │
│   React + Vite + Tailwind (served at /)          │
└──────────────────────────────────────────────────┘
                       │
       ┌───────────────┴──────────────┐
       │         MCP Server           │
       │  node dist/mcp/index.js      │
       │  (stdio transport)           │
       └──────────────────────────────┘
```

**What happens during a scan:**

```
POST /api/scan
  → rate limit check
  → dockerode: list all containers (name, image, status, ports, env key names)
  → fs: scan working directory for .env, docker-compose.yml, package.json
  → evaluate each item against access_rules (deny-first)
  → begin SQLite transaction:
      insert graph_snapshots (version + 1)
      insert graph_nodes (one per allowed item)
      evaluate all enabled rules via node:vm (1000ms timeout each)
      insert findings (INSERT OR IGNORE — idempotent per rule+snapshot)
      insert tasks (INSERT OR IGNORE — one task per finding)
      append state_events record (scan.completed)
  → commit
  → return { snapshot_version, services_discovered, files_discovered,
             findings_produced, tasks_promoted, duration_ms }
```

---

## Development

```bash
npm install
cp .env.example .env   # fill in SUBSTRATE_ADMIN_KEY, SUBSTRATE_AGENT_KEY, DATABASE_URL, NODE_ENV, PORT
npm run dev            # tsx watch — restarts on file changes

# Frontend (separate terminal)
cd client && npm install && npm run dev   # Vite at :5173, proxies /api and /agent to :3000

# Tests and build
npm test               # 147 tests across 11 test files
npm run build          # TypeScript compile check
```

---

## License

MIT. Self-host it. Fork it. Build on it.
