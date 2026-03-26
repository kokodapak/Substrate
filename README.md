# Substrate

**A deterministic runtime environment for AI agents.**

Substrate creates a structured, machine-queryable model of your local system — Docker containers, config files, running processes, and workflows — and exposes a minimal API that tells agents exactly what to do next, with full user control over what the agent can and cannot see.

---

## Why Substrate exists

AI agents running locally have no reliable source of truth for system state. They either hallucinate context ("I think your Redis container is running") or are given unrestricted shell access and left to figure it out. Both are bad.

Substrate is the authoritative, deny-first, inspectable layer between the agent and the system. It answers the question every agent needs answered before it acts:

> **What is actually running, what is broken, and what should I do about it?**

Agents get structured, filtered, deterministic answers. They cannot see what they are not allowed to see. Everything they receive is traceable back to a persisted, versioned snapshot.

---

## Key design principles

- **Deny-first.** Nothing is exposed by default. You explicitly allow what the agent can see via `.botinclude`.
- **Deterministic.** The same scan on the same system always produces the same graph. Rules evaluated against the same snapshot always produce the same findings.
- **No LLM reasoning.** Every fact the agent receives is derived from real system state, not inferred. Rules are pure JavaScript functions, not prompts.
- **No automatic execution.** Substrate tells the agent what to do. It never does it for them. The agent acts; Substrate observes and reports.
- **Append-only state log.** Every scan, claim, completion, and skip is recorded. Nothing is overwritten.
- **Local first.** No cloud dependency. No external auth provider. Runs on a Mac Mini, VPS, or any Docker environment.

---

## How it works

### 1. Scan

`POST /api/scan` triggers a synchronous read-only scan of the local system:

- **Docker containers** — name, image, status, exposed ports, env var key names (never values)
- **Config files** — `.env` patterns, `docker-compose.yml`, `package.json` within the working directory

Every discovered item is evaluated against your `.botignore` and `.botinclude` rules before it is stored. Items that fail access control are excluded entirely and never persisted.

Sensitive env var key names containing `SECRET`, `KEY`, `TOKEN`, `PASSWORD`, or `CREDENTIAL` are always denied, regardless of any allow rules.

### 2. Knowledge graph

Every scan produces a versioned **graph snapshot**. The graph is immutable once written. Each snapshot has:

- An incrementing integer `version` (1, 2, 3…)
- A full JSON blob of all discovered services and config files
- Individual `graph_nodes` for fast querying and diffing

The diff API (`GET /api/graph/diff?from=1&to=3`) computes exactly what changed between any two snapshots — added nodes, removed nodes, and modified nodes — using stable `node_key` identifiers (`"services:my-container"`, `"files_configs:/app/.env"`).

### 3. Rule engine

Rules are evaluated against each snapshot deterministically. Each rule is a JavaScript function body executed in a sandboxed `node:vm` context with a 1000ms timeout and no access to `require`, `process`, `global`, or `fs`.

```js
// Example rule: container-exited-unexpectedly
return graphData.services && graphData.services.some(s => s.status === 'exited');
```

Five built-in rules ship with Substrate:

| Rule | Severity | Trigger |
|---|---|---|
| `container-exited-unexpectedly` | critical | Any container with status `exited` |
| `docker-socket-exposed` | high | Any container exposing host port 2375 or 2376 |
| `exposed-env-file` | high | Any `.env` file marked as explicitly allowed |
| `no-scan-data` | medium | Scan returns zero services and zero files |
| `stopped-container` | low | Any container with status `stopped` |

Each finding is unique per `(rule_id, snapshot_id)` — re-running the same rule against the same snapshot is idempotent.

### 4. Task queue

Every open finding is promoted to a task in the agent queue (`INSERT OR IGNORE`). Tasks are prioritised by severity (critical=1, high=2, medium=3, low=4) and break ties by age.

### 5. Agent interface

The agent claims the highest-priority pending task atomically via `GET /agent/next-action`. The claim is a SQLite `BEGIN IMMEDIATE` transaction — no two agents can claim the same task simultaneously.

Claimed tasks have a 300-second TTL. If the agent does not complete or skip within the window, the task reverts to pending automatically on the next `GET /agent/next-action` call, and any agent can claim it again.

Only the claiming agent (matched by `X-Agent-Id`) can complete or skip a task it holds.

### 6. Access control

Two files control what the agent and scanner can see:

- **`.botignore`** — deny rules. Same gitignore syntax. Anything matched is excluded from scans and agent context.
- **`.botinclude`** — allow rules. Anything matched is explicitly permitted.

Precedence (highest to lowest):

1. Auto-deny sensitive env key patterns (hardcoded, cannot be overridden)
2. `.botignore` deny rules
3. `.botinclude` allow rules
4. Default deny — everything not explicitly allowed is blocked

Use `GET /api/access/preview?target=/etc/secrets&domain=file` to dry-run the current rules against any target before a scan.

---

## API reference

All endpoints require `X-Api-Key` header. Admin endpoints require `SUBSTRATE_ADMIN_KEY`. Agent endpoints accept either key and additionally require `X-Agent-Id`.

### System Scanner

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/scan` | admin | Trigger a synchronous full scan. Rate limited to 1 per 10 seconds. Returns scan summary. |
| `GET` | `/api/services` | admin | List all services from the latest snapshot. |
| `GET` | `/api/files` | admin | List all config files from the latest snapshot with allow/block status. |

`POST /api/scan` response:
```json
{
  "snapshot_version": 3,
  "services_discovered": 12,
  "files_discovered": 4,
  "findings_produced": 2,
  "tasks_promoted": 2,
  "duration_ms": 341
}
```

### Knowledge Graph

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/graph` | admin | Return the full current graph snapshot as structured JSON. 404 if no scan has run. |
| `GET` | `/api/graph/diff` | admin | Structured diff between two snapshot versions. Query params: `from` (required), `to` (optional, defaults to latest). |

`GET /api/graph/diff?from=1&to=3` response:
```json
{
  "from": 1,
  "to": 3,
  "domains": {
    "services": {
      "added": ["services:new-worker"],
      "removed": ["services:old-api"],
      "modified": [
        {
          "node_key": "services:postgres",
          "before": { "status": "running", "ports": [] },
          "after": { "status": "running", "ports": [{"host_port": 5432, "container_port": 5432, "protocol": "tcp"}] }
        }
      ]
    }
  }
}
```

### Rule Engine

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/rules` | admin | List all rules. Does not return `condition_source`. |
| `PUT` | `/api/rules/:id` | admin | Update a rule. Built-in rules can only toggle `enabled`. Custom rules are fully mutable. |
| `GET` | `/api/findings` | admin | List findings from the latest snapshot. Filterable by `severity` and `status`. |
| `GET` | `/api/rules/plugins` | admin | List discovered plugin rule files and their load status. |

### Access Control

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/access` | admin | List current botignore/botinclude rules with per-domain summary counts. |
| `PUT` | `/api/access/botignore` | admin | Replace `.botignore` content. Parses, replaces all deny rules atomically, re-evaluates current graph. |
| `PUT` | `/api/access/botinclude` | admin | Replace `.botinclude` content. Same semantics. |
| `GET` | `/api/access/preview` | admin | Dry-run current rules against a target. Query params: `target`, `domain`. |

### Agent Interface

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/agent/next-action` | agent | Atomically claim the highest-priority pending task. Returns 204 if none available. Rate limited 10/sec per agent. |
| `GET` | `/agent/context` | agent | Scoped system state summary for agent orientation. |
| `POST` | `/agent/tasks/:id/complete` | agent | Mark a claimed task done. Only the claiming agent may call this. |
| `POST` | `/agent/tasks/:id/skip` | agent | Mark a claimed task skipped. Only the claiming agent may call this. |

`GET /agent/next-action` response:
```json
{
  "task": {
    "id": "uuid",
    "title": "Container Exited Unexpectedly",
    "priority": 1,
    "reasoning": "Rule \"container-exited-unexpectedly\" fired on snapshot v4: Detects containers that have exited...",
    "context": { "snapshot_version": 4, "finding_detail": "..." },
    "lock_expires_at": "2026-03-26T20:05:00.000Z"
  }
}
```

### State Engine

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/state` | admin | Current system state summary plus last 50 state events. 404 if no scan has run. |
| `GET` | `/api/timeline` | admin | Paginated, filterable event log. Params: `domain`, `event_type`, `since`, `until`, `limit` (max 200), `offset`. |

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Returns server status, version, uptime, and live DB check. Always returns 200. |

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_s": 3842,
  "db": "ok"
}
```

---

## MCP integration

Substrate ships an MCP (Model Context Protocol) server, making it directly usable as a tool by Claude Code, Cursor, and any other MCP-compatible client — no raw HTTP calls needed.

### Configure in Claude Code

Add to your `~/.claude/mcp.json` (or `.mcp.json` in your project):

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

### Available MCP tools

| Tool | Description |
|---|---|
| `substrate_scan` | Trigger a full system scan |
| `substrate_get_graph` | Get the current knowledge graph snapshot |
| `substrate_get_findings` | Get findings, optionally filtered by severity or status |
| `substrate_get_context` | Get agent-oriented system state summary |
| `substrate_get_next_action` | Claim the next pending task for a given agent ID |
| `substrate_complete_task` | Mark a claimed task as done |
| `substrate_get_timeline` | Query the state event log |

---

## Plugin rules

Drop a `.js` file into `plugins/rules/` and Substrate loads it at startup alongside the built-in rules.

```js
// plugins/rules/my-rules.js
module.exports = [
  {
    id: 'no-unnamed-containers',
    name: 'Unnamed Container Detected',
    description: 'Containers without explicit names are harder to manage and monitor.',
    severity: 'low',
    condition_source: `return graphData.services && graphData.services.some(s => s.name.startsWith('/'));`,
    recommended_action: 'Add a explicit name to the container in your docker-compose.yml.',
  },
];
```

Plugin rules are inserted with `built_in=0`, making them fully mutable via `PUT /api/rules/:id`. Use `GET /api/rules/plugins` to see which files were found and whether they loaded successfully.

Domain prefix support in plugin rule IDs: prefix with `service:`, `env:`, `file:`, or `integration:` in your `.botignore` to scope deny rules to specific domains.

---

## Access control reference

### `.botignore` — deny rules

```
# Deny all files under /etc
/etc/**

# Deny a specific service by name
service:redis-prod

# Deny a specific env var key from appearing in agent context
env:DATABASE_URL

# Wildcard: deny any service with "staging" in its name
service:*staging*
```

### `.botinclude` — allow rules

```
# Allow the app directory
/app/**

# Allow a specific service
service:my-api

# Allow package.json files anywhere
**/package.json
```

Sensitive patterns (`SECRET`, `KEY`, `TOKEN`, `PASSWORD`, `CREDENTIAL` in env key names) are always denied regardless of `.botinclude`. There is no way to override this.

---

## Installation

### Requirements

- Docker and docker-compose
- Git

### Quick start

```bash
git clone https://github.com/kokodapak/Substrate.git
cd Substrate
cp .env.example .env
```

Edit `.env`:

```env
SUBSTRATE_ADMIN_KEY=your-secure-admin-key-here
SUBSTRATE_AGENT_KEY=your-secure-agent-key-here
DATABASE_URL=file:./data/substrate.db
NODE_ENV=production
PORT=3000
DOCKER_SOCKET_PATH=/var/run/docker.sock
# SENTRY_DSN=https://... (optional)
```

```bash
docker-compose up -d
curl http://localhost:3000/health
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SUBSTRATE_ADMIN_KEY` | yes | — | Full access key. Treat as a secret. |
| `SUBSTRATE_AGENT_KEY` | yes | — | Agent read-only key. Treat as a secret. |
| `DATABASE_URL` | yes | — | SQLite file path. Use `file:./data/substrate.db`. |
| `NODE_ENV` | yes | — | `production` or `development`. |
| `PORT` | yes | — | Port the server listens on. |
| `DOCKER_SOCKET_PATH` | no | `/var/run/docker.sock` | Path to Docker daemon socket. |
| `SENTRY_DSN` | no | disabled | Sentry DSN for error tracking. Silently disabled if absent. |
| `SUBSTRATE_PLUGINS_DIR` | no | `plugins/rules` | Directory to scan for plugin rule `.js` files. |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Substrate Server                 │
│                                                     │
│  Express.js + TypeScript                            │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │  Admin API   │  │  Agent API   │                 │
│  │  /api/*      │  │  /agent/*    │                 │
│  └──────┬───────┘  └──────┬───────┘                 │
│         │                 │                         │
│  ┌──────▼─────────────────▼───────┐                 │
│  │           SQLite (better-sqlite3)               │
│  │  Drizzle ORM + migrations      │                 │
│  │                                │                 │
│  │  graph_snapshots   rules       │                 │
│  │  graph_nodes       findings    │                 │
│  │  services          tasks       │                 │
│  │  files_configs     state_events│                 │
│  │  access_rules      state_snapshots              │
│  └────────────────────────────────┘                 │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐                  │
│  │   Scanner   │  │ Rule Engine  │                  │
│  │  (dockerode)│  │  (node:vm)   │                  │
│  └─────────────┘  └──────────────┘                  │
│                                                     │
│  React SPA (Vite + Tailwind) served at /            │
└─────────────────────────────────────────────────────┘
                          │
          ┌───────────────┴──────────────┐
          │         MCP Server           │
          │  node dist/mcp/index.js      │
          │  (stdio — Claude Code/Cursor)│
          └──────────────────────────────┘
```

**Request flow for `POST /api/scan`:**

```
POST /api/scan
  → rate limit check (1/10s)
  → dockerode: list all containers
  → fs: scan CWD for config files
  → access_rules: filter every discovered item (deny-first)
  → SQLite transaction:
      INSERT graph_snapshots (version = MAX + 1)
      INSERT graph_nodes (one per allowed item)
      evaluate all enabled rules via node:vm
      INSERT OR IGNORE findings
      INSERT OR IGNORE tasks (priority by severity)
      APPEND state_events (scan.completed)
  → return summary
```

---

## Dashboard

Substrate includes a minimal React dashboard served from the same server at `/`.

**Five screens:**

- **Overview** — live system map with service cards, recent findings, and a "Trigger Scan" button
- **Remediation Queue** — all findings sorted by severity with status filters
- **Access Control** — inline `.botignore` and `.botinclude` editors plus a live access preview tool
- **Timeline** — paginated, filterable state event log
- **Settings** — API key management and per-rule enable/disable toggles

The dashboard reads your admin key from `localStorage`. Enter it on first load.

---

## Development

```bash
npm install
cp .env.example .env  # fill in values
npm run dev           # starts server with tsx watch

# Frontend
cd client
npm install
npm run dev           # Vite dev server at :5173 (proxies /api and /agent to :3000)

# Tests
npm test              # 147 tests
npm run build         # tsc compile check
```

### Adding a plugin rule (development)

```bash
mkdir -p plugins/rules
cat > plugins/rules/my-rules.js << 'EOF'
module.exports = [
  {
    id: 'my-custom-rule',
    name: 'My Custom Rule',
    description: 'Describe what this detects.',
    severity: 'medium',
    condition_source: `return graphData.services && graphData.services.length > 10;`,
    recommended_action: 'Review whether all services are necessary.',
  },
];
EOF
npm run dev  # rules are loaded at startup
```

---

## License

MIT. Self-host it. Fork it. Build on it.
